// Read-only (vault research, 28 Sep 2026; docs/vault-research-2026-09-28.md).
// Backtest with no look-ahead: at the start of each 30-day window, choose subnets and validators
// using only state known then, and measure what the choice earned over the next 30 days.
//   Subnets: the top N by TAO in the pool at the window's start.
//   Validators: permitted at the start, with at least 1,000 alpha.
//   "picker" = best trailing 30-day share-value growth; "largest" = most stake; "median" = the median validator.
// Rules compared, in TAO: (a) root only, (b) root + picker on the top 3 subnets by alpha emission,
// (c) as (b) but skipping subnets whose price fell over the trailing 30 days, (d) equal weight over all N.
// Every chain read is cached in .research-cache.json (gitignored) and retried on the archive's rate limit.
//   node backtest_research.mjs [N=10] [WINDOWS=6]
import fs from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
const N = Number(process.argv[2] || 10), WINDOWS = Number(process.argv[3] || 6), DAY = 7200, MIN_STAKE = 1000e9;
const CACHE = new URL("./.research-cache.json", import.meta.url);
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
let dirty = 0;
const save = () => { fs.writeFileSync(CACHE, JSON.stringify(cache)); dirty = 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cached(key, fn) {
  if (key in cache) return cache[key];
  for (let i = 0; ; i++) {
    try {
      await sleep(150);
      const v = await fn();
      cache[key] = v;
      if (++dirty >= 20) save();
      return v;
    } catch (e) {
      if (!/-32004|429|rate/i.test(String(e.message)) || i >= 8) { save(); throw e; }
      const wait = 30000 * (i + 1);
      console.error(`rate limited, waiting ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}
const api = await ApiPromise.create({ provider: new WsProvider("wss://archive.chain.opentensor.ai:443"), noInitWarn: true });
// anchor to a fixed head so the cache stays valid across runs on the same day
const head = await cached("head:" + new Date().toISOString().slice(0, 10), async () => (await api.rpc.chain.getHeader()).number.toNumber());
const hashes = [];
for (let i = 0; i <= WINDOWS + 1; i++) hashes[i] = await cached("hash:" + (head - i * 30 * DAY), async () => (await api.rpc.chain.getBlockHash(head - i * 30 * DAY)).toHex());
const ats = {};
const at = async (i) => (ats[i] ??= await api.at(hashes[i]));
const sf = (j) => { if (j == null) return 0; if (j.mantissa !== undefined) return Number(BigInt(j.mantissa)) * 10 ** Number(j.exponent); if (j.bits !== undefined) return Number(BigInt(j.bits)) / 2 ** 64; return Number(j); };
const has = async (i, item) => !!(await at(i)).query.subtensorModule[item];
async function multi(i, item, keys) {
  return cached(`${hashes[i]}:${item}:${JSON.stringify(keys)}`, async () => {
    const a = await at(i);
    if (!a.query.subtensorModule[item]) return keys.map(() => null);
    return (await a.query.subtensorModule[item].multi(keys)).map((x) => x.toJSON());
  });
}
async function one(i, item, ...args) {
  return cached(`${hashes[i]}:${item}:${JSON.stringify(args)}`, async () => {
    const a = await at(i);
    if (!a.query.subtensorModule[item]) return null;
    return (await a.query.subtensorModule[item](...args)).toJSON();
  });
}
async function topNets(i) {
  return cached(`${hashes[i]}:topnets`, async () => {
    const ent = await (await at(i)).query.subtensorModule.subnetTAO.entries();
    return ent.map(([k, v]) => [k.args[0].toNumber(), Number(v.toBigInt())]).filter(([n]) => n !== 0).sort((a, b) => b[1] - a[1]).slice(0, 20).map((x) => x[0]);
  });
}
async function vps(i, pairs) {
  const [al, v2, v1, ep] = [await multi(i, "totalHotkeyAlpha", pairs), await multi(i, "totalHotkeySharesV2", pairs), await multi(i, "totalHotkeyShares", pairs), await multi(i, "alphaSharePoolEpoch", pairs)];
  return pairs.map((_, k) => { const sh = sf(v2[k]) || sf(v1[k]); const a = Number(al[k] ?? 0); return { v: sh > 0 ? a / sh : NaN, ep: Number(ep[k] ?? 0), stake: a }; });
}
async function price(i, n) { return Number(await one(i, "subnetTAO", n)) / Number(await one(i, "subnetAlphaIn", n)); }
async function validators(i, net) {
  const permits = (await one(i, "validatorPermit", net)) || [];
  const uids = permits.map((p, k) => (p ? k : -1)).filter((k) => k >= 0);
  return [...new Set((await multi(i, "keys", uids.map((u) => [net, u]))).map(String))];
}
const growth = (x, y) => (x && y && x.ep === y.ep && isFinite(x.v / y.v) && y.v > 0 ? x.v / y.v - 1 : null);
const pct = (x) => (x == null ? "n/a" : (x * 100).toFixed(2) + "%");
const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const out = [];
for (let w = 1; w <= WINDOWS; w++) {
  const S = w, E = w - 1, P = w + 1;
  const nets = (await topNets(S)).slice(0, N);
  const rows = [];
  for (const net of nets) {
    const hks = await validators(S, net);
    if (!hks.length) continue;
    const pairs = hks.map((h) => [h, net]);
    const [s, e, p] = [await vps(S, pairs), await vps(E, pairs), await vps(P, pairs)];
    const vals = hks.map((h, k) => ({ h, stake: s[k].stake, trail: growth(s[k], p[k]), fwd: growth(e[k], s[k]) })).filter((x) => x.stake >= MIN_STAKE && x.fwd != null);
    if (vals.length < 2) continue;
    const pick = vals.filter((x) => x.trail != null).sort((a, b) => b.trail - a.trail)[0] || null;
    const largest = [...vals].sort((a, b) => b.stake - a.stake)[0];
    const sorted = [...vals].sort((a, b) => a.fwd - b.fwd);
    const [p0, p1, pPrev] = [await price(S, net), await price(E, net), await price(P, net)];
    const pg = p1 / p0 - 1;
    const emis = Number(await one(S, "subnetAlphaOutEmission", net)) * p0; // TAO value of alpha emitted per block, at the start
    const r = { net, n: vals.length, picker: pick?.fwd ?? null, largest: largest.fwd, median: sorted[Math.floor(sorted.length / 2)].fwd, zeroPayers: vals.filter((x) => x.fwd < 1e-6).length, price: pg, trailPrice: p0 / pPrev - 1, emis };
    r.pickerTao = r.picker == null ? null : (1 + r.picker) * (1 + pg) - 1;
    r.largestTao = (1 + r.largest) * (1 + pg) - 1;
    rows.push(r);
    console.log(`w${w} sn${net} n=${r.n} picker ${pct(r.picker)} largest ${pct(r.largest)} median ${pct(r.median)} zero-payers ${r.zeroPayers} price ${pct(pg)} | TAO picker ${pct(r.pickerTao)} largest ${pct(r.largestTao)}`);
  }
  // root: BasketTwr over the top 8 root validators by stake at the start (exists only since the basket upgrade)
  let root = null;
  if (await has(S, "basketTwr")) {
    const rh = await validators(S, 0);
    const st = (await multi(S, "totalHotkeyAlpha", rh.map((h) => [h, 0]))).map(Number);
    const top = rh.map((h, k) => [h, st[k]]).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
    const t0 = (await multi(S, "basketTwr", top)).map(sf), t1 = (await multi(E, "basketTwr", top)).map(sf);
    root = mean(top.map((_, k) => (t0[k] > 0.5 && t1[k] > 0.5 ? t1[k] / t0[k] - 1 : null)));
  }
  const top3 = [...rows].sort((a, b) => b.emis - a.emis).slice(0, 3);
  const mom = top3.filter((r) => r.trailPrice >= 0);
  const withRoot = (legs) => (root == null ? null : mean([root, ...legs]));
  const sm = {
    window: w, block: head - w * 30 * DAY, subnets: rows.length,
    pickerAlpha: mean(rows.map((r) => r.picker)), largestAlpha: mean(rows.map((r) => r.largest)), medianAlpha: mean(rows.map((r) => r.median)),
    pickerBeatsLargest: `${rows.filter((r) => r.picker != null && r.picker > r.largest).length}/${rows.length}`,
    zeroPayers: rows.reduce((s, r) => s + r.zeroPayers, 0),
    a_root: root,
    b_rootTop3: withRoot(top3.map((r) => r.pickerTao)), b_top3Only: mean(top3.map((r) => r.pickerTao)),
    c_rootTop3Momentum: withRoot(mom.map((r) => r.pickerTao)), c_top3MomentumOnly: mom.length ? mean(mom.map((r) => r.pickerTao)) : 0,
    d_equalAll: mean(rows.map((r) => r.pickerTao)),
    top3: top3.map((r) => r.net).join(","), momentumKept: mom.map((r) => r.net).join(","),
  };
  out.push(sm);
  console.log("SUMMARY", JSON.stringify(Object.fromEntries(Object.entries(sm).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? pct(v) : v]))));
}
save();
fs.writeFileSync(new URL("./.backtest-result.json", import.meta.url), JSON.stringify(out, null, 1));
await api.disconnect();
