#!/usr/bin/env node
// How many routes has the stake page actually carried? Read from Solana, not from analytics (the page
// has none, by design). A route is a successful transaction that both pays soltao's fee to the fee
// wallet and calls the canonical TAO OFT program. Read-only.
//
//   node usage.mjs                  every route since the stake page existed
//   node usage.mjs --since 2026-10-01
//   node usage.mjs --rpc <url>      any RPC that keeps full address history
//   node usage.mjs --json
//
// The fee wallet had ~940 transactions before the stake page existed, so this starts at the page's
// launch and still filters by what a route looks like, not every inflow.
//
// It reads from Solana's public RPC by default, not the page's. PublicNode is not used here: on
// 25 Sep 2026 it returned only 8 signatures for the fee wallet and silently dropped the 23 Sep
// route. Helius is a free plan and the page's last-resort proxy; a full signature scan would burn
// the monthly credits, so this script does not use HELIUS_API_KEY unless you pass --rpc.
// A history that ends after --since, or a transaction the RPC cannot return, is an error, never a
// smaller count.

import { Connection, PublicKey } from "@solana/web3.js";
import { CONFIG } from "./src/config.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
// The stake page's fee wallet was set on 21 Sep 2026; nothing earlier can be a route.
const since = new Date(flag("--since") || "2026-09-21T00:00:00Z").getTime() / 1000;
const asJson = args.includes("--json");

const rpcUrl = flag("--rpc") || "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "confirmed");
const wallet = new PublicKey(CONFIG.fee.wallet);

// A version-1 transaction reached the fee wallet by 4 Oct 2026, and @solana/web3.js 1.x cannot parse one, even
// with a higher maxSupportedTransactionVersion. So transactions are read over plain JSON-RPC, already parsed.
async function getTransaction(signature) {
  const wait = (attempt) => new Promise((r) => setTimeout(r, 500 * 2 ** Math.min(attempt, 4)));
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }),
      });
    } catch (e) {
      if (attempt < 8) { await wait(attempt); continue; }
      throw e;
    }
    if (res.status === 429 && attempt < 8) { await wait(attempt); continue; }
    const body = await res.json();
    if (body.error) throw new Error(`getTransaction ${signature}: ${body.error.message}`);
    return body.result;
  }
}
// The route fee was a flat 0.0075 SOL at launch, then 0.003 SOL; since 29 Sep 2026 it is 0.25% of the TAO
// sent, at least 0.0035 SOL. So a fee is any transfer to the wallet of at least the smallest of those.
const MIN_FEE = 3_000_000;

async function main() {
const candidates = [];
let oldest = Infinity;
for (let before; ;) {
  const page = await connection.getSignaturesForAddress(wallet, { limit: 1000, before });
  if (!page.length) break;
  oldest = Math.min(oldest, page.at(-1).blockTime ?? Infinity);
  for (const s of page) if (!s.err && (s.blockTime ?? 0) >= since) candidates.push(s);
  if ((page.at(-1).blockTime ?? 0) < since || page.length < 1000) break;
  before = page.at(-1).signature;
}
// The wallet's history reaches back before the stake page, so an end after --since means the RPC cut it.
if (oldest >= since) {
  console.error(`The RPC's history for the fee wallet ends at ${new Date(oldest * 1000).toISOString()}, after --since. It does not keep full history; pass --rpc with one that does.`);
  process.exitCode = 2;
  return;
}

const routes = [], missing = [];
for (const s of candidates) {
  const tx = await getTransaction(s.signature);
  if (!tx) { missing.push(s.signature); continue; }
  const fee = tx.transaction.message.instructions.find((i) => i.parsed?.type === "transfer" && i.parsed.info.destination === CONFIG.fee.wallet && i.parsed.info.lamports >= MIN_FEE);
  const bridged = tx.transaction.message.accountKeys.some((k) => k.pubkey === CONFIG.taoOftProgram);
  if (fee && bridged) routes.push({ at: new Date(s.blockTime * 1000).toISOString(), signature: s.signature, from: fee.parsed.info.source, feeLamports: fee.parsed.info.lamports });
}
if (missing.length) {
  console.error(`The RPC could not return ${missing.length} transaction(s), so the count would be short: ${missing.join(", ")}`);
  process.exitCode = 2;
  return;
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
}

await main();
