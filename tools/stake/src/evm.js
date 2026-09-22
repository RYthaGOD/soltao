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

export const getBalance = async (address) => BigInt(await rpc("eth_getBalance", [address, "latest"]));
export const getGasPrice = async () => BigInt(await rpc("eth_gasPrice"));

/** Sends one transaction from the transit key and waits for its receipt. Throws if it reverts. */
export async function sendTx(privateKey, { to, value = 0n, data = "0x", gasLimit, gasPrice }, { pollMs = 3000, timeoutMs = 5 * 60_000 } = {}) {
  const from = evmAddress(privateKey);
  const nonce = BigInt(await rpc("eth_getTransactionCount", [from, "pending"]));
  const price = gasPrice ?? (await getGasPrice());
  const hash = await rpc("eth_sendRawTransaction", [signLegacyTx({ nonce, gasPrice: price, gasLimit: BigInt(gasLimit), to, value, data }, privateKey)]);
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
