// Signs and sends Bittensor EVM transactions from the transit key. Legacy EIP-155 transactions on
// chain 964, which the public RPC accepts (checked 21 Sep 2026). test/evm.test.mjs checks the
// encoding and signatures against ethers byte for byte.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { CONFIG } from "./config.js";
import { evmAddress } from "./derive.js";

const CHAIN_ID = 964n;

const hexToBytes = (h) => { const s = h.replace(/^0x/, ""); if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error(`not even-length hex: ${h}`); return Uint8Array.from(s.match(/.{2}/g) || [], (x) => parseInt(x, 16)); };
const bytesToHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bigToBytes = (n) => { n = BigInt(n); if (n === 0n) return new Uint8Array(); const out = []; while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; } return Uint8Array.from(out); };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** RLP of a byte string or a (nested) list of them. */
export function rlp(item) {
  if (Array.isArray(item)) {
    const body = concat(...item.map(rlp));
    return concat(rlpLength(body.length, 0xc0), body);
  }
  if (item.length === 1 && item[0] < 0x80) return item;
  return concat(rlpLength(item.length, 0x80), item);
}
function rlpLength(len, offset) {
  if (len <= 55) return Uint8Array.of(offset + len);
  const l = bigToBytes(len);
  return concat(Uint8Array.of(offset + 55 + l.length), l);
}

/** A signed legacy EIP-155 transaction, as the hex string eth_sendRawTransaction takes. */
export function signLegacyTx({ nonce, gasPrice, gasLimit, to, value = 0n, data = "0x" }, privateKey) {
  const fields = [bigToBytes(nonce), bigToBytes(gasPrice), bigToBytes(gasLimit), hexToBytes(to), bigToBytes(value), hexToBytes(data)];
  const digest = keccak_256(rlp([...fields, bigToBytes(CHAIN_ID), new Uint8Array(), new Uint8Array()]));
  const sig = secp256k1.sign(digest, privateKey, { lowS: true });
  const v = CHAIN_ID * 2n + 35n + BigInt(sig.recovery);
  return bytesToHex(rlp([...fields, bigToBytes(v), bigToBytes(sig.r), bigToBytes(sig.s)]));
}

export async function rpc(method, params = [], url = CONFIG.bittensorEvmRpc) {
  let lastErr;
  const urls = Array.isArray(url) ? url : [url];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const u of urls) {
      try {
        const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (body.error) throw new Error(body.error.message || `${method} failed`);
        return body.result;
      } catch (e) {
        lastErr = e;
      }
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); // backoff
  }
  throw lastErr;
}

// Bittensor's public RPC rejects a JSON-RPC batch of more than 50 calls (measured 24 Sep 2026).
export const BATCH_LIMIT = 50;

/** Many calls in as few requests as the RPC allows, answered in order. Throws if any call fails. */
export async function rpcBatch(calls, url = CONFIG.bittensorEvmRpc) {
  const urls = Array.isArray(url) ? url : [url];
  const results = [];
  for (let i = 0; i < calls.length; i += BATCH_LIMIT) {
    const chunk = calls.slice(i, i + BATCH_LIMIT).map(({ method, params = [] }, j) => ({ jsonrpc: "2.0", id: j, method, params }));
    let lastErr, got = null;
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      for (const u of urls) {
        try {
          const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(chunk) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json();
          if (!Array.isArray(body)) throw new Error(body?.error?.message || "batch refused");
          const byId = new Map(body.map((r) => [r.id, r]));
          got = chunk.map(({ id, method }) => {
            const r = byId.get(id);
            if (!r || r.error) throw new Error(r?.error?.message || `${method} missing from batch reply`);
            return r.result;
          });
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!got) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!got) throw lastErr;
    results.push(...got);
  }
  return results;
}

export const getBalance = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"]));
export const getGasPrice = async () => BigInt(await rpc("eth_gasPrice"));

export const getNonce = async (address, tag = "latest") => BigInt(await rpc("eth_getTransactionCount", [address, tag]));
/** The hash a signed transaction will have, known before it is broadcast. */
export const txHash = (raw) => bytesToHex(keccak_256(hexToBytes(raw)));

/**
 * Signs without sending, so a caller can save the transaction's identity (hash, nonce, signed bytes)
 * before it can possibly land. A resume then reconciles that exact transaction instead of creating
 * a second one. `nonce` defaults to the account's next nonce including the mempool.
 */
export async function signTx(privateKey, { to, value = 0n, data = "0x", gasLimit, gasPrice, nonce }, { receiptOf = (h) => rpc("eth_getTransactionReceipt", [h]), nonceOf = (a) => getNonce(a, "pending") } = {}) {
  const from = evmAddress(privateKey);
  const n = nonce ?? (await nonceOf(from));
  const price = gasPrice ?? (await getGasPrice());
  // A sweep empties the transit account, Bittensor then reaps it, and its nonce starts again at 0.
  // Signing is deterministic and the gas price is usually the same 5 gwei, so a later route can sign
  // byte-for-byte the transaction an earlier one already ran: the node calls it "already known" and
  // the old receipt reads as success while nothing moves (seen live 24 Sep 2026: "Finish it" did
  // nothing). A receipt for a nonce not yet used can only be such a copy, so change the gas limit by
  // one unit until the hash is new. Only a caller that did not pin the nonce is checked.
  for (let bump = 0n; ; bump++) {
    const raw = signLegacyTx({ nonce: n, gasPrice: price, gasLimit: BigInt(gasLimit) + bump, to, value, data }, privateKey);
    const hash = txHash(raw);
    if (nonce !== undefined || !(await receiptOf(hash).catch(() => null))) return { raw, hash, nonce: n, from };
    if (bump >= 16n) throw new Error("could not make a transaction distinct from ones this account already ran");
  }
}

/** Broadcasts signed bytes. Re-broadcasting the same bytes is harmless: "already known" is success. */
export async function broadcast(raw) {
  try {
    return await rpc("eth_sendRawTransaction", [raw]);
  } catch (e) {
    if (/already known|known transaction|already imported|AlreadyKnown/i.test(e.message || "")) return txHash(raw);
    throw e;
  }
}

/**
 * Where a previously signed transaction stands: "mined" (with its receipt), "pending" (not mined, its
 * nonce still open, so re-broadcasting the same bytes is the safe move), or "dead" (its nonce was used
 * by something else, so it can never land and new work is safe).
 */
export async function txStatus({ hash, nonce, from }) {
  const receipt = await rpc("eth_getTransactionReceipt", [hash]);
  if (receipt) return { state: "mined", ok: receipt.status === "0x1", gasUsed: BigInt(receipt.gasUsed) };
  return (await getNonce(from, "latest")) > BigInt(nonce) ? { state: "dead" } : { state: "pending" };
}

/** Sends one transaction from the transit key and waits for its receipt. Throws if it reverts. */
export async function sendTx(privateKey, { to, value = 0n, data = "0x", gasLimit, gasPrice }, { pollMs = 3000, timeoutMs = 5 * 60_000, onBroadcast = () => {}, onSigned = null } = {}) {
  const signed = await signTx(privateKey, { to, value, data, gasLimit, gasPrice });
  // onSigned runs before the bytes leave: a caller that saves them there can never lose a
  // transaction whose broadcast succeeded but whose response was lost.
  if (onSigned) onSigned(signed);
  const hash = await broadcast(signed.raw);
  const nonce = signed.nonce;
  onBroadcast({ hash, nonce });
  return waitMined(hash, { pollMs, timeoutMs });
}

/** Polls for a receipt. Throws a `reverted` error if the chain refused it. */
export async function waitMined(hash, { pollMs = 3000, timeoutMs = 5 * 60_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let receipt;
    try {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
    } catch (e) {
      // rpc() already retries a few times on its own; this only catches it giving up entirely
      // (the RPC is down). Keep polling rather than fail the whole route over one bad round.
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (receipt) {
      // `reverted` tells a refusal by the chain apart from a network failure, which is worth
      // retrying. It must reach the caller, not be swallowed with a transport error above.
      if (receipt.status !== "0x1") throw Object.assign(new Error(`transaction ${hash} reverted`), { reverted: true, hash });
      return { hash, gasUsed: BigInt(receipt.gasUsed) };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`transaction ${hash} not mined after ${timeoutMs / 1000}s`);
}
