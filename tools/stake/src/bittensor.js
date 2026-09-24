// Bittensor reads and calldata, over its EVM JSON-RPC and precompiles. No signing here.

import { keccak_256 } from "@noble/hashes/sha3";
import { rpc, rpcBatch } from "./evm.js";
import { CONFIG } from "./config.js";

export const PRECOMPILE = {
  staking: "0x0000000000000000000000000000000000000805",
  balanceTransfer: "0x0000000000000000000000000000000000000800",
  addressMapping: "0x000000000000000000000000000000000000080C",
  balance: "0x000000000000000000000000000000000000080e",
  metagraph: "0x0000000000000000000000000000000000000802",
  alpha: "0x0000000000000000000000000000000000000808",
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
// ── the metagraph: who actually holds a slot on a subnet ────────────────────
const toWord = (h) => (h || "").replace(/^0x/, "").toLowerCase().padStart(64, "0");
const ethCalls = (list) => rpcBatch(list.map(({ to, data }) => ({ method: "eth_call", params: [{ to, data }, "latest"] })));

/** Number of uids registered on `netuid`; 0 means the subnet does not exist. */
export const getUidCount = async (netuid) => Number(await readUint(PRECOMPILE.metagraph, encode("getUidCount(uint16)", BigInt(netuid))));

// Slots change at most once per tempo (~72 min on most subnets), and the public RPC rate-limits, so a
// subnet's list is reused for a minute: pasting a second hotkey, or switching subnets and back, is free.
const HOTKEYS_TTL_MS = 60_000;
const hotkeyCache = new Map();

/** Every hotkey on `netuid`, indexed by uid, as lowercase 64-char hex. ~6 requests for 256 uids. */
export async function subnetHotkeys(netuid) {
  const key = String(netuid), hit = hotkeyCache.get(key);
  if (hit && Date.now() - hit.at < HOTKEYS_TTL_MS) return hit.keys;
  const n = await getUidCount(netuid);
  const calls = Array.from({ length: n }, (_, uid) => ({ to: PRECOMPILE.metagraph, data: encode("getHotkey(uint16,uint16)", BigInt(netuid), BigInt(uid)) }));
  const keys = (await ethCalls(calls)).map(toWord);
  hotkeyCache.set(key, { at: Date.now(), keys });
  return keys;
}

/**
 * Where `hotkey` sits on `netuid`. getDelegate() takes no netuid, so it cannot answer this: a
 * delegate on one subnet can hold no slot on another. Returns { uidCount, uid: null } when the
 * hotkey is not registered on the subnet, otherwise its uid, whether it holds a validator permit,
 * and its share of the subnet's dividends at the last epoch (a u16 fraction, a snapshot).
 */
export async function findOnSubnet(hotkey, netuid) {
  const keys = await subnetHotkeys(netuid);
  const uid = keys.indexOf(toWord(hex(hotkey)));
  if (uid < 0) return { uidCount: keys.length, uid: null };
  const [permit, dividends] = await ethCalls([
    { to: PRECOMPILE.metagraph, data: encode("getValidatorStatus(uint16,uint16)", BigInt(netuid), BigInt(uid)) },
    { to: PRECOMPILE.metagraph, data: encode("getDividends(uint16,uint16)", BigInt(netuid), BigInt(uid)) },
  ]);
  return { uidCount: keys.length, uid, validatorPermit: BigInt("0x" + toWord(permit)) === 1n, dividendShare: Number(BigInt("0x" + toWord(dividends))) / 65535 };
}

/**
 * Every hotkey holding a validator permit on `netuid`, for the picker: uid, hotkey (64-char hex), take
 * (null when the hotkey is not a registered delegate) and its share of the subnet's validator dividends
 * at the last epoch, a u16 fraction that moves every epoch. Sorted by that share, highest first, then
 * by uid. Stake is left out on purpose: the metagraph's stake unit was never confirmed, and stake size
 * is a poor guide to return (research/subnet-validator-data-research.md). ~13 requests on 256 uids.
 */
export async function subnetValidators(netuid) {
  const n = BigInt(netuid);
  const keys = await subnetHotkeys(n);
  const permits = await ethCalls(keys.map((_, uid) => ({ to: PRECOMPILE.metagraph, data: encode("getValidatorStatus(uint16,uint16)", n, BigInt(uid)) })));
  const uids = keys.map((_, uid) => uid).filter((uid) => BigInt("0x" + toWord(permits[uid])) === 1n);
  if (!uids.length) return [];
  const [divs, delegates] = await Promise.all([
    ethCalls(uids.map((uid) => ({ to: PRECOMPILE.metagraph, data: encode("getDividends(uint16,uint16)", n, BigInt(uid)) }))),
    ethCalls(uids.map((uid) => ({ to: PRECOMPILE.staking, data: encode("getDelegate(bytes32)", keys[uid]) }))),
  ]);
  return uids.map((uid, i) => {
    const d = (delegates[i] || "").replace(/^0x/, "");
    const exists = d.length >= 128 && BigInt("0x" + d.slice(0, 64)) === 1n;
    return { uid, hotkey: keys[uid], takePct: exists ? Number(BigInt("0x" + d.slice(64, 128))) / 655.35 : null, dividendShare: Number(BigInt("0x" + toWord(divs[i]))) / 65535 };
  }).sort((a, b) => b.dividendShare - a.dividendShare || a.uid - b.uid);
}

/**
 * A subnet's Alpha price in wei (18 decimals) of TAO per Alpha. Read 24 Sep 2026: subnet 1 returned
 * 0.00682 TAO, matching the ~11.2 Alpha that 0.0765 TAO bought in the zero-cost mainnet replay.
 */
export const getAlphaPrice = (netuid) => readUint(PRECOMPILE.alpha, encode("getAlphaPrice(uint16)", BigInt(netuid)));

/** Root stake (rao) owned by `coldkey` under `hotkey`. */
export const getRootStake = (hotkey, coldkey) => readUint(PRECOMPILE.staking, encode("getStake(bytes32,bytes32,uint256)", hotkey, coldkey, 0n));
/** Stake (rao or alpha) owned by `coldkey` under `hotkey` on `netuid`. */
export const getStake = (hotkey, coldkey, netuid) => readUint(PRECOMPILE.staking, encode("getStake(bytes32,bytes32,uint256)", hotkey, coldkey, BigInt(netuid)));
/** Free balance (rao) of an SS58 account. */
export const getFreeBalance = (coldkey) => readUint(PRECOMPILE.balance, encode("getFreeBalance(bytes32)", coldkey));
/** wTAO (18 decimals) held by an H160. */
export const getWtao = (address) => readUint(CONFIG.wtao, encode("balanceOf(address)", address));
/** The subtensor account an H160 acts as when it calls a precompile. */
export async function mirrorColdkey(address) {
  const out = await ethCall(PRECOMPILE.addressMapping, encode("addressMapping(address)", address));
  return Uint8Array.from(out.slice(0, 64).match(/.{2}/g), (x) => parseInt(x, 16));
}
