// Bittensor reads and calldata, over its EVM JSON-RPC and precompiles. No signing here.

import { keccak_256 } from "@noble/hashes/sha3";
import { rpc } from "./evm.js";
import { CONFIG } from "./config.js";

export const PRECOMPILE = {
  staking: "0x0000000000000000000000000000000000000805",
  balanceTransfer: "0x0000000000000000000000000000000000000800",
  addressMapping: "0x000000000000000000000000000000000000080C",
  balance: "0x000000000000000000000000000000000000080e",
};

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const selector = (sig) => hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const word = (v) => {
  if (v instanceof Uint8Array) { if (v.length !== 32) throw new Error("expected 32 bytes"); return hex(v); }
  if (typeof v === "string") return v.toLowerCase().replace(/^0x/, "").padStart(64, "0"); // an address
  return BigInt(v).toString(16).padStart(64, "0");
};
/** Calldata: selector plus 32-byte words. */
export const encode = (sig, ...args) => "0x" + selector(sig) + args.map(word).join("");

const ethCall = async (to, data) => (await rpc("eth_call", [{ to, data }, "latest"])).replace(/^0x/, "");
const readUint = async (to, data) => BigInt("0x" + ((await ethCall(to, data)) || "0"));

/** Is this hotkey a registered delegate, and at what take? */
export async function getDelegate(hotkey) {
  const out = await ethCall(PRECOMPILE.staking, encode("getDelegate(bytes32)", hotkey));
  return { exists: BigInt("0x" + out.slice(0, 64)) === 1n, takePct: Number(BigInt("0x" + out.slice(64, 128))) / 655.35 };
}
/** Root stake (rao) owned by `coldkey` under `hotkey`. */
export const getRootStake = (hotkey, coldkey) => readUint(PRECOMPILE.staking, encode("getStake(bytes32,bytes32,uint256)", hotkey, coldkey, 0n));
/** Free balance (rao) of an SS58 account. */
export const getFreeBalance = (coldkey) => readUint(PRECOMPILE.balance, encode("getFreeBalance(bytes32)", coldkey));
/** wTAO (18 decimals) held by an H160. */
export const getWtao = (address) => readUint(CONFIG.wtao, encode("balanceOf(address)", address));
/** The subtensor account an H160 acts as when it calls a precompile. */
export async function mirrorColdkey(address) {
  const out = await ethCall(PRECOMPILE.addressMapping, encode("addressMapping(address)", address));
  return Uint8Array.from(out.slice(0, 64).match(/.{2}/g), (x) => parseInt(x, 16));
}
