// Resumable free-TAO return: derived Bittensor coldkey -> derived EVM transit -> canonical Solana TAO.
// This module is intentionally not imported by app.js yet. The production direction toggle stays disabled
// until this route has passed a small real-funds round trip.
//
// Every mutation (the coldkey funding transfer, the wrap, the OFT send) goes through the same three
// steps: sign it without sending, hand its identity and signed bytes to `onCheckpoint` (which must
// persist synchronously), then broadcast. A resume therefore always knows the exact transaction that
// may be in flight, and reconciles it before doing anything new:
//
//   included / mined   done: carry on from chain state
//   still pending      re-broadcast the identical bytes (never a second, different transaction)
//   dead               its nonce was used by something else or it expired: it can never land, so
//                      fresh chain state decides what is still missing
//
// That closes the window where the page closes after a broadcast but before inclusion, and the one
// where an RPC accepts a transaction but its reply is lost.

import { CONFIG } from "./config.js";
import { evmAddress, ss58Encode } from "./derive.js";
import { broadcast, getBalance, getGasPrice, signTx, txStatus, waitMined } from "./evm.js";
import { encode, getWtao, mirrorColdkey } from "./bittensor.js";
import { accountNonce, coldkeyPair, prepareTransfer, quoteTransfer, submitSigned } from "./substrate.js";
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
  prepareFund: (mnemonic, to, amountRao) => prepareTransfer(mnemonic, to, amountRao),
  submitFund: (signed) => submitSigned(signed),
  coldkeyNonce: (address) => accountNonce(address),
  signWrap: (transitKey, amountWei, gasPriceWei) => signTx(transitKey, {
    to: CONFIG.wtao, data: encode("deposit()"), value: amountWei, gasLimit: RETURN_GAS_LIMIT.wrap, gasPrice: gasPriceWei,
  }),
  signSend: (transitKey, { solanaRecipient, amountWei, nativeFeeWei, gasPriceWei }) => signTx(transitKey, {
    to: CONFIG.wtao,
    data: encodeOftSend({ to: solanaRecipient, amountLd: amountWei, nativeFee: nativeFeeWei, refundAddress: evmAddress(transitKey) }),
    value: nativeFeeWei, gasLimit: RETURN_GAS_LIMIT.send, gasPrice: gasPriceWei,
  }),
  broadcast,
  evmStatus: txStatus,
  waitMined: (hash, opts) => waitMined(hash, opts),
};

const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));

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
 * Continue a free-balance return from chain state. `progress` is the last checkpoint the caller saved
 * (non-secret: identities and signed bytes of transactions that are, or are about to be, public).
 * `onCheckpoint(progress)` must persist it synchronously; it is called before every broadcast.
 */
export async function finishFreeReturn({
  mnemonic, transitKey, solanaRecipient, amountRao, expectedColdkey = null, progress = {},
  onStep = () => {}, onCheckpoint = () => {}, waitMs = 2 * 60_000, pollMs = 4_000, ops = realOps,
}) {
  const coldkey = ops.signerAddress(mnemonic);
  if (expectedColdkey && coldkey !== expectedColdkey) throw new Error("the return signer does not match the expected derived coldkey");
  const transitAddress = ops.transitAddress(transitKey);
  const mirrorAddress = await ops.mirrorAddress(transitAddress);
  let saved = { ...progress };
  const save = (patch) => { saved = { ...saved, ...patch }; onCheckpoint(saved); };
  const out = (extra) => ({ ...extra, coldkey, transitAddress, mirrorAddress });

  // ── reconcile whatever the last run may have left in flight ──────────────
  // A funding transfer is included once the coldkey's on-chain nonce has moved past it.
  const settleFund = async (rec) => {
    const nonce = BigInt(rec.nonce);
    if ((await ops.coldkeyNonce(rec.address)) > nonce) return "included";
    const sub = await ops.submitFund(rec.signed); // identical bytes: at most one can ever be included
    if (sub.state === "rejected") return (await ops.coldkeyNonce(rec.address)) > nonce ? "included" : "dead";
    const start = Date.now();
    while ((await ops.coldkeyNonce(rec.address)) <= nonce) {
      if (Date.now() - start >= waitMs) throw new Error("the funding transfer is still pending on Bittensor: come back and sign again to finish");
      await sleep(pollMs);
    }
    return "included";
  };
  // An EVM transaction is settled once mined, or dead once its nonce was used by something else.
  const settleEvm = async (rec) => {
    let s = await ops.evmStatus(rec);
    if (s.state === "pending") {
      await ops.broadcast(rec.raw);
      try { await ops.waitMined(rec.hash, { pollMs, timeoutMs: waitMs }); } catch (e) { if (!e.reverted) throw e; }
      s = await ops.evmStatus(rec);
      if (s.state === "pending") throw new Error(`transaction ${rec.hash} is still pending on Bittensor: come back and sign again to finish`);
    }
    return s;
  };

  if (saved.send && saved.send.status !== "dead" && saved.send.status !== "mined") {
    const s = await settleEvm(saved.send);
    if (s.state === "mined") {
      if (!s.ok) throw Object.assign(new Error(`return transaction ${saved.send.hash} reverted`), { reverted: true, hash: saved.send.hash });
      save({ stage: "sent", send: { ...saved.send, status: "mined" }, sendHash: saved.send.hash });
      onStep("bridge", "ok", "sent to Solana through LayerZero");
      return out({ stage: "sent", sendHash: saved.send.hash });
    }
    save({ send: { ...saved.send, status: "dead" } });
  } else if (saved.send?.status === "mined") {
    return out({ stage: "sent", sendHash: saved.send.hash });
  }
  if (saved.fund && saved.fund.status !== "included" && saved.fund.status !== "dead") {
    onStep("transfer", "busy", "checking the earlier funding transfer");
    save({ fund: { ...saved.fund, status: await settleFund(saved.fund) } });
  }
  if (saved.wrap && saved.wrap.status !== "mined" && saved.wrap.status !== "dead") {
    onStep("wrap", "busy", "checking the earlier wrap");
    const s = await settleEvm(saved.wrap);
    save({ wrap: { ...saved.wrap, status: s.state === "mined" ? "mined" : "dead" } });
  }

  // ── from here, fresh chain state decides what is still missing ──────────
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
    const rec = await ops.prepareFund(mnemonic, mirrorAddress, fundingRao);
    if (rec.address !== coldkey) throw new Error("the funding transfer was signed by a different coldkey");
    save({ stage: "funding", fund: { ...str(rec), amountRao: String(fundingRao), to: mirrorAddress, status: "signed" } });
    const sub = await ops.submitFund(rec.signed);
    if (sub.state === "rejected") { save({ fund: { ...saved.fund, status: "dead" } }); throw new Error(`Bittensor refused the funding transfer: ${sub.reason}`); }
    const status = await settleFund(saved.fund);
    save({ stage: "funded", fund: { ...saved.fund, status } });
    if (status === "dead") throw new Error("the funding transfer expired before it was included: sign again to retry");
    state = await waitForFunding(ops, transitAddress, minimumNativeWei, { waitMs, pollMs });
    onStep("transfer", "ok", "TAO arrived on the transit account");
  };

  // Reuse any wTAO already present from an interrupted attempt; only wrap the missing amount.
  const plan = planReturnFunding({
    amountRao: cleanAmountRao, nativeFeeWei: quote.nativeFee, gasPriceWei,
    transitNativeWei: state.nativeWei, transitWtaoWei: state.wtaoWei,
  });
  await ensureFunding(plan.requiredNativeWei);
  state = await ops.state(transitAddress);
  const wrapWei = amountWei > state.wtaoWei ? amountWei - state.wtaoWei : 0n;
  if (wrapWei > 0n) {
    onStep("wrap", "busy", "wrapping native TAO to canonical wTAO");
    const rec = await ops.signWrap(transitKey, wrapWei, gasPriceWei);
    save({ stage: "wrapping", wrap: { ...str(rec), amountWei: String(wrapWei), status: "signed" } });
    await ops.broadcast(rec.raw);
    await ops.waitMined(rec.hash, { pollMs, timeoutMs: waitMs });
    save({ stage: "wrapped", wrap: { ...saved.wrap, status: "mined" } });
    state = await ops.state(transitAddress);
    if (state.wtaoWei < amountWei) throw new Error("the wrap transaction landed but the expected wTAO is not present");
    onStep("wrap", "ok", "wTAO ready for LayerZero");
  }

  // Re-quote immediately before sending. A higher fee or gas price receives a precise top-up rather
  // than causing a revert after the user's TAO has already been wrapped.
  quote = await ops.quoteBridge({ amountRao: cleanAmountRao, solanaRecipient });
  if (quote.amountWei !== amountWei || quote.lzTokenFee !== 0n) throw new Error("the canonical return quote changed shape while preparing the route");
  gasPriceWei = await ops.gasPrice();
  await ensureFunding(quote.nativeFee + RETURN_GAS_LIMIT.send * gasPriceWei);

  onStep("bridge", "busy", "sending canonical TAO to Solana");
  const rec = await ops.signSend(transitKey, { solanaRecipient, amountWei, nativeFeeWei: quote.nativeFee, gasPriceWei });
  save({ stage: "send-signed", send: { ...str(rec), amountWei: String(amountWei), status: "signed" }, sendHash: rec.hash });
  await ops.broadcast(rec.raw);
  await ops.waitMined(rec.hash, { pollMs, timeoutMs: waitMs });
  const done = { stage: "sent", sendHash: rec.hash, amountRao: cleanAmountRao, solanaAmountLd: quote.solanaAmountLd };
  save({ stage: "sent", send: { ...saved.send, status: "mined" }, amountRao: String(cleanAmountRao), solanaAmountLd: String(quote.solanaAmountLd) });
  onStep("bridge", "ok", "sent to Solana through LayerZero");
  return out(done);
}
