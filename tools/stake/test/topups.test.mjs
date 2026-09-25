// Counting soltao's Chutes top-ups from a block's events (src/topups.js), without a node.

import { topupsInBlock, summarize } from "../src/topups.js";
import { SOLTAO_TAG_HASH, CHUTES_MIN_RAO } from "../src/payments.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const ev = (extrinsic, section, method, data = []) => ({ extrinsic, section, method, data });
const A = "5Payer1", B = "5Payer2", C1 = "5Chutes1", C2 = "5Chutes2", OTHER = "0x" + "ab".repeat(32);
const tagged = (i, from, to, amount) => [
  ev(i, "balances", "Withdraw", [from, "125000"]),
  ev(i, "balances", "Transfer", [from, to, amount]),
  ev(i, "system", "Remarked", [from, SOLTAO_TAG_HASH]),
  ev(i, "utility", "BatchCompleted"),
  ev(i, "system", "ExtrinsicSuccess", [{}]),
];

const block = [
  ev(null, "system", "ExtrinsicSuccess"), // on-initialize noise
  ...tagged(1, A, C1, "200000000"),
  ev(2, "balances", "Transfer", [B, C2, "500000000"]), ev(2, "system", "ExtrinsicSuccess"), // untagged: not soltao's
  ev(3, "balances", "Transfer", [B, C2, "300000000"]), ev(3, "system", "Remarked", [B, OTHER]), ev(3, "system", "ExtrinsicSuccess"), // someone else's remark
  ...tagged(4, B, C2, "5000000"), // under Chutes' 0.01 TAO minimum
  ev(5, "system", "Remarked", [A, SOLTAO_TAG_HASH.toUpperCase().replace("0X", "0x")]), ev(5, "system", "ExtrinsicFailed"), // defensive: a failed tagged extrinsic
  ...tagged(6, A, C1, "1,000,000,000"), // polkadot can print amounts with separators
];
const found = topupsInBlock(block, { block: 100, at: "2026-10-01T00:00:00.000Z", tagHash: SOLTAO_TAG_HASH });
expect("only tagged extrinsics are counted, untagged and foreign remarks are not", found.map((t) => t.extrinsic).join() === "1,4,5,6", found.map((t) => t.extrinsic).join());
expect("each top-up records payer, Chutes address and amount", found[0].from === A && found[0].to === C1 && found[0].amountRao === "200000000" && found[0].ok && found[0].block === 100);
expect("separators in printed amounts are read correctly", found[3].amountRao === "1000000000");
expect("a failed tagged extrinsic is recorded as not completed", found[2].ok === false && found[2].to === null);

const s = summarize(found, { minRao: CHUTES_MIN_RAO });
expect("totals count completed top-ups at or above Chutes' minimum", s.count === 2 && s.totalRao === 1_200_000_000n, `${s.count}, ${s.totalRao}`);
expect("…from how many soltao wallets to how many Chutes accounts", s.payers === 1 && s.accounts === 1);
expect("…and report what was left out and why", s.belowMin === 1 && s.failed === 1);
expect("an empty scan totals zero", summarize([], { minRao: CHUTES_MIN_RAO }).count === 0);

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall top-up counting checks passed");
