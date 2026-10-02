// The arithmetic behind a subnet profile (src/subnet_profile.js): ranges, changes, where a subnet stands
// for deregistration, and the chart's geometry. Offline; the numbers are made up to be checkable by hand.

import { rangeSeries, changeBps, priceDaysAgo, coversRange, dateText, deregStanding, blockTime, niceTicks, chartGeometry, nearestPoint, emissionStanding, DAY_S } from "../src/subnet_profile.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

const now = 1_800_000_000;
// 91 daily points ending a day before now: the price climbs 1% a day from 0.01 TAO.
const points = Array.from({ length: 91 }, (_, i) => [now - (91 - i) * DAY_S, Math.round(10_000_000 * 1.01 ** i), 1000, 0, 0, 5]);

{
  const s = rangeSeries(points, { days: 7, nowSec: now, livePriceRao: 12_345_678n });
  // Days 7 to 1 before now (the start day included, so the change spans the whole week), then live.
  expect("a 7-day range keeps the days inside it, then the live price", s.length === 8 && s[0].t === now - 7 * DAY_S && s[s.length - 1].live && s[s.length - 1].price === 12_345_678, String(s.length));
  expect("…in time order", s.every((p, i) => !i || p.t > s[i - 1].t));
  expect("without a live price, only history", rangeSeries(points, { days: 30, nowSec: now }).length === 30);
  expect("no history at all still gives the live point", rangeSeries([], { days: 30, nowSec: now, livePriceRao: 5n }).length === 1);
}

{
  expect("change is in basis points, signed", changeBps(100, 110) === 1000 && changeBps(100, 95) === -500 && changeBps(100, 100) === 0);
  expect("no base, no change", changeBps(0, 5) === null && changeBps(null, 5) === null);
  const p30 = priceDaysAgo(points, 30, now);
  expect("the price 30 days ago is the day-30 point", p30 === points[61][1], `${p30} vs ${points[61][1]}`);
  expect("a history shorter than the ask gives nothing rather than a wrong base", priceDaysAgo(points.slice(-10), 30, now) === null);
  const gappy = [...points.slice(0, 40), ...points.slice(-4)]; // days 91..52 ago, then the last four
  expect("a gap where the base should be gives nothing, not the next day along", priceDaysAgo(gappy, 30, now) === null && priceDaysAgo(gappy, 90, now) === points[1][1]);
  expect("a range whose data starts late is not called the full range", !coversRange(rangeSeries(gappy, { days: 30, nowSec: now, livePriceRao: 1n }), 30, now) && coversRange(rangeSeries(points, { days: 30, nowSec: now, livePriceRao: 1n }), 30, now));
  expect("dates read like 28 Sep 2026, in UTC", dateText(Date.UTC(2026, 8, 28, 23, 59) / 1000) === "28 Sep 2026" && dateText(Date.UTC(2026, 0, 1) / 1000, { year: false }) === "1 Jan");
}

{
  // head 1,000,000; immunity 100,000. Subnet 3 registered recently (immune); 1, 2 and 4 are exposed.
  const rows = [
    { netuid: 0, registeredAt: 0, movingPriceBits: 0n },
    { netuid: 1, registeredAt: 10, movingPriceBits: 500n },
    { netuid: 2, registeredAt: 20, movingPriceBits: 100n },
    { netuid: 3, registeredAt: 950_000, movingPriceBits: 1n },
    { netuid: 4, registeredAt: 5, movingPriceBits: 100n },
  ];
  const chain = { head: 1_000_000, immunityBlocks: 100_000 };
  const d3 = deregStanding(rows, 3, chain);
  expect("a subnet inside its immunity period is protected, until registration plus the period", d3.immune && d3.immuneUntilBlock === 1_050_000);
  const d4 = deregStanding(rows, 4, chain), d2 = deregStanding(rows, 2, chain), d1 = deregStanding(rows, 1, chain);
  expect("the lowest moving price goes first; a tie goes to the earlier registration", d4.rank === 1 && d2.rank === 2 && d1.rank === 3 && d1.of === 3, JSON.stringify([d4, d2, d1]));
  expect("root and immune subnets are never counted", d1.of === 3);
  expect("root has no standing", deregStanding(rows, 0, chain) === null);
  expect("a block's time counts back 12 seconds a block", blockTime(900, 1_000, now) === now - 1_200);
}

{
  const t = niceTicks(0.0123, 0.0187, 4);
  expect("ticks are round and inside the range", t.length >= 3 && t.every((v) => v >= 0.0123 && v <= 0.0187) && t.every((v) => Number(v.toFixed(4)) === v), t.join(", "));
  expect("a flat range still gets ticks", niceTicks(0.05, 0.05).length === 3);
  const series = rangeSeries(points, { days: 30, nowSec: now, livePriceRao: 25_000_000n });
  const g = chartGeometry(series, { w: 600, h: 200 });
  expect("the line starts at the left edge of the plot and ends at the right", g.pts[0].x === g.plot.left && Math.abs(g.pts[g.pts.length - 1].x - g.plot.right) < 1e-9);
  expect("a higher price sits higher on the chart", g.pts[g.pts.length - 1].y < g.pts[0].y);
  expect("every point is inside the plot", g.pts.every((p) => p.y >= g.plot.top && p.y <= g.plot.bottom));
  expect("the line and area paths start where they should", g.line.startsWith(`M${g.pts[0].x.toFixed(1)}`) && g.area.endsWith("Z"));
  expect("date ticks sit inside the plot", g.xTicks.every((x) => x.x >= g.plot.left && x.x <= g.plot.right));
  expect("the crosshair snaps to the nearest point", nearestPoint(g.pts, g.pts[5].x + 1).t === g.pts[5].t);
  const one = chartGeometry([{ t: now, price: 1e7 }], { w: 600, h: 200 });
  expect("a single point is drawn in the middle, with no area", Math.abs(one.pts[0].x - (58 + (600 - 58 - 14) / 2)) < 1e-9 && one.area === "");
}

{
  const rows = [
    { netuid: 0, movingPriceBits: 99n },
    { netuid: 1, movingPriceBits: 10n },
    { netuid: 2, movingPriceBits: 30n },
    { netuid: 3, movingPriceBits: 20n },
    { netuid: 4, movingPriceBits: 0n },
  ];
  const s = emissionStanding(rows, 2);
  expect("rank 2 is the emission midpoint, a higher moving price sits above it, and a lower one sits past it", s.get(2)?.side === "above" && s.get(2)?.rank === 1 && s.get(3)?.side === "mid" && s.get(3)?.rank === 2 && s.get(1)?.side === "below" && s.get(1)?.rank === 3 && !s.has(0) && !s.has(4));
  expect("a rank of 0 marks nothing", emissionStanding(rows, 0).size === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
