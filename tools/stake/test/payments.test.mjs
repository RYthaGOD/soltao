// "Top up Chutes" (src/payments.js) against a simulated Substrate account with a transaction pool.
// Counts transfers the chain APPLIED, since the danger is paying twice.

import { runPayment, payeeProblem, paymentCall, CHUTES_MIN_RAO, SOLTAO_TAG, SOLTAO_TAG_HASH } from "../src/payments.js";
import { blake2b } from "@noble/hashes/blake2b";
import { ss58Encode } from "../src/derive.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const FEE = 120_000n;
const OWN = ss58Encode(new Uint8Array(32).fill(1));
const CHUTES = ss58Encode(new Uint8Array(32).fill(2));

function chain({ free = 1_000_000_000n, dispatchFails = false } = {}) {
  const s = { free, paid: 0n, nonce: 0n, pool: new Map(), signed: new Map(), applied: 0, expired: new Set(), autoInclude: true, crashAfterSubmit: false, to: [] };
  const include = () => {
    for (const [k, tx] of [...s.pool]) {
      s.pool.delete(k);
      if (tx.nonce !== s.nonce) continue;
      s.nonce++; s.free -= FEE; // the fee is paid even when dispatch fails
      if (dispatchFails) continue;
      s.free -= tx.amount; s.paid += tx.amount; s.applied++; s.to.push(tx.to);
    }
  };
  const ops = {
    signerAddress: () => OWN,
    free: async () => s.free,
    prepare: async (_m, to, amount) => {
      const key = `signed-${s.signed.size}`;
      s.signed.set(key, { key, to, amount: BigInt(amount), nonce: s.nonce });
      return { id: `0x${key}`, signed: key, nonce: String(s.nonce), address: OWN };
    },
    submit: async (signed) => {
      const tx = s.signed.get(signed);
      if (s.expired.has(signed) || tx.nonce < s.nonce) return { state: "rejected", reason: "outdated" };
      s.pool.set(signed, tx);
      if (s.crashAfterSubmit) { s.crashAfterSubmit = false; throw new Error("page closed after submitting"); }
      if (s.autoInclude) include();
      return { state: "submitted" };
    },
    coldkeyNonce: async () => { if (s.autoInclude) include(); return s.nonce; },
  };
  let last = {};
  const run = (args, progress = last) => runPayment({ mnemonic: "words", to: CHUTES, ...args, progress, ops, waitMs: 0, pollMs: 0, onCheckpoint: (p) => { last = JSON.parse(JSON.stringify(p)); } });
  return { s, run, saved: () => last };
}

expect("a Chutes address passes", payeeProblem(CHUTES, OWN) === null);
expect("the wallet's own address is refused", payeeProblem(OWN, OWN) !== null);
expect("a typo is refused", payeeProblem(CHUTES.slice(0, -1) + (CHUTES.endsWith("a") ? "b" : "a"), OWN) !== null);
expect("an empty address is refused", payeeProblem("", OWN) !== null);

{
  const { s, run } = chain();
  const r = await run({ amount: 200_000_000n });
  expect("a top-up lands once, to the Chutes address", r.done && s.applied === 1 && s.paid === 200_000_000n && s.to[0] === CHUTES, `applied ${s.applied}, paid ${s.paid}`);
}

{
  const { s, run } = chain();
  let err = null;
  try { await run({ amount: CHUTES_MIN_RAO - 1n }); } catch (e) { err = e; }
  expect("below Chutes' 0.01 TAO dust floor nothing is signed", err && s.signed.size === 0, err?.message);
}

{
  const { s, run } = chain({ free: 50_000_000n });
  let err = null;
  try { await run({ amount: 60_000_000n }); } catch (e) { err = e; }
  expect("more than the free balance is refused before signing", err && s.signed.size === 0);
}

{
  const { s, run } = chain();
  let err = null;
  try { await run({ amount: 100_000_000n, to: OWN }); } catch (e) { err = e; }
  expect("paying the wallet's own address is refused before signing", err && s.signed.size === 0);
}

{
  // The page closes right after submitting; the transfer lands while it is closed. The resume must
  // recognise it, not pay again.
  const { s, run, saved } = chain();
  s.crashAfterSubmit = true;
  try { await run({ amount: 300_000_000n }); } catch { /* the tab closed */ }
  const r = await run({ amount: 300_000_000n }, saved());
  expect("a resumed top-up never pays twice", r.done && s.applied === 1 && s.signed.size === 1, `applied ${s.applied}, signed ${s.signed.size}`);
}

{
  // Closed after submitting, and the transfer is still in the pool when the page comes back.
  const { s, run, saved } = chain();
  s.autoInclude = false; s.crashAfterSubmit = true;
  try { await run({ amount: 300_000_000n }); } catch { /* the tab closed */ }
  s.autoInclude = true;
  const r = await run({ amount: 300_000_000n }, saved());
  expect("a pending top-up is finished, not re-signed", r.done && s.applied === 1 && s.signed.size === 1);
}

{
  // Included but failed to dispatch: only the fee went.
  const { s, run } = chain({ dispatchFails: true });
  const r = await run({ amount: 100_000_000n });
  expect("a transfer that did not dispatch is reported as not made", r.refused && !r.done && s.paid === 0n);
}

{
  const { s, run, saved } = chain();
  await run({ amount: 100_000_000n });
  const again = await run({ amount: 100_000_000n }, saved());
  expect("a finished top-up is not repeated by a stale resume", again.done && s.applied === 1);
}

{
  // The call a top-up signs: one all-or-nothing batch of the transfer, then the public tag.
  const api = { tx: {
    utility: { batchAll: (calls) => ({ call: "utility.batchAll", calls }) },
    balances: { transferAllowDeath: (to, amount) => ({ call: "balances.transferAllowDeath", to, amount }) },
    system: { remarkWithEvent: (remark) => ({ call: "system.remarkWithEvent", remark }) },
  } };
  const c = paymentCall(api, CHUTES, 250_000_000n);
  expect("a top-up is one batchAll: the transfer to Chutes, then the soltao tag", c.call === "utility.batchAll" && c.calls.length === 2
    && c.calls[0].call === "balances.transferAllowDeath" && c.calls[0].to === CHUTES && c.calls[0].amount === 250_000_000n
    && c.calls[1].call === "system.remarkWithEvent" && c.calls[1].remark === "soltao.xyz:chutes-topup:v1", JSON.stringify(c, (_k, v) => typeof v === "bigint" ? String(v) : v));
  const want = "0x" + Buffer.from(blake2b(Buffer.from(SOLTAO_TAG), { dkLen: 32 })).toString("hex");
  expect("the Remarked event hash every tagged top-up carries is published", SOLTAO_TAG_HASH === want && SOLTAO_TAG_HASH === "0x0f0d95b0ed710d56d26bcf41bea776f5ca2dee9f4de60b0995538a30fb321cc4", SOLTAO_TAG_HASH);
  let err = null;
  try { paymentCall({ tx: { balances: api.tx.balances, system: api.tx.system } }, CHUTES, 1n); } catch (e) { err = e; }
  expect("without batching on the chain nothing untagged is sent instead", err && /nothing was sent/.test(err.message));
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall payment checks passed");
