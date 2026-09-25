#!/usr/bin/env node
// How many Chutes top-ups has the stake page carried? Read from Bittensor, not from analytics (the page
// has none, by design). Every top-up made through soltao carries the public tag in src/payments.js, so
// its extrinsic emits System.Remarked with SOLTAO_TAG_HASH. Read-only.
//
//   node chutes_usage.mjs --from 6500000     scan from that block (the first run needs a start)
//   node chutes_usage.mjs                    continue from where the last run stopped
//   node chutes_usage.mjs --to 6510000       stop at that block instead of the chain's head
//   node chutes_usage.mjs --json             machine-readable output
//   node chutes_usage.mjs --rpc https://…    another node (it must keep old blocks' state: an archive)
//
// Bittensor has no "find by event" call, so this reads every block's events. It keeps that cheap: the
// raw System.Events bytes of each block are fetched in batched JSON-RPC calls and searched for the tag
// hash's 32 bytes, and only a block that contains them is decoded. Progress and every top-up found are
// saved in .chutes-usage.json beside this file, so each run only reads blocks it has not read. About
// 7,200 blocks a day. Public nodes rate-limit (see HANDOVER, "Space out the live test runs"), so it
// paces itself and waits out a 429.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ApiPromise, HttpProvider } from "@polkadot/api";
import { SOLTAO_TAG, SOLTAO_TAG_HASH, CHUTES_MIN_RAO } from "./src/payments.js";
import { topupsInBlock, summarize } from "./src/topups.js";

for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.error(`chutes_usage: ${e?.message || e}`); process.exit(1); });

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const asJson = args.includes("--json");
const RPC = flag("--rpc") || "https://archive.chain.opentensor.ai";
const STATE = new URL("./.chutes-usage.json", import.meta.url);
const BATCH = 50; // blocks per JSON-RPC batch
const EVENTS_KEY = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7"; // twox128("System") ++ twox128("Events")
const NEEDLE = SOLTAO_TAG_HASH.slice(2).toLowerCase();
const log = (...m) => { if (!asJson) console.error(...m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
if (saved && saved.tag !== SOLTAO_TAG) throw new Error(`${STATE.pathname} was written for another tag; move it aside to start again`);

let rpcId = 0;
async function rpc(calls) {
  for (let attempt = 0; ; attempt++) {
    const body = calls.map(([method, params]) => ({ jsonrpc: "2.0", id: ++rpcId, method, params }));
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 8) throw new Error(`${RPC} kept refusing (${res.status})`);
      const wait = Number(res.headers.get("retry-after")) * 1000 || 15_000 * (attempt + 1);
      log(`  ${res.status} from the node, waiting ${Math.round(wait / 1000)} s`);
      await sleep(wait); continue;
    }
    if (!res.ok) throw new Error(`${RPC} answered ${res.status}`);
    const out = await res.json();
    const byId = new Map((Array.isArray(out) ? out : [out]).map((r) => [r.id, r]));
    return body.map((b) => {
      const r = byId.get(b.id);
      if (!r || r.error) throw new Error(`${b.method}: ${r?.error?.message || "no answer"}`);
      return r.result;
    });
  }
}

const [headHash] = await rpc([["chain_getFinalizedHead", []]]);
const [head] = await rpc([["chain_getHeader", [headHash]]]);
const to = Number(flag("--to") ?? parseInt(head.number, 16));
const from = flag("--from") !== null ? Number(flag("--from")) : saved ? saved.next : null;
if (from === null || !Number.isInteger(from) || from < 0) {
  console.error("The first run needs a start block: node chutes_usage.mjs --from <block>. Use the block \"Top up Chutes\" went live at; nothing earlier can be a top-up.");
  process.exit(2);
}
const found = new Map((saved?.topups ?? []).map((t) => [`${t.block}-${t.extrinsic}`, t]));

let api = null;
const decode = async (number, hash) => {
  api ??= await ApiPromise.create({ provider: new HttpProvider(RPC), noInitWarn: true });
  const at = await api.at(hash);
  const [records, now] = await Promise.all([at.query.system.events(), at.query.timestamp.now()]);
  const simple = records.map((r) => ({
    extrinsic: r.phase.isApplyExtrinsic ? r.phase.asApplyExtrinsic.toNumber() : null,
    section: r.event.section, method: r.event.method,
    data: r.event.data.map((d) => d.toString()),
  }));
  return topupsInBlock(simple, { block: number, at: new Date(now.toNumber()).toISOString(), tagHash: SOLTAO_TAG_HASH });
};

log(`Scanning blocks ${from}–${to} of ${RPC} for the soltao tag…`);
let next = from, lastSave = Date.now();
const save = () => writeFileSync(STATE, JSON.stringify({ tag: SOLTAO_TAG, next, topups: [...found.values()] }, null, 2));
try {
  while (next <= to) {
    const numbers = Array.from({ length: Math.min(BATCH, to - next + 1) }, (_, i) => next + i);
    const hashes = await rpc(numbers.map((n) => ["chain_getBlockHash", [n]]));
    const raw = await rpc(hashes.map((h) => ["state_getStorage", [EVENTS_KEY, h]]));
    for (let i = 0; i < numbers.length; i++) {
      if (raw[i] === null) throw new Error(`block ${numbers[i]}: the node no longer has its events (not an archive node?); use --rpc with an archive`);
      if (!raw[i].toLowerCase().includes(NEEDLE)) continue;
      for (const t of await decode(numbers[i], hashes[i])) {
        found.set(`${t.block}-${t.extrinsic}`, t);
        log(`  found: block ${t.block}, ${Number(t.amountRao) / 1e9} TAO to ${t.to.slice(0, 8)}…`);
      }
    }
    next = numbers.at(-1) + 1;
    if (Date.now() - lastSave > 10_000) { save(); lastSave = Date.now(); log(`  …at block ${next}`); }
  }
} finally {
  save();
  await api?.disconnect();
}

const s = summarize([...found.values()], { minRao: CHUTES_MIN_RAO });
if (asJson) {
  console.log(JSON.stringify({ tag: SOLTAO_TAG, tagHash: SOLTAO_TAG_HASH, scannedTo: next - 1, ...s }, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));
} else {
  console.log(`Chutes top-ups through soltao, scanned to block ${next - 1}: ${s.count} top-up(s), ${Number(s.totalRao) / 1e9} TAO, from ${s.payers} soltao wallet(s) to ${s.accounts} Chutes account(s)`);
  if (s.belowMin) console.log(`(${s.belowMin} of them under Chutes' 0.01 TAO minimum, which Chutes ignores; not counted in the total)`);
  if (s.failed) console.log(`(${s.failed} tagged transaction(s) did not complete; not counted)`);
  for (const t of s.list) console.log(`  ${t.at.slice(0, 16)}  block ${t.block}-${t.extrinsic}  ${Number(t.amountRao) / 1e9} TAO  ${t.from.slice(0, 6)}… → ${t.to.slice(0, 6)}…`);
}
