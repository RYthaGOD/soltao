// `npm run history`: daily price, pool and volume history for every subnet, read from a Bittensor
// archive node and written to stake/history/<netuid>.json for the subnet profiles' charts. The files are
// served from soltao's own origin (no API key, no CSP change, no runtime dependency on anyone's
// indexer), and the page adds one live point from the chain on top. Run it before a deploy; the page
// says how old the history is.
//
// A point is one block per day, on a fixed grid (multiples of 7,200), so reruns only read new days.
// Every read is cached in .history-cache.json (gitignored) and retried on the archive's rate limit.
// A netuid that was re-registered inside the window keeps only the points of its current subnet.
//
// Each file: { netuid, registeredAt, points: [[unixSeconds, priceRao, taoInTAO, alphaInAlpha,
// alphaOutAlpha, volumeDayTAO | null], ...] }, oldest first. Price is the pool's own ratio (TAO in ÷
// Alpha in), which is what swapRuntimeApi.currentAlphaPrice returned to the rao on 28 Sep 2026.
// Volume is the change in SubnetVolume over the day before the point: the TAO paid into the pool on
// buys plus the TAO paid out on sells (pallets/subtensor/src/staking/stake_utils.rs, c004ceb).

import fs from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";

const DAY = 7_200, DAYS = Number(process.env.DAYS || 90);
const ARCHIVE = process.env.ARCHIVE || "wss://archive.chain.opentensor.ai:443";
const OUT = new URL("../../stake/history/", import.meta.url);
const CACHE = new URL("./.history-cache.json", import.meta.url);
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The archive meters "historical work" and answers -32004 when a budget runs out; it refills with time.
// So a rate limit is waited out as long as it takes, while any other error gives up after a few tries.
async function retry(what, fn) {
  for (let attempt = 1, limited = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      const m = String(e?.message || e);
      const isLimit = /-32004|rate|429|limit|budget/i.test(m);
      if (!isLimit && attempt >= 6) throw new Error(`${what}: ${m}`);
      const wait = isLimit ? Math.min(120_000, 20_000 * ++limited) : 3_000 * attempt;
      console.log(`  ${what}: ${m.slice(0, 80)}; retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}
const PACE_MS = Number(process.env.PACE_MS || 1_500); // between days, to stay inside the budget

const api = await ApiPromise.create({ provider: new WsProvider(ARCHIVE), noInitWarn: true });
const head = (await api.rpc.chain.getFinalizedHead().then((h) => api.rpc.chain.getHeader(h))).number.toNumber();
const anchor = Math.floor(head / DAY) * DAY;
// One extra day at the start: the first point's volume is measured from it.
const blocks = Array.from({ length: DAYS + 2 }, (_, i) => anchor - (DAYS + 1 - i) * DAY);
console.log(`head ${head}, ${blocks.length} daily blocks from ${blocks[0]} to ${anchor}`);

const toMap = (entries) => Object.fromEntries(entries.map(([k, v]) => [Number(k.args[0].toString()), BigInt(v.toString())]));
// Where each netuid's current subnet starts: points before it belong to an earlier subnet.
const registered = toMap(await retry("registrations", () => api.query.subtensorModule.networkRegisteredAt.entries()));
const netuids = Object.keys(registered).map(Number).sort((a, b) => a - b);

// One storage read per day for every subnet's four values plus the time: explicit keys in a single
// state_queryStorageAt (queryMulti), which the rate-limited archive takes far better than four paged
// scans. Newest first, so an interrupted run still leaves the recent days a chart needs most.
const names = ["tao", "ain", "aout", "vol"];
for (const [i, b] of [...blocks.entries()].reverse()) {
  if (cache[b] || process.env.WRITE_ONLY) continue; // WRITE_ONLY=1: write the files from what is cached
  const t0 = Date.now();
  cache[b] = await retry(`block ${b}`, async () => {
    const at = await api.at(await api.rpc.chain.getBlockHash(b));
    const s = at.query.subtensorModule, maps = [s.subnetTAO, s.subnetAlphaIn, s.subnetAlphaOut, s.subnetVolume];
    const values = await at.queryMulti([at.query.timestamp.now, ...maps.flatMap((m) => netuids.map((n) => [m, n]))]);
    const out = { t: Math.floor(Number(values[0].toString()) / 1000) };
    names.forEach((name, j) => { out[name] = Object.fromEntries(netuids.map((n, k) => [n, values[1 + j * netuids.length + k].toString()])); });
    if (!out.t) throw new Error("no timestamp at that block");
    return out;
  });
  save();
  console.log(`  ${blocks.length - i}/${blocks.length} block ${b} (${new Date(cache[b].t * 1000).toISOString().slice(0, 10)}) in ${Date.now() - t0} ms`);
  await sleep(PACE_MS);
}

// ── validators' 30-day record ──────────────────────────────────────────────────
// For every hotkey holding a validator permit on each subnet today: what one share of its stake pool is
// worth now against 30 days ago, TotalHotkeyAlpha ÷ TotalHotkeyShares (V2 where set, else V1). Stake
// added or taken out mints or burns shares at the current value, so only what the validator paid its
// stakers moves it (the vault research, docs/vault-research-2026-09-28.md). A pool whose share epoch
// changed in the window was reset, so its figure is left out rather than guessed. Alpha terms: the
// subnet's own price move comes on top, and the profile's chart shows that.
const VALIDATOR_DAYS = 30, vKey = `validators:${anchor}`;
const safeFloat = (j) => { if (j == null) return 0; if (j.mantissa !== undefined) return Number(BigInt(j.mantissa)) * 10 ** Number(j.exponent); if (j.bits !== undefined) return Number(BigInt(j.bits)) / 2 ** 64; return Number(j); };
async function chunked(at, calls, size = 400) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    out.push(...await retry(`validator reads ${i}/${calls.length}`, () => at.queryMulti(calls.slice(i, i + size))));
    await sleep(PACE_MS);
  }
  return out;
}
if (!cache[vKey] && !process.env.WRITE_ONLY) {
  const [aNow, aThen] = await Promise.all([anchor, anchor - VALIDATOR_DAYS * DAY].map(async (b) => api.at(await retry(`hash ${b}`, () => api.rpc.chain.getBlockHash(b)))));
  const s = aNow.query.subtensorModule;
  const permits = await retry("permits", () => s.validatorPermit.entries());
  const slots = permits.flatMap(([k, v]) => { const n = Number(k.args[0].toString()); return n === 0 ? [] : v.toJSON().map((p, uid) => (p ? [n, uid] : null)).filter(Boolean); });
  const hotkeys = (await chunked(aNow, slots.map(([n, uid]) => [s.keys, [n, uid]]))).map(String);
  const pairs = slots.map(([n], i) => [hotkeys[i], n]);
  const values = async (at) => {
    const q = at.query.subtensorModule, items = ["totalHotkeyAlpha", "totalHotkeySharesV2", "totalHotkeyShares", "alphaSharePoolEpoch"].filter((k) => q[k]);
    const r = await chunked(at, pairs.flatMap((p) => items.map((k) => [q[k], p])));
    return pairs.map((_, i) => {
      const get = (k) => { const j = items.indexOf(k); return j < 0 ? null : r[i * items.length + j]; };
      const alpha = BigInt(get("totalHotkeyAlpha").toString());
      const shares = (get("totalHotkeySharesV2") ? safeFloat(get("totalHotkeySharesV2").toJSON()) : 0) || (get("totalHotkeyShares") ? safeFloat(get("totalHotkeyShares").toJSON()) : 0);
      return { alpha, value: shares > 0 ? Number(alpha) / shares : null, epoch: get("alphaSharePoolEpoch") ? Number(get("alphaSharePoolEpoch").toString()) : 0 };
    });
  };
  console.log(`  ${pairs.length} validator permits on ${new Set(pairs.map((p) => p[1])).size} subnets; reading their pools now and ${VALIDATOR_DAYS} days ago`);
  const [now, then] = [await values(aNow), await values(aThen)];
  const [tNow, tThen] = [await aNow.query.timestamp.now(), await aThen.query.timestamp.now()].map((t) => Math.floor(t.toNumber() / 1000));
  const subnets = {};
  pairs.forEach(([hotkey, n], i) => {
    const a = now[i], b = then[i];
    const bps = a.value && b.value && a.epoch === b.epoch ? Math.round((a.value / b.value - 1) * 10_000) : null;
    (subnets[n] ??= []).push([hotkey, bps, Number(a.alpha / 1_000_000_000n)]);
  });
  cache[vKey] = { from: tThen, to: tNow, days: VALIDATOR_DAYS, subnets };
  save();
}
await api.disconnect();

const whole = (rao, dp = 3) => Number(BigInt(rao) / 10n ** BigInt(9 - dp)) / 10 ** dp;
fs.mkdirSync(OUT, { recursive: true });
let files = 0;
// The directory's compact view: each subnet's last 31 daily prices, for its change columns and sparkline.
const summary = { lastTime: cache[anchor]?.t ?? null, prices: {} };
for (const [n, regAt] of Object.entries(registered)) {
  const netuid = Number(n);
  if (netuid === 0) continue; // root has no pool
  const points = [];
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i], c = cache[b], prev = cache[blocks[i - 1]];
    if (!c || b < Number(regAt)) continue; // a day not read yet, or before this subnet
    const tao = BigInt(c.tao[n] ?? 0), ain = BigInt(c.ain[n] ?? 0), aout = BigInt(c.aout[n] ?? 0);
    if (tao === 0n || ain === 0n) continue;
    const price = (tao * 1_000_000_000n) / ain;
    const volDay = prev && blocks[i - 1] >= Number(regAt) && prev.vol[n] !== undefined && c.vol[n] !== undefined ? BigInt(c.vol[n]) - BigInt(prev.vol[n]) : null;
    points.push([c.t, Number(price), whole(tao), whole(ain, 0), whole(aout, 0), volDay === null || volDay < 0n ? null : whole(volDay)]);
  }
  fs.writeFileSync(new URL(`${netuid}.json`, OUT), JSON.stringify({ netuid, registeredAt: Number(regAt), points }));
  summary.prices[netuid] = { registeredAt: Number(regAt), days: points.slice(-31).map((p) => [p[0], p[1]]) };
  files++;
}
fs.writeFileSync(new URL("summary.json", OUT), JSON.stringify(summary));
// validators/<netuid>.json: [hotkey, change in one share's value over the window in bps (null: its
// pool was reset), its stake in whole Alpha], biggest stake first.
const vr = cache[vKey];
if (vr) {
  fs.mkdirSync(new URL("validators/", OUT), { recursive: true });
  for (const [n, rows] of Object.entries(vr.subnets)) {
    fs.writeFileSync(new URL(`validators/${n}.json`, OUT), JSON.stringify({ netuid: Number(n), from: vr.from, to: vr.to, days: vr.days, validators: rows.sort((a, b) => b[2] - a[2]) }));
  }
  console.log(`wrote validator records for ${Object.keys(vr.subnets).length} subnets to stake/history/validators/`);
}
const missing = blocks.slice(1).filter((b) => !cache[b]).length;
if (missing) console.log(`  ${missing} of ${blocks.length - 1} days not read yet: run again to fill them`);
fs.writeFileSync(new URL("index.json", OUT), JSON.stringify({
  generatedAt: new Date().toISOString(), headBlock: head, lastBlock: anchor, lastTime: cache[anchor]?.t ?? null, days: DAYS, missingDays: missing,
  source: `${ARCHIVE}: SubnetTAO, SubnetAlphaIn, SubnetAlphaOut, SubnetVolume and Timestamp, one block per ${DAY} blocks`,
}));
console.log(`wrote ${files} subnet files to stake/history/`);
process.exit(0);
