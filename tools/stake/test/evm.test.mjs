// The page signs Bittensor EVM transactions with a hand-rolled RLP and noble's secp256k1, to avoid
// shipping ethers to the browser. Here both must produce identical bytes, and the real RPC must
// parse the result.

import { ethers } from "ethers";
import { signLegacyTx, rlp, rpc } from "../src/evm.js";

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

// The real RPC must parse it: a zero-balance sender is refused for funds, never for format. A
// random nonce keeps this from colliding with the same fixed shape on repeated runs, which the
// node's mempool dedup reports as "already known" instead of the refusal being checked here.
const unfunded = { ...cases[2], nonce: BigInt(Math.floor(Math.random() * 1_000_000)) };
try { await rpc("eth_sendRawTransaction", [signLegacyTx(unfunded, bytes(ethers.Wallet.createRandom().privateKey))]); expect("RPC refuses an unfunded tx", false, "accepted?"); }
catch (e) { expect("Bittensor RPC parses the transaction (refuses it only for funds)", /insufficient funds/i.test(e.message), e.message); }

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
