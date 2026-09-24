#!/usr/bin/env node
// How many routes has the stake page actually carried? Read from Solana, not from analytics (the page
// has none, by design). A route is a successful transaction that both pays soltao's fee to the fee
// wallet and calls the canonical TAO OFT program. Read-only.
//
//   node usage.mjs                  every route since the stake page existed
//   node usage.mjs --since 2026-10-01
//   node usage.mjs --json
//
// The fee wallet had ~940 transactions before the stake page existed and 11 after (24 Sep 2026), so
// this starts at the page's launch and still filters by what a route looks like, not every inflow.

import { Connection, PublicKey } from "@solana/web3.js";
import { CONFIG } from "./src/config.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
// The stake page's fee wallet was set on 21 Sep 2026; nothing earlier can be a route.
const since = new Date(flag("--since") || "2026-09-21T00:00:00Z").getTime() / 1000;
const asJson = args.includes("--json");

const connection = new Connection(CONFIG.solanaRpc, "confirmed");
const wallet = new PublicKey(CONFIG.fee.wallet);
const FEES = new Set([3_000_000, 7_500_000]); // today's 0.003 SOL, and the 0.0075 SOL it launched at

const candidates = [];
for (let before; ;) {
  const page = await connection.getSignaturesForAddress(wallet, { limit: 1000, before });
  if (!page.length) break;
  for (const s of page) if (!s.err && (s.blockTime ?? 0) >= since) candidates.push(s);
  if ((page.at(-1).blockTime ?? 0) < since || page.length < 1000) break;
  before = page.at(-1).signature;
}

const routes = [];
for (const s of candidates) {
  const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const fee = tx.transaction.message.instructions.find((i) => i.parsed?.type === "transfer" && i.parsed.info.destination === CONFIG.fee.wallet && FEES.has(i.parsed.info.lamports));
  const bridged = tx.transaction.message.accountKeys.some((k) => k.pubkey.toBase58() === CONFIG.taoOftProgram);
  if (fee && bridged) routes.push({ at: new Date(s.blockTime * 1000).toISOString(), signature: s.signature, from: fee.parsed.info.source, feeLamports: fee.parsed.info.lamports });
}

const wallets = new Set(routes.map((r) => r.from));
const feeSol = routes.reduce((a, r) => a + r.feeLamports, 0) / 1e9;
if (asJson) {
  console.log(JSON.stringify({ since: new Date(since * 1000).toISOString(), checked: candidates.length, routes, wallets: wallets.size, feeSol }, null, 2));
} else {
  console.log(`Stake routes since ${new Date(since * 1000).toISOString().slice(0, 10)}: ${routes.length} from ${wallets.size} wallet(s), ${feeSol} SOL in fees`);
  console.log(`(${candidates.length} fee-wallet transactions checked)`);
  for (const r of routes) console.log(`  ${r.at.slice(0, 16)}  ${r.from.slice(0, 6)}…  ${r.signature.slice(0, 16)}…`);
}
