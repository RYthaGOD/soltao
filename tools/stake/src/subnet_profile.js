// The numbers behind a subnet's profile, kept pure so they can be tested without a browser or a chain:
// its price history over a chosen range with today's live price on the end, the change over that range,
// where it stands for deregistration, and the geometry of its price chart. app.js draws them.

export const DAY_S = 86_400;
export const BLOCK_S = 12;

/** History points ([unixSeconds, priceRao, ...]) inside the last `days`, then the live price as of `now`. */
export function rangeSeries(points, { days, nowSec, livePriceRao = null }) {
  const from = nowSec - days * DAY_S;
  const series = points.filter((p) => p[0] >= from).map((p) => ({ t: p[0], price: p[1] }));
  if (livePriceRao !== null && (!series.length || nowSec > series[series.length - 1].t)) series.push({ t: nowSec, price: Number(livePriceRao), live: true });
  return series;
}

/** Signed change from `a` to `b`, in basis points (null when there is nothing to compare). */
export function changeBps(a, b) {
  if (!a || b === null || b === undefined) return null;
  return Math.round(((b - a) / a) * 10_000);
}

/** The price `days` ago: the history point nearest that time, if one lies within 36 hours of it. */
export function priceDaysAgo(points, days, nowSec) {
  const target = nowSec - days * DAY_S;
  let best = null;
  for (const p of points) if (!best || Math.abs(p[0] - target) < Math.abs(best[0] - target)) best = p;
  return best && Math.abs(best[0] - target) <= 1.5 * DAY_S ? best[1] : null; // a gap there: say nothing
}

/** Whether a range's first point is close enough to its start to call the change "over N days". */
export const coversRange = (series, days, nowSec) => series.length > 1 && series[0].t <= nowSec - days * DAY_S + 1.5 * DAY_S;

/** "28 Sep 2026" (or "28 Sep" without the year), in UTC. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function dateText(sec, { year = true } = {}) {
  const d = new Date(sec * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ""}`;
}

/**
 * Where a subnet stands for deregistration. When a new subnet registers at the cap, the chain removes the
 * non-immune subnet with the lowest moving price, the earliest-registered winning a tie (coinbase/root.rs
 * get_network_to_prune, subtensor c004ceb). `rows` are directory rows; root never counts.
 */
export function deregStanding(rows, netuid, { head, immunityBlocks }) {
  const me = rows.find((r) => r.netuid === netuid);
  if (!me || netuid === 0) return null;
  const immuneUntil = me.registeredAt + immunityBlocks;
  if (head < immuneUntil) return { immune: true, immuneUntilBlock: immuneUntil };
  const exposed = rows.filter((r) => r.netuid !== 0 && head >= r.registeredAt + immunityBlocks)
    .sort((a, b) => (a.movingPriceBits < b.movingPriceBits ? -1 : a.movingPriceBits > b.movingPriceBits ? 1 : a.registeredAt - b.registeredAt));
  return { immune: false, rank: exposed.findIndex((r) => r.netuid === netuid) + 1, of: exposed.length };
}

/** The calendar time of a block, from the current block and 12-second blocks: an estimate. */
export const blockTime = (block, head, nowSec) => nowSec - (head - block) * BLOCK_S;

/** Up to `count` round tick values covering [min, max]. */
export function niceTicks(min, max, count = 4) {
  if (!(max > min)) { const v = min || 1; return [v * 0.99, v, v * 1.01]; }
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) if (v >= min - step * 1e-9) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/**
 * Chart geometry for a price series in a `w` x `h` box: the line and area paths, each point's position,
 * y ticks (TAO) and x ticks (dates). The y range pads the data a little and is not forced to zero, so a
 * price's movement is readable; the ticks say where it sits.
 */
export function chartGeometry(series, { w, h, left = 58, right = 14, top = 12, bottom = 26 }) {
  const prices = series.map((p) => p.price / 1e9);
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = (hi - lo) * 0.08 || hi * 0.02 || 0.01;
  lo = Math.max(0, lo - pad); hi += pad;
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const xOf = (t) => left + (t1 === t0 ? (w - left - right) / 2 : ((t - t0) / (t1 - t0)) * (w - left - right));
  const yOf = (v) => top + (1 - (v - lo) / (hi - lo)) * (h - top - bottom);
  const pts = series.map((p, i) => ({ ...p, x: xOf(p.t), y: yOf(prices[i]) }));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const base = (h - bottom).toFixed(1);
  const area = pts.length > 1 ? `${line} L${pts[pts.length - 1].x.toFixed(1)} ${base} L${pts[0].x.toFixed(1)} ${base} Z` : "";
  const yTicks = niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi).map((v) => ({ v, y: yOf(v) }));
  // Dates: about one label per 110px, on whole days, never closer than the data allows.
  const n = Math.max(2, Math.min(5, Math.floor((w - left - right) / 110)));
  const xTicks = t1 === t0 ? [{ t: t0, x: xOf(t0) }] : Array.from({ length: n }, (_, i) => {
    const t = Math.round((t0 + ((t1 - t0) * i) / (n - 1)) / DAY_S) * DAY_S;
    return { t, x: xOf(Math.min(Math.max(t, t0), t1)) };
  });
  return { pts, line, area, yTicks, xTicks, lo, hi, plot: { left, right: w - right, top, bottom: h - bottom } };
}

/**
 * Where each subnet sits against the chain's emission midpoint (`EmissionBarRank`).
 * The chain sets that midpoint to the Nth-largest positive moving price: that subnet keeps half
 * of what its price alone would earn, those above keep more, and those below keep less.
 * A rank of 0 means the chain is not using rank mode, so nothing is marked.
 * Root and a zero moving price are left out. Ties break toward the lower subnet number.
 */
export function emissionStanding(rows, barRank) {
  const n = Number(barRank);
  if (!Number.isInteger(n) || n <= 0) return new Map();
  const priced = rows.filter((r) => r.netuid !== 0 && r.movingPriceBits > 0n)
    .sort((a, b) => (a.movingPriceBits < b.movingPriceBits ? 1 : a.movingPriceBits > b.movingPriceBits ? -1 : a.netuid - b.netuid));
  const out = new Map();
  priced.forEach((r, i) => {
    const rank = i + 1;
    out.set(r.netuid, { rank, side: rank < n ? "above" : rank === n ? "mid" : "below" });
  });
  return out;
}

/** The point nearest `x` (the crosshair snaps to it). */
export function nearestPoint(pts, x) {
  let best = pts[0];
  for (const p of pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  return best;
}
