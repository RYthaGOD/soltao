// The page signs Bittensor EVM transactions with a hand-rolled RLP and noble's secp256k1, to avoid
// shipping ethers to the browser. Here both must produce identical bytes, and the real RPC must
// parse the result.

import { ethers } from "ethers";
import { signLegacyTx, signTx, rlp, rpc, txHash } from "../src/evm.js";
import { bittensorRpcs } from "../src/config.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

// RLP against ethers' encoder, including the length boundaries at 55 bytes.
for (const v of [[], [new Uint8Array()], [Uint8Array.of(0)], [Uint8Array.of(0x7f)], [Uint8Array.of(0x80)], [new Uint8Array(55).fill(1)], [new Uint8Array(56).fill(2)], [new Uint8Array(300).fill(3), [Uint8Array.of(1), new Uint8Array(60)]]]) {
  const ours = hex(rlp(v)), theirs = ethers.encodeRlp(v.map(function conv(x) { return Array.isArray(x) ? x.map(conv) : hex(x); }));
  expect(`rlp matches ethers (${JSON.stringify(v.map((x) => (Array.isArray(x) ? "list" : x.length)))})`, ours === theirs);
}

const key = ethers.Wallet.createRandom();
const cases = [
  { nonce: 0n, gasPrice: 5_000_000_000n, gasLimit: 60_000n, to: "0x134f59E8B8637FD70ae12f263492B1dc73A25D1e", value: 0n, data: "0x2e1a7d4d" + (10n ** 18n).toString(16).padStart(64, "0") },
  { nonce: 7n, gasPrice: 5_000_000_000n, gasLimit: 2_450_000n, to: "0x0000000000000000000000000000000000000805", value: 0n, data: "0x" + "ab".repeat(164) },
  { nonce: 300n, gasPrice: 17_000_000_000n, gasLimit: 45_000n, to: "0x0000000000000000000000000000000000000800", value: 123456789n, data: "0x" },
];
for (const [i, tx] of cases.entries()) {
  const ours = signLegacyTx(tx, bytes(key.privateKey));
  const theirs = await key.signTransaction({ type: 0, chainId: 964, nonce: Number(tx.nonce), gasPrice: tx.gasPrice, gasLimit: tx.gasLimit, to: tx.to, value: tx.value, data: tx.data });
  expect(`signed legacy tx ${i + 1} is byte-identical to ethers`, ours === theirs);
  const parsed = ethers.Transaction.from(ours);
  expect(`tx ${i + 1} recovers to the signer on chain 964`, parsed.from === key.address && parsed.chainId === 964n);
}

// A resumable route saves a transaction's hash before broadcasting it, so the hash computed from the
// signed bytes must be the one the chain will use.
for (const [i, tx] of cases.entries()) {
  const ours = signLegacyTx(tx, bytes(key.privateKey));
  expect(`tx ${i + 1} hash is known before broadcast and matches ethers`, txHash(ours) === ethers.Transaction.from(ours).hash);
}

// A reaped transit account restarts at nonce 0, so the next route can sign byte-for-byte a transaction
// an earlier route already ran, whose old receipt would then read as success (live, 24 Sep 2026).
{
  const pk = bytes(key.privateKey), tx = { to: "0x0000000000000000000000000000000000000800", data: "0xc1a39559", gasLimit: 45_000n, gasPrice: 5_000_000_000n };
  const old = txHash(signLegacyTx({ ...tx, nonce: 1n }, pk));
  const seen = new Set([old]), asked = [];
  const receiptOf = async (h) => { asked.push(h); return seen.has(h) ? { status: "0x1" } : null; };
  const fresh = await signTx(pk, tx, { receiptOf, nonceOf: async () => 1n });
  const parsed = ethers.Transaction.from(fresh.raw);
  expect("a transaction identical to one already mined is re-signed with a new hash", fresh.hash !== old && parsed.gasLimit === 45_001n && parsed.nonce === 1 && asked.length === 2, `${parsed.gasLimit}`);
  const plain = await signTx(pk, tx, { receiptOf: async () => null, nonceOf: async () => 1n });
  expect("…and an unseen one is signed as asked", plain.hash === old && ethers.Transaction.from(plain.raw).gasLimit === 45_000n);
}

// The real RPC must parse it: a zero-balance sender is refused for funds, never for format.
// Post once: `rpc()` retries the same bytes, so a first "insufficient funds" is overwritten by
// "already known" on the retry. A leftover mempool hit still is not proof — only funds-refusal is.
let parsed = false, last = "";
for (let i = 0; i < 4 && !parsed; i++) {
  const unfunded = { ...cases[2], nonce: BigInt(Math.floor(Math.random() * 1_000_000)) };
  const raw = signLegacyTx(unfunded, bytes(ethers.Wallet.createRandom().privateKey));
  try {
    const url = bittensorRpcs()[0];
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }) });
    const body = await res.json();
    last = body.error?.message || (res.ok ? "accepted an unfunded sender" : `HTTP ${res.status}`);
    if (/insufficient funds/i.test(last)) parsed = true;
  } catch (e) {
    last = e.message;
    if (/insufficient funds/i.test(e.message)) parsed = true;
  }
}
expect("Bittensor RPC parses the transaction (refuses an unfunded sender)", parsed, last);

{
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("lite.example")) throw new Error("lite down");
    return { ok: true, json: async () => ({ result: "0x3c4" }) };
  };
  try {
    const got = await rpc("eth_chainId", [], ["https://lite.example", "https://archive.example"]);
    expect("rpc falls through to the next URL when the first fails", got === "0x3c4" && seen[0].includes("lite.example") && seen.includes("https://archive.example"));
  } finally { globalThis.fetch = orig; }
}

{
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { solanaRpcs, bittensorRpcs } = await import("../src/config.js");
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const headers = readFileSync(join(root, "_headers"), "utf8");
  const nginx = readFileSync(join(root, "deploy/nginx.conf.template"), "utf8");
  const must = [...solanaRpcs(), ...bittensorRpcs(), "https://joell-lsu6ge-fast-mainnet.helius-rpc.com"];
  for (const url of must) {
    expect(`both CSPs list ${url}`, headers.includes(url) && nginx.includes(url));
  }
  expect("Helius is proxied at /solana-rpc with an env-substituted key", nginx.includes("location = /solana-rpc") && nginx.includes("${HELIUS_API_KEY}"));
  expect("the Helius API key is not in the page config", !readFileSync(join(root, "tools/stake/src/config.js"), "utf8").includes("mainnet.helius-rpc.com"));
  expect("official Solana RPC is not in connect-src (it 403s browser Origin)", !headers.includes("api.mainnet-beta.solana.com") && !nginx.includes("api.mainnet-beta.solana.com"));
  const html = readFileSync(join(root, "stake/index.html"), "utf8");
  expect("holdings copy says the stake route has carried real funds", html.includes("has carried real funds") && html.includes("Unstake, Move, Claim, and staking more from this list") && html.includes("have not yet carried real funds through this page"));
  expect("the stake page does not name a subnet to promote", !/Targon/i.test(html) && !/\bSN ?4\b/i.test(html));
  expect("the return review has a Solana TAO account row", html.includes('id="r-ata"'));
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
