#!/usr/bin/env node
// Read-only fee-paying Solana OFT sends. This cannot prove Bittensor delivery or staking.
// Uses the public RPC unless --rpc is supplied; never consumes HELIUS_API_KEY implicitly.

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { base58 } from "@scure/base";
import { CONFIG } from "./src/config.js";

const DEFAULT_SINCE = "2026-09-21T00:00:00Z";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
// The smallest historical route fee (the current fee floor is higher).
const MIN_FEE = 3_000_000;
// From the pinned OFT SDK's generated oft302/instructions/send.ts (also used by oft202).
const SEND_DISCRIMINATOR = [102, 251, 20, 187, 65, 75, 12, 69];

export function usageOptions(args) {
  const { values } = parseArgs({ args, options: {
    since: { type: "string", default: DEFAULT_SINCE },
    rpc: { type: "string", default: DEFAULT_RPC },
    json: { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "10000" },
    "max-duration-ms": { type: "string", default: "300000" },
  } });
  const date = new Date(values.since);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(values.since)
      || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== values.since.slice(0, 10)) {
    throw new Error("--since must be a valid YYYY-MM-DD date or UTC ISO timestamp ending in Z");
  }
  let url;
  try { url = new URL(values.rpc); } catch { throw new Error("--rpc must be an HTTP(S) URL"); }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("--rpc must be an HTTP(S) URL");
  const milliseconds = (name) => {
    const value = Number(values[name]);
    if (!/^\d+$/.test(values[name]) || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new Error(`--${name} must be a positive integer below 2147483648`);
    }
    return value;
  };
  return { since: date.getTime() / 1000, rpcUrl: url.href, asJson: values.json,
    timeoutMs: milliseconds("timeout-ms"), maxDurationMs: milliseconds("max-duration-ms") };
}

export function createUsageRpc(rpcUrl, {
  timeoutMs = 10_000, signal, fetchImpl = fetch, wait = sleep, onProgress = () => {},
} = {}) {
  let id = 0;
  return async (method, params) => {
    const requestId = ++id;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) throw new Error("Usage scan exceeded its time budget; no count was produced");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let reason, retryable = false, retryMs = 500 * 2 ** attempt;
      try {
        const res = await fetchImpl(rpcUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        });
        if (!res.ok) {
          reason = `HTTP ${res.status}`;
          retryable = res.status === 429 || res.status >= 500;
          const retryAfter = res.headers.get("retry-after");
          if (retryAfter) {
            const delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
            if (Number.isFinite(delay)) retryMs = Math.max(retryMs, delay);
            if (retryMs > 2_147_483_647) retryable = false;
          }
          await res.body?.cancel();
        } else {
          const body = await res.json();
          if (body?.jsonrpc !== "2.0" || body.id !== requestId) {
            reason = "invalid JSON-RPC response";
          } else if (body.error) {
            // Provider error text can contain the authenticated URL; report only its code.
            reason = `RPC error ${body.error.code}`;
            retryable = body.error.code === -32005 || body.error.code === 429;
          } else if (!Object.hasOwn(body, "result")) {
            reason = "JSON-RPC response has no result";
          } else {
            return body.result;
          }
        }
      } catch (error) {
        if (signal?.aborted) throw new Error("Usage scan exceeded its time budget; no count was produced");
        reason = controller.signal.aborted ? `request timed out after ${timeoutMs} ms`
          : error instanceof SyntaxError ? "invalid JSON response" : "network request failed";
        retryable = !(error instanceof SyntaxError);
      } finally {
        clearTimeout(timer);
      }
      if (!retryable || attempt === 2) throw new Error(`${method}: ${reason}; no count was produced`);
      onProgress(`${method}: ${reason}; retry ${attempt + 1}/2 in ${retryMs} ms`);
      try { await wait(retryMs, undefined, { signal }); }
      catch { throw new Error("Usage scan exceeded its time budget; no count was produced"); }
    }
  };
}

export function routeFromTransaction(tx, signature, blockTime) {
  if (!tx?.meta || tx.meta.err === undefined || !Array.isArray(tx.transaction?.message?.instructions)) {
    throw new Error(`Missing transaction metadata or instructions for ${signature}; no count was produced`);
  }
  if (tx.meta.err !== null) return null;
  // The page sends directly. A CPI listed in innerInstructions can fail while its caller succeeds.
  const instructions = tx.transaction.message.instructions;
  const fee = instructions.find((i) => i.programId === SYSTEM_PROGRAM && i.parsed?.type === "transfer"
    && i.parsed.info?.destination === CONFIG.fee.wallet && typeof i.parsed.info.source === "string"
    && Number.isSafeInteger(i.parsed.info.lamports) && i.parsed.info.lamports >= MIN_FEE);
  const sent = instructions.some((i) => {
    if (i.programId !== CONFIG.taoOftProgram) return false;
    let data;
    try { data = base58.decode(i.data); }
    catch { throw new Error(`Invalid OFT instruction data for ${signature}; no count was produced`); }
    return SEND_DISCRIMINATOR.every((byte, index) => data[index] === byte);
  });
  return fee && sent ? { at: new Date(blockTime * 1000).toISOString(), signature,
    from: fee.parsed.info.source, feeLamports: fee.parsed.info.lamports } : null;
}

export async function readUsage({ rpc, since, onProgress = () => {} }) {
  if (!Number.isFinite(since)) throw new Error("A valid --since date is required");
  const candidates = [], seen = new Set();
  let oldest = null, covered = false, before;
  for (let pageNumber = 1; !covered; pageNumber++) {
    onProgress(`Reading signature page ${pageNumber}...`);
    const page = await rpc("getSignaturesForAddress", [CONFIG.fee.wallet, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }]);
    if (!Array.isArray(page)) throw new Error("Invalid signature history; no count was produced");
    if (!page.length) break;
    for (const s of page) {
      if (typeof s.signature !== "string" || !s.signature || seen.has(s.signature)) {
        throw new Error("RPC returned invalid or repeated signatures; no count was produced");
      }
      seen.add(s.signature);
      // Unknown timestamps cannot silently drop transactions or establish the coverage boundary.
      if (!Number.isFinite(s.blockTime) || s.err === undefined) {
        throw new Error(`Missing timestamp or status for ${s.signature}; no count was produced`);
      }
      oldest = oldest === null ? s.blockTime : Math.min(oldest, s.blockTime);
      if (s.blockTime < since) { covered = true; break; }
      if (s.err === null) candidates.push(s);
    }
    before = page.at(-1).signature;
  }
  // This wallet predates launch. Without an older signature, the requested window is unverified.
  if (!covered) {
    const end = oldest === null ? "returned no signatures" : `ends at ${new Date(oldest * 1000).toISOString()}`;
    throw new Error(`The RPC's fee-wallet history ${end}, without reaching before --since. Pass --rpc with full history; no count was produced`);
  }

  const routes = [];
  for (const [index, s] of candidates.entries()) {
    if (index % 10 === 0) onProgress(`Checking transaction ${index + 1}/${candidates.length}...`);
    // Raw JSON-RPC preserves support for version 1, which web3.js 1.x cannot decode.
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    if (!tx) throw new Error(`The RPC could not return transaction ${s.signature}; no count was produced`);
    const route = routeFromTransaction(tx, s.signature, s.blockTime);
    if (route) routes.push(route);
  }
  return {
    metric: "solana_oft_submissions", since: new Date(since * 1000).toISOString(),
    historyReached: new Date(oldest * 1000).toISOString(), checked: candidates.length,
    routes, wallets: new Set(routes.map((r) => r.from)).size,
    feeSol: routes.reduce((sum, r) => sum + r.feeLamports, 0) / 1e9,
    limitation: "Fee-paying Solana OFT sends only; Bittensor delivery and staking completion are not verified. Wallets are not unique people.",
  };
}

async function main() {
  try {
    const { rpcUrl, since, asJson, timeoutMs, maxDurationMs } = usageOptions(process.argv.slice(2));
    const signal = AbortSignal.timeout(maxDurationMs);
    const onProgress = (message) => console.error(message);
    const rpc = createUsageRpc(rpcUrl, { timeoutMs, signal, onProgress });
    const report = await readUsage({ rpc, since, onProgress });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Solana OFT submissions since ${report.since}: ${report.routes.length} from ${report.wallets} wallet(s), ${report.feeSol} SOL in fees`);
      console.log(`(${report.checked} fee-wallet transactions checked; history reaches ${report.historyReached})`);
      console.log(report.limitation);
      for (const r of report.routes) console.log(`  ${r.at.slice(0, 16)}  ${r.from.slice(0, 6)}...  ${r.signature.slice(0, 16)}...`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
