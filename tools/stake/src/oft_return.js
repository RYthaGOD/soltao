// The LayerZero half of a Bittensor EVM -> Solana return route.
//
// wTAO is 18 decimals locally, canonical Solana TAO is 9 decimals, and their OFT uses 6 shared
// decimals. A return amount therefore has to be floored to 0.000001 TAO before it can cross. This
// module only builds and quotes the canonical OFT call; it does not sign or send a transaction.

import { CONFIG } from "./config.js";
import { rpc } from "./evm.js";
import { selector } from "./bittensor.js";

export const SOLANA_EID = 30_168n;
export const WEI_PER_RAO = 1_000_000_000n;
export const EVM_OFT_DUST_WEI = 1_000_000_000_000n; // 10^(18 local - 6 shared)
export const MIN_RETURN_RAO = EVM_OFT_DUST_WEI / WEI_PER_RAO; // 0.000001 TAO
export const RETURN_GAS_LIMIT = { wrap: 75_000n, send: 650_000n };

const MAX_UINT256 = (1n << 256n) - 1n;
const cleanHex = (value) => String(value).replace(/^0x/i, "").toLowerCase();
const uintWord = (value) => {
  const n = BigInt(value);
  if (n < 0n || n > MAX_UINT256) throw new Error("value does not fit uint256");
  return n.toString(16).padStart(64, "0");
};
const bytes32Word = (value) => {
  const hex = value instanceof Uint8Array
    ? Array.from(value, (x) => x.toString(16).padStart(2, "0")).join("")
    : cleanHex(value);
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Solana recipient must be exactly 32 bytes");
  return hex;
};
const addressWord = (value) => {
  const hex = cleanHex(value);
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error("refund address must be an EVM address");
  return hex.padStart(64, "0");
};
const sendParamWords = ({ to, amountLd, minAmountLd }) => [
  uintWord(SOLANA_EID), bytes32Word(to), uintWord(amountLd), uintWord(minAmountLd),
  uintWord(0xe0n), uintWord(0x100n), uintWord(0x120n),
  uintWord(0n), uintWord(0n), uintWord(0n), // three empty dynamic byte arrays
];

/** Convert rao into EVM-local wTAO units. */
export const raoToWei = (rao) => BigInt(rao) * WEI_PER_RAO;

/** Floor an EVM-local amount to the six decimals this OFT can carry between chains. */
export const removeReturnDust = (amountWei) => (BigInt(amountWei) / EVM_OFT_DUST_WEI) * EVM_OFT_DUST_WEI;

/** The canonical Solana token amount (9 decimals) reconstructed from an EVM-local OFT amount. */
export const solanaLdFromWei = (amountWei) => removeReturnDust(amountWei) / WEI_PER_RAO;

const ceilDiv = (value, divisor) => (BigInt(value) + BigInt(divisor) - 1n) / BigInt(divisor);

/**
 * Build the funding side of a free-TAO return. This is deliberately pure so every rao can be tested
 * before a coldkey signature is requested. Existing native TAO and wTAO on the user's transit
 * account are reused, which also gives an interrupted route a deterministic recovery plan.
 */
export function planReturnFunding({ amountRao, nativeFeeWei, gasPriceWei, transitNativeWei = 0n, transitWtaoWei = 0n }) {
  const amountWei = removeReturnDust(raoToWei(amountRao));
  if (amountWei === 0n) throw new Error("return amount must be at least 0.000001 TAO");
  const nativeFee = BigInt(nativeFeeWei);
  const gasPrice = BigInt(gasPriceWei);
  const native = BigInt(transitNativeWei);
  const wtao = BigInt(transitWtaoWei);
  if ([nativeFee, gasPrice, native, wtao].some((n) => n < 0n)) throw new Error("return funding values cannot be negative");

  const existingWtaoUsed = wtao < amountWei ? wtao : amountWei;
  const wrapWei = amountWei - existingWtaoUsed;
  // Hold 20% above the two declared gas limits so a modest gas-price move does not strand a route.
  const remainingGas = RETURN_GAS_LIMIT.send + (wrapWei > 0n ? RETURN_GAS_LIMIT.wrap : 0n);
  const gasReserveWei = ceilDiv(remainingGas * gasPrice * 12_000n, 10_000n);
  const requiredNativeWei = wrapWei + nativeFee + gasReserveWei;
  const fundingWei = requiredNativeWei > native ? requiredNativeWei - native : 0n;
  const fundingRao = ceilDiv(fundingWei, WEI_PER_RAO);

  return {
    amountWei, amountRao: amountWei / WEI_PER_RAO, solanaAmountLd: solanaLdFromWei(amountWei),
    existingWtaoUsed, wrapWei, nativeFeeWei: nativeFee, gasReserveWei, requiredNativeWei,
    fundingWei, fundingRao, fundingOverageWei: fundingRao * WEI_PER_RAO - fundingWei,
    leftoverWtaoWei: wtao - existingWtaoUsed,
  };
}

export function encodeQuoteSend({ to, amountLd, minAmountLd = amountLd }) {
  const sig = "quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool)";
  return `0x${selector(sig)}${uintWord(0x40n)}${uintWord(0n)}${sendParamWords({ to, amountLd, minAmountLd }).join("")}`;
}

export function encodeOftSend({ to, amountLd, minAmountLd = amountLd, nativeFee, lzTokenFee = 0n, refundAddress }) {
  const sig = "send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)";
  return `0x${selector(sig)}${uintWord(0x80n)}${uintWord(nativeFee)}${uintWord(lzTokenFee)}${addressWord(refundAddress)}${sendParamWords({ to, amountLd, minAmountLd }).join("")}`;
}

export function decodeMessagingFee(result) {
  const hex = cleanHex(result);
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < 128) throw new Error("invalid quoteSend response");
  return { nativeFee: BigInt(`0x${hex.slice(0, 64)}`), lzTokenFee: BigInt(`0x${hex.slice(64, 128)}`) };
}

/** Quote a free-TAO return without changing chain state. Amounts are exact after OFT dust removal. */
export async function quoteReturn({ amountRao, solanaRecipient }) {
  const amountWei = removeReturnDust(raoToWei(amountRao));
  if (amountWei === 0n) throw new Error("return amount must be at least 0.000001 TAO");
  const data = encodeQuoteSend({ to: solanaRecipient, amountLd: amountWei });
  const fee = decodeMessagingFee(await rpc("eth_call", [{ to: CONFIG.wtao, data }, "latest"]));
  return { ...fee, amountWei, amountRao: amountWei / WEI_PER_RAO, solanaAmountLd: solanaLdFromWei(amountWei) };
}
