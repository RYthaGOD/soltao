// Resumable free-TAO return: derived Bittensor coldkey -> derived EVM transit -> canonical Solana TAO.
// This module is intentionally not imported by app.js yet. The production direction toggle stays disabled
// until this route has passed a small real-funds round trip.

import { CONFIG } from "./config.js";
import { evmAddress, ss58Encode } from "./derive.js";
import { getBalance, getGasPrice, rpc, sendTx } from "./evm.js";
import { encode, getWtao, mirrorColdkey } from "./bittensor.js";
import { coldkeyPair, quoteTransfer, transfer } from "./substrate.js";
import { RETURN_GAS_LIMIT, WEI_PER_RAO, encodeOftSend, planReturnFunding, quoteReturn } from "./oft_return.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ceilDiv = (value, divisor) => (BigInt(value) + BigInt(divisor) - 1n) / BigInt(divisor);

const realOps = {
  signerAddress: (mnemonic) => coldkeyPair(mnemonic).address,
  transitAddress: evmAddress,
  mirrorAddress: async (address) => ss58Encode(await mirrorColdkey(address)),
  state: async (address) => {
    const [nativeWei, wtaoWei] = await Promise.all([getBalance(address), getWtao(address)]);
    return { nativeWei, wtaoWei };
  },
  gasPrice: getGasPrice,
  quoteBridge: ({ amountRao, solanaRecipient }) => quoteReturn({ amountRao, solanaRecipient }),
  quoteFunding: (mnemonic, to, amountRao) => quoteTransfer(mnemonic, to, amountRao),
  fund: (mnemonic, to, amountRao) => transfer(mnemonic, to, amountRao),
  wrap: (transitKey, amountWei, gasPriceWei) => sendTx(transitKey, {
    to: CONFIG.wtao, data: encode("deposit()"), value: amountWei,
    gasLimit: RETURN_GAS_LIMIT.wrap, gasPrice: gasPriceWei,
  }),
  send: (transitKey, { solanaRecipient, amountWei, nativeFeeWei, gasPriceWei, onBroadcast }) => {
    const refundAddress = evmAddress(transitKey);
    return sendTx(transitKey, {
      to: CONFIG.wtao,
      data: encodeOftSend({ to: solanaRecipient, amountLd: amountWei, nativeFee: nativeFeeWei, refundAddress }),
      value: nativeFeeWei, gasLimit: RETURN_GAS_LIMIT.send, gasPrice: gasPriceWei,
    }, { onBroadcast });
  },
  receipt: async (hash) => {
    const value = await rpc("eth_getTransactionReceipt", [hash]);
    return value ? { status: value.status, gasUsed: BigInt(value.gasUsed) } : null;
  },
};

async function waitForFunding(ops, address, minimumWei, { waitMs, pollMs }) {
  const start = Date.now();
  for (;;) {
    const state = await ops.state(address);
    if (state.nativeWei >= minimumWei) return state;
    if (Date.now() - start >= waitMs) throw new Error("coldkey transfer was included but has not appeared on the EVM mirror yet");
    await sleep(pollMs);
  }
}

/**
 * Continue a free-balance return from chain state. `progress` is non-secret checkpoint data saved by
 * the caller. `onCheckpoint` must persist it synchronously; most importantly it records the EVM send
 * hash immediately after broadcast, before receipt polling.
 */
export async function finishFreeReturn({
  mnemonic, transitKey, solanaRecipient, amountRao, expectedColdkey = null, progress = {},
  onStep = () => {}, onCheckpoint = () => {}, waitMs = 2 * 60_000, pollMs = 4_000, ops = realOps,
}) {
  const coldkey = ops.signerAddress(mnemonic);
  if (expectedColdkey && coldkey !== expectedColdkey) throw new Error("the return signer does not match the expected derived coldkey");
  const transitAddress = ops.transitAddress(transitKey);
  const mirrorAddress = await ops.mirrorAddress(transitAddress);

  // If the page closed after the OFT transaction broadcast, never send a second one. Its hash is
  // enough to recover safely from chain state.
  if (progress.sendHash) {
    const receipt = await ops.receipt(progress.sendHash);
    if (!receipt) {
      onStep("bridge", "busy", "return transaction is still pending on Bittensor");
      return { pending: true, sendHash: progress.sendHash, coldkey, transitAddress, mirrorAddress };
    }
    if (receipt.status !== "0x1") throw new Error(`return transaction ${progress.sendHash} reverted`);
    const done = { stage: "sent", sendHash: progress.sendHash };
    onCheckpoint(done);
    onStep("bridge", "ok", "sent to Solana through LayerZero");
    return { ...done, coldkey, transitAddress, mirrorAddress };
  }

  let quote = await ops.quoteBridge({ amountRao, solanaRecipient });
  if (quote.lzTokenFee !== 0n) throw new Error("the canonical bridge unexpectedly requires an LZ-token fee");
  const amountWei = quote.amountWei;
  const cleanAmountRao = quote.amountRao;
  let gasPriceWei = await ops.gasPrice();
  let state = await ops.state(transitAddress);

  const ensureFunding = async (minimumNativeWei) => {
    state = await ops.state(transitAddress);
    if (state.nativeWei >= minimumNativeWei) return;
    const fundingRao = ceilDiv(minimumNativeWei - state.nativeWei, WEI_PER_RAO);
    const fundingQuote = await ops.quoteFunding(mnemonic, mirrorAddress, fundingRao);
    if (fundingQuote.address !== coldkey) throw new Error("the funding quote used a different coldkey");
    if (fundingQuote.remainingRao < 0n) throw new Error("not enough free TAO for the return amount and network fees");
    onStep("transfer", "busy", `funding transit with ${fundingRao} rao`);
    onCheckpoint({ stage: "funding", fundingRao: String(fundingRao), to: mirrorAddress });
    const hash = await ops.fund(mnemonic, mirrorAddress, fundingRao);
    onCheckpoint({ stage: "funded", fundingRao: String(fundingRao), fundingHash: hash, to: mirrorAddress });
    state = await waitForFunding(ops, transitAddress, minimumNativeWei, { waitMs, pollMs });
    onStep("transfer", "ok", "TAO arrived on the transit account");
  };

  // Reuse any wTAO already present from an interrupted attempt; only wrap the missing amount.
  let plan = planReturnFunding({
    amountRao: cleanAmountRao, nativeFeeWei: quote.nativeFee, gasPriceWei,
    transitNativeWei: state.nativeWei, transitWtaoWei: state.wtaoWei,
  });
  await ensureFunding(plan.requiredNativeWei);
  state = await ops.state(transitAddress);
  const wrapWei = amountWei > state.wtaoWei ? amountWei - state.wtaoWei : 0n;
  if (wrapWei > 0n) {
    onStep("wrap", "busy", "wrapping native TAO to canonical wTAO");
    onCheckpoint({ stage: "wrapping", amountWei: String(wrapWei) });
    const wrapped = await ops.wrap(transitKey, wrapWei, gasPriceWei);
    onCheckpoint({ stage: "wrapped", amountWei: String(wrapWei), wrapHash: wrapped.hash });
    state = await ops.state(transitAddress);
    if (state.wtaoWei < amountWei) throw new Error("the wrap transaction landed but the expected wTAO is not present");
    onStep("wrap", "ok", "wTAO ready for LayerZero");
  }

  // Re-quote immediately before sending. A higher fee or gas price receives a precise top-up rather
  // than causing a revert after the user's TAO has already been wrapped.
  quote = await ops.quoteBridge({ amountRao: cleanAmountRao, solanaRecipient });
  if (quote.amountWei !== amountWei || quote.lzTokenFee !== 0n) throw new Error("the canonical return quote changed shape while preparing the route");
  gasPriceWei = await ops.gasPrice();
  const sendRequirement = quote.nativeFee + RETURN_GAS_LIMIT.send * gasPriceWei;
  await ensureFunding(sendRequirement);

  onStep("bridge", "busy", "sending canonical TAO to Solana");
  const sent = await ops.send(transitKey, {
    solanaRecipient, amountWei, nativeFeeWei: quote.nativeFee, gasPriceWei,
    onBroadcast: ({ hash, nonce }) => onCheckpoint({ stage: "send-broadcast", sendHash: hash, nonce: String(nonce), amountWei: String(amountWei) }),
  });
  const done = { stage: "sent", sendHash: sent.hash, amountRao: cleanAmountRao, solanaAmountLd: quote.solanaAmountLd };
  onCheckpoint({ ...done, amountRao: String(cleanAmountRao), solanaAmountLd: String(quote.solanaAmountLd) });
  onStep("bridge", "ok", "sent to Solana through LayerZero");
  return { ...done, coldkey, transitAddress, mirrorAddress };
}
