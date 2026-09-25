// Stake moves from the coldkey (src/stake_moves.js) against a simulated Substrate account with a
// transaction pool. Counts moves the chain APPLIED, since the danger is a second one landing.

import { runStakeMove, runRootClaim, limitPrice } from "../src/stake_moves.js";
import { fitReturnAmount } from "../src/fit.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const PRICE = 6_818_232n; // rao per Alpha, subnet 1 on 24 Sep 2026
const FEE = 90_000n;

// events: whether the fake node still has each extrinsic's success/failure event. incoming: TAO landing on
// the wallet in the same block, which can fool a balance reading.
function chain({ free = 2_000_000_000n, stake = 500_000_000n, priceAtDispatch = PRICE, events = true, incoming = 0n } = {}) {
  const s = { result: new Map(), free, stake, nonce: 0n, pool: new Map(), signed: new Map(), applied: 0, submits: 0, expired: new Set(), autoInclude: true, crashAfterSubmit: false };
  const include = () => {
    for (const [k, tx] of [...s.pool]) {
      s.pool.delete(k);
      if (tx.nonce !== s.nonce) continue;
      s.nonce++; s.free -= FEE - incoming; // the fee is paid even when dispatch fails
      const n = tx.netuid;
      s.result.set(`0x${k}`, "failed");
      if (tx.kind === "unstake") {
        const out = n === 0 ? tx.amount : (tx.amount * priceAtDispatch) / 1_000_000_000n;
        if (n !== 0 && priceAtDispatch < tx.limitRao) continue; // selling below the floor: refused
        s.stake -= tx.amount; s.free += out; s.applied++; s.result.set(`0x${k}`, "success");
      } else {
        if (n !== 0 && priceAtDispatch > tx.limitRao) continue; // buying above the ceiling: refused
        s.result.set(`0x${k}`, "success");
        s.free -= tx.amount; s.stake += n === 0 ? tx.amount : (tx.amount * 1_000_000_000n) / priceAtDispatch; s.applied++;
      }
    }
  };
  const ops = {
    signerAddress: () => "5Cold",
    free: async () => s.free,
    stakeOf: async () => s.stake,
    alphaPrice: async (n) => (Number(n) === 0 ? 1_000_000_000n : PRICE),
    prepare: async (_m, { kind, netuid, amount, limitRao }) => {
      const key = `signed-${s.signed.size}`;
      s.signed.set(key, { key, kind, netuid: Number(netuid), amount: BigInt(amount), limitRao: BigInt(limitRao), nonce: s.nonce });
      return { id: `0x${key}`, signed: key, nonce: String(s.nonce), address: "5Cold", fromBlock: "100" };
    },
    submit: async (signed) => {
      const tx = s.signed.get(signed); s.submits++;
      if (s.expired.has(signed) || tx.nonce < s.nonce) return { state: "rejected", reason: "outdated" };
      s.pool.set(signed, tx);
      if (s.crashAfterSubmit) { s.crashAfterSubmit = false; throw new Error("page closed after submitting"); }
      if (s.autoInclude) include();
      return { state: "submitted" };
    },
    coldkeyNonce: async () => { if (s.autoInclude) include(); return s.nonce; },
    outcome: async (id) => (events ? s.result.get(id) ?? null : null),
  };
  let last = {};
  const run = (args, progress = last) => runStakeMove({ mnemonic: "words", hotkey: "5Hot", ...args, progress, ops, waitMs: 0, pollMs: 0, onCheckpoint: (p) => { last = JSON.parse(JSON.stringify(p)); } });
  return { s, run, saved: () => last };
}

{
  // A root stake whose balance drop is hidden by TAO arriving in the same block: its success event decides.
  const { s, run } = chain({ incoming: 1_000_000_000n });
  const r = await run({ kind: "stake", netuid: 0, amount: 300_000_000n });
  expect("a stake masked by an incoming transfer is still reported as made, from its success event", r.done && s.applied === 1, JSON.stringify({ done: r.done, applied: s.applied }));
}
{
  // A subnet stake refused on price, while the wallet's balance happened to fall anyway: the failed event decides.
  const { s, run } = chain({ priceAtDispatch: PRICE * 2n, incoming: -400_000_000n });
  const r = await run({ kind: "stake", netuid: 1, amount: 300_000_000n });
  expect("a refused stake is reported as not made even when the balance fell", r.refused && s.applied === 0);
}

expect("unstake floor and stake ceiling sit 2% either side of the price", limitPrice("unstake", 1_000_000n, 200n) === 980_000n && limitPrice("stake", 1_000_000n, 200n) === 1_020_000n);

{
  const { s, run } = chain();
  const r = await run({ kind: "unstake", netuid: 1, amount: 200_000_000n });
  expect("a subnet unstake lands once and frees TAO", r.done && s.applied === 1 && s.stake === 300_000_000n && s.free > 2_000_000_000n - FEE, `stake ${s.stake}, free ${s.free}`);
  expect("it reports the free TAO it gained, net of its fee, for a chained return", r.freed === s.free - 2_000_000_000n && r.freed > 0n, `freed ${r.freed}`);
}
{
  const { s, run } = chain();
  const r = await run({ kind: "stake", netuid: 0, amount: 300_000_000n });
  expect("a root stake of free TAO lands once", r.done && s.applied === 1 && s.stake === 800_000_000n, `stake ${s.stake}`);
}
{
  const { s, run } = chain({ priceAtDispatch: (PRICE * 95n) / 100n });
  const r = await run({ kind: "unstake", netuid: 1, amount: 100_000_000n });
  expect("a price 5% worse at dispatch is refused: the nonce is used, nothing moves", r.refused && !r.done && s.applied === 0 && s.nonce === 1n && s.stake === 500_000_000n, JSON.stringify({ applied: s.applied, nonce: String(s.nonce) }));
}
{
  const { s, run } = chain();
  s.autoInclude = false; s.crashAfterSubmit = true;
  let first = ""; try { await run({ kind: "unstake", netuid: 1, amount: 100_000_000n }); } catch (e) { first = e.message; }
  expect("page closes after submitting, before inclusion", /closed/.test(first) && s.applied === 0 && s.pool.size === 1);
  s.autoInclude = true;
  const r = await run({ kind: "unstake", netuid: 1, amount: 100_000_000n });
  expect("resume re-submits the same bytes and it lands exactly once", r.done && s.applied === 1 && s.signed.size === 1, `applied ${s.applied}, signed ${s.signed.size}`);
}
{
  const { s, run, saved } = chain();
  s.autoInclude = false; s.crashAfterSubmit = true;
  try { await run({ kind: "stake", netuid: 1, amount: 100_000_000n }); } catch { /* closed */ }
  s.expired.add(saved().rec.signed); s.pool.clear(); s.autoInclude = true;
  const r = await run({ kind: "stake", netuid: 1, amount: 100_000_000n });
  expect("an expired stake move is reported as not made, and nothing is signed again on its own", r.refused && s.applied === 0 && s.signed.size === 1);
}
{
  const { run } = chain();
  let m1 = ""; try { await run({ kind: "unstake", netuid: 1, amount: 900_000_000n }, {}); } catch (e) { m1 = e.message; }
  let m2 = ""; try { await run({ kind: "stake", netuid: 1, amount: 9_000_000_000n }, {}); } catch (e) { m2 = e.message; }
  expect("more than the position, or more than the free TAO, is refused before signing", /more than this position/.test(m1) && /more free TAO/.test(m2), `${m1} | ${m2}`);
}

// ── root rewards: a claim pays the coldkey's slice of the validator's basket into its root stake ──
function claimChain({ rootStake = 100_000_000n, owed = 2_000_000n, minRao = 500_000n } = {}) {
  const s = { rootStake, owed, free: 50_000_000n, nonce: 0n, pool: new Map(), signed: new Map(), applied: 0, autoInclude: true, crashAfterSubmit: false };
  const include = () => {
    for (const [k, tx] of [...s.pool]) {
      s.pool.delete(k);
      if (tx.nonce !== s.nonce) continue;
      s.nonce++; s.free -= FEE;
      if (s.owed < minRao) continue; // under the chain's minimum: accepted, charged, pays nothing
      s.rootStake += s.owed; s.owed = 0n; s.applied++;
    }
  };
  const ops = {
    signerAddress: () => "5Cold",
    stakeOf: async (_c, _h, n) => (Number(n) === 0 ? s.rootStake : 0n),
    rootPayout: async () => s.owed,
    prepareClaim: async () => {
      const key = `claim-${s.signed.size}`;
      s.signed.set(key, { key, nonce: s.nonce });
      return { id: `0x${key}`, signed: key, nonce: String(s.nonce), address: "5Cold" };
    },
    submit: async (signed) => {
      const tx = s.signed.get(signed);
      if (tx.nonce < s.nonce) return { state: "rejected", reason: "outdated" };
      s.pool.set(signed, tx);
      if (s.crashAfterSubmit) { s.crashAfterSubmit = false; throw new Error("page closed after submitting"); }
      if (s.autoInclude) include();
      return { state: "submitted" };
    },
    coldkeyNonce: async () => { if (s.autoInclude) include(); return s.nonce; },
  };
  let last = {};
  const run = (progress = last) => runRootClaim({ mnemonic: "words", hotkey: "5Hot", progress, ops, waitMs: 0, pollMs: 0, onCheckpoint: (p) => { last = JSON.parse(JSON.stringify(p)); } });
  return { s, run };
}
{
  const { s, run } = claimChain();
  const r = await run({});
  expect("a root claim lands once and adds the rewards to the root stake", r.done && s.applied === 1 && r.gained === 2_000_000n && s.rootStake === 102_000_000n, `gained ${r.gained}, root ${s.rootStake}`);
}
{
  const { s, run } = claimChain();
  s.autoInclude = false; s.crashAfterSubmit = true;
  let threw = false; try { await run({}); } catch { threw = true; }
  s.autoInclude = true;
  const r = await run();
  expect("a claim resumed after the page closed settles the same extrinsic and never signs a second", threw && r.done && s.applied === 1 && s.signed.size === 1, `signed ${s.signed.size}, applied ${s.applied}`);
}
{
  const { s, run } = claimChain({ owed: 100_000n });
  const r = await run({});
  expect("a claim under the chain's minimum is reported as paying nothing", r.refused && !r.done && s.applied === 0 && s.rootStake === 100_000_000n);
}
{
  const { s, run } = claimChain({ owed: 0n });
  let m = ""; try { await run({}); } catch (e) { m = e.message; }
  expect("nothing waiting: refused before anything is signed", /no root rewards/.test(m) && s.signed.size === 0, m);
}

// ── unstake, then return: how much of the freed TAO fits after the return's own costs ──
{
  const floor = (x) => x - (x % 1000n);
  // Costs of a return of `amt` from `free`: the amount, a 3,000,000-rao bridge fee and gas, and a
  // 125,000-rao funding fee, like a real quote in shape.
  const model = (free, calls) => async (amt) => { calls.push(amt); return free - amt - 3_000_000n - 125_000n; };
  const base = { keep: 1_000_000n, min: 1_000n, floor };
  let calls = [];
  const all = await fitReturnAmount({ ...base, freed: 500_000_000n, free: 500_000_000n, leftAfter: model(500_000_000n, calls) });
  expect("everything freed, less the return's costs, leaving the kept balance", all === 495_875_000n && calls.length === 2, `${all} after ${calls.length} quotes`);
  calls = [];
  const some = await fitReturnAmount({ ...base, freed: 200_000_000n, free: 900_000_000n, leftAfter: model(900_000_000n, calls) });
  expect("only what the unstake freed goes when the wallet already had free TAO to cover the fees", some === 200_000_000n && calls.length === 1, `${some}`);
  const none = await fitReturnAmount({ ...base, freed: 3_500_000n, free: 3_500_000n, leftAfter: model(3_500_000n, []) });
  expect("nothing is returned when the fees would take it all", none === 0n, `${none}`);
  const stuck = await fitReturnAmount({ ...base, freed: 500_000_000n, free: 500_000_000n, leftAfter: async () => 0n });
  expect("a quote that never leaves the kept balance returns nothing rather than guessing", stuck === 0n, `${stuck}`);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
