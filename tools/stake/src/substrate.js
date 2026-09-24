// Coldkey transactions on Bittensor's Substrate side, for the return route. Loaded only by the return
// bundle, never by the forward page.
//
// Signing never touches polkadot's Keyring: its sr25519 needs WebAssembly, which the page's CSP does
// not allow ('wasm-unsafe-eval'). Instead the api is handed a signer backed by @scure/sr25519, the same
// pure-JS code that derives the coldkey (src/derive.js). test/substrate_quote_live.test.mjs checks
// that its signatures verify and that the extrinsic matches a Keyring-signed one byte for byte
// outside the signature.

import { ApiPromise, HttpProvider, Keyring } from "@polkadot/api";
import { sign as srSign, getPublicKey } from "@scure/sr25519";
import { blake2b } from "@noble/hashes/blake2b";
import { coldkeySecret, ss58Encode } from "./derive.js";

const API_START_MS = 30_000;
let _api = null; // a promise of a ready api

/**
 * The polkadot api, started once. If it cannot start (the RPC down, or rate-limiting: its 429s carry no
 * CORS header, so the browser just sees "Failed to fetch"), polkadot keeps retrying and never settles.
 * So startup is bounded: after 30 s it fails with a plain error and the next call starts afresh.
 */
export function getApi() {
  if (!_api) {
    const provider = new HttpProvider("https://lite.chain.opentensor.ai");
    // initWasm: false, so readiness never waits on WebAssembly the page CSP forbids; the return bundle
    // also swaps in polkadot's no-WebAssembly loader (build.mjs), leaving its pure-JS hashing in use.
    const api = new ApiPromise({ provider, noInitWarn: true, initWasm: false });
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("could not reach Bittensor (its public RPC may be busy): try again in a minute")), API_START_MS); });
    _api = Promise.race([api.isReadyOrError, timeout])
      .then(() => api)
      .catch((e) => { _api = null; api.disconnect().catch(() => {}); throw e; })
      .finally(() => clearTimeout(timer));
  }
  return _api;
}

export async function disconnectApi() {
  if (!_api) return;
  const pending = _api;
  _api = null;
  try { await (await pending).disconnect(); } catch { /* it never started */ }
}

/** Node-only cross-check (test/keyring.test.mjs): polkadot's own Keyring for the same phrase. */
export function coldkeyPair(mnemonic) {
  const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
  return keyring.addFromUri(mnemonic);
}

const hexToU8a = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/.{2}/g) || [], (x) => parseInt(x, 16));
const u8aToHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The coldkey as an address plus a polkadot `Signer`. Extrinsic payloads over 256 bytes are signed as
 * their blake2b-256 hash, and the signature carries the MultiSignature sr25519 prefix (0x01), exactly
 * as polkadot's own ExtrinsicPayload.sign does.
 */
export function coldkeySigner(mnemonic, { onSign = null } = {}) {
  const secret = coldkeySecret(mnemonic);
  const address = ss58Encode(getPublicKey(secret));
  const signer = {
    async signRaw({ data }) {
      let msg = hexToU8a(data);
      if (msg.length > 256) msg = blake2b(msg, { dkLen: 32 });
      if (onSign) onSign(msg);
      return { id: 1, signature: u8aToHex(Uint8Array.of(1, ...srSign(secret, msg))) };
    },
  };
  return { address, signer };
}

const destination = (value) => value instanceof Uint8Array ? ss58Encode(value) : value;

/** Read-only fee and balance check for the coldkey -> EVM-mirror funding transfer. */
export async function quoteTransfer(mnemonic, toAddress, amountRao) {
  const amount = BigInt(amountRao);
  if (amount <= 0n) throw new Error("transfer amount must be positive");
  const api = await getApi();
  const { address } = coldkeySigner(mnemonic);
  const extrinsic = api.tx.balances.transferAllowDeath(destination(toAddress), amount);
  const [payment, account] = await Promise.all([extrinsic.paymentInfo(address), api.query.system.account(address)]);
  const feeRao = payment.partialFee.toBigInt();
  const freeRao = account.data.free.toBigInt();
  return { address, freeRao, feeRao, amountRao: amount, remainingRao: freeRao - amount - feeRao };
}

/** Free (transferable) TAO in rao for an SS58 account. */
export async function freeBalance(address) {
  const api = await getApi();
  return (await api.query.system.account(address)).data.free.toBigInt();
}

/**
 * Every stake position a coldkey holds, from the chain's own StakeInfo runtime API (one read-only
 * call): { hotkey (SS58), netuid, stake } with stake in rao of TAO on root (netuid 0) and in the
 * subnet's Alpha units elsewhere. Zero positions are dropped.
 */
export async function stakePositions(address) {
  const api = await getApi();
  const info = await api.call.stakeInfoRuntimeApi.getStakeInfoForColdkey(address);
  return info.map((p) => ({ hotkey: p.hotkey.toString(), netuid: Number(p.netuid.toString()), stake: BigInt(p.stake.toString()) }))
    .filter((p) => p.stake > 0n)
    .sort((a, b) => a.netuid - b.netuid || (b.stake > a.stake ? 1 : -1));
}

// ── resumable transfers: sign, save, submit, reconcile ──────────────────────
// signAndSend() waits on a subscription, which an HTTP provider cannot serve, and it only yields a
// block hash. A resumable route instead signs offline (so the extrinsic hash and nonce are known and
// can be saved first), submits the exact bytes, and later reads the account nonce to learn whether
// that nonce was used. Mortal for ~64 blocks, so a lost transfer provably expires rather than lingering.
const MORTAL_BLOCKS = 64;

/** Any coldkey call, signed offline and not sent: { id, signed, nonce, address }. `build(api)` makes the call. */
export async function prepareCall(mnemonic, build, { onSign = null } = {}) {
  const api = await getApi();
  const { address, signer } = coldkeySigner(mnemonic, { onSign });
  const nonce = (await api.rpc.system.accountNextIndex(address)).toBigInt();
  const extrinsic = build(api);
  await extrinsic.signAsync(address, { signer, nonce, era: MORTAL_BLOCKS });
  return { id: extrinsic.hash.toHex(), signed: extrinsic.toHex(), nonce: String(nonce), address };
}

/** A signed funding transfer that has not been sent: { id, signed, nonce, address }. */
export const prepareTransfer = (mnemonic, toAddress, amountRao, opts) =>
  prepareCall(mnemonic, (api) => api.tx.balances.transferAllowDeath(destination(toAddress), BigInt(amountRao)), opts);

/**
 * A stake move from the coldkey, signed and not sent. Root (netuid 0) has no pool, so it is a plain
 * addStake/removeStake. A subnet swaps through its Alpha pool, so it is the *Limit form, never a partial
 * fill: `limitRao` is the worst price accepted in rao of TAO per Alpha (a ceiling when buying, a floor
 * when selling). Argument order is the live runtime's (test/polkadot.test.mjs, 24 Sep 2026).
 */
export function prepareStakeMove(mnemonic, { kind, hotkey, netuid, amount, limitRao }) {
  const n = Number(netuid), amt = BigInt(amount);
  return prepareCall(mnemonic, (api) => {
    const m = api.tx.subtensorModule;
    if (kind === "stake") return n === 0 ? m.addStake(hotkey, 0, amt) : m.addStakeLimit(hotkey, n, amt, BigInt(limitRao), false);
    if (kind === "unstake") return n === 0 ? m.removeStake(hotkey, 0, amt) : m.removeStakeLimit(hotkey, n, amt, BigInt(limitRao), false);
    throw new Error(`unknown stake move ${kind}`);
  });
}

/** A subnet's Alpha price in rao of TAO per Alpha, from the chain's swap runtime API. Root is 1 TAO. */
export async function alphaPriceRao(netuid) {
  if (Number(netuid) === 0) return 1_000_000_000n;
  const api = await getApi();
  return BigInt((await api.call.swapRuntimeApi.currentAlphaPrice(Number(netuid))).toString());
}

/** The stake one coldkey holds under one hotkey on one netuid (rao on root, Alpha units elsewhere). */
export async function stakeOf(coldkey, hotkey, netuid) {
  return (await stakePositions(coldkey)).filter((p) => p.hotkey === hotkey && p.netuid === Number(netuid)).reduce((a, p) => a + p.stake, 0n);
}

/** Submits signed bytes. "Already imported" means it is in the pool: pending, not an error. */
export async function submitSigned(signedHex) {
  const api = await getApi();
  try {
    return { state: "submitted", id: (await api.rpc.author.submitExtrinsic(signedHex)).toHex() };
  } catch (e) {
    const m = String(e?.message || e);
    if (/already imported|AlreadyImported|Priority is too low|1013|1014/i.test(m)) return { state: "submitted" };
    return { state: "rejected", reason: m }; // stale, expired, or invalid: this extrinsic can never land
  }
}

/** The account's on-chain nonce: a saved transfer with a lower nonce has been included. */
export async function accountNonce(address) {
  const api = await getApi();
  return (await api.query.system.account(address)).nonce.toBigInt();
}
