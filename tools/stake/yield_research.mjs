// Read-only (vault research, 28 Sep 2026; docs/vault-research-2026-09-28.md): what staking actually paid on the top subnets, from archive chain state.
// Per validator hotkey: value of one alpha share = TotalHotkeyAlpha / TotalHotkeyShares(V2 or V1).
// Deposits and withdrawals issue or burn shares at the current value, so only earnings move it.
// TAO-terms return = share value ratio x pool price ratio (price = SubnetTAO / SubnetAlphaIn).
import { ApiPromise, WsProvider } from "@polkadot/api";
const api = await ApiPromise.create({ provider: new WsProvider("wss://archive.chain.opentensor.ai:443"), noInitWarn: true });
const q = api.query.subtensorModule;
const DAY = 7200;
const head = (await api.rpc.chain.getHeader()).number.toNumber();
const blocks = { now: head, d30: head - 30 * DAY, d90: head - 90 * DAY };
const at = {};
for (const [k, n] of Object.entries(blocks)) at[k] = await api.at(await api.rpc.chain.getBlockHash(n));
const ts = async (k) => new Date((await at[k].query.timestamp.now()).toNumber()).toISOString().slice(0, 10);
console.log("blocks", JSON.stringify(blocks), await ts("now"), await ts("d30"), await ts("d90"));

function sf(v) { // SafeFloat {mantissa, exponent}
  const j = v.toJSON(); if (!j || j.mantissa === undefined) return 0;
  return Number(BigInt(j.mantissa)) * 10 ** Number(j.exponent);
}
async function sharesAt(a, hk, n) {
  let v2 = 0;
  if (a.query.subtensorModule.totalHotkeySharesV2) v2 = sf(await a.query.subtensorModule.totalHotkeySharesV2(hk, n));
  if (v2 > 0) return v2;
  const v1 = await a.query.subtensorModule.totalHotkeyShares(hk, n);
  return Number(BigInt(v1.toJSON().bits ?? v1.toJSON())) / 2 ** 64;
}
async function epochAt(a, hk, n) { return a.query.subtensorModule.alphaSharePoolEpoch ? (await a.query.subtensorModule.alphaSharePoolEpoch(hk, n)).toNumber() : 0; }
async function price(a, n) {
  const t = Number((await a.query.subtensorModule.subnetTAO(n)).toBigInt());
  const al = Number((await a.query.subtensorModule.subnetAlphaIn(n)).toBigInt());
  return { p: n === 0 ? 1 : t / al, tao: t / 1e9 };
}

// top subnets by TAO in pool
const entries = await q.subnetTAO.entries();
const nets = entries.map(([k, v]) => [k.args[0].toNumber(), Number(v.toBigInt()) / 1e9]).filter(([n]) => n !== 0).sort((a, b) => b[1] - a[1]).slice(0, Number(process.argv[2] || 12));
const out = [];
for (const net of [0, ...nets.map((x) => x[0])]) {
  const permits = (await q.validatorPermit(net)).toJSON();
  const uids = permits.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const hks = (await q.keys.multi(uids.map((u) => [net, u]))).map(String);
  const alphas = (await q.totalHotkeyAlpha.multi(hks.map((h) => [h, net]))).map((x) => Number(x.toBigInt()));
  const top = hks.map((h, i) => [h, alphas[i]]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const pr = { now: await price(at.now, net), d30: await price(at.d30, net), d90: await price(at.d90, net) };
  for (const [hk, alpha] of top) {
    const row = { net, hk: hk.slice(0, 8), stake: alpha / 1e9, poolTao: pr.now.tao };
    const vps = {};
    let bad = false;
    for (const k of ["now", "d30", "d90"]) {
      const a = at[k];
      const al = Number((await a.query.subtensorModule.totalHotkeyAlpha(hk, net)).toBigInt());
      const sh = await sharesAt(a, hk, net);
      vps[k] = sh > 0 ? al / sh : NaN;
      row["ep_" + k] = await epochAt(a, hk, net);
    }
    for (const k of ["d30", "d90"]) {
      const days = k === "d30" ? 30 : 90;
      const same = row["ep_" + k] === row.ep_now;
      const g = vps.now / vps[k];
      const pg = pr.now.p / pr[k].p;
      row["alpha" + days] = same && isFinite(g) ? ((g - 1) * 100).toFixed(2) : "n/a";
      row["price" + days] = ((pg - 1) * 100).toFixed(2);
      row["tao" + days] = same && isFinite(g) ? ((g * pg - 1) * 100).toFixed(2) : "n/a";
      row["apyAlpha" + days] = same && isFinite(g) ? ((g ** (365 / days) - 1) * 100).toFixed(1) : "n/a";
    }
    out.push(row);
    console.log(JSON.stringify(row));
  }
}
await api.disconnect();
