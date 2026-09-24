// Approximate USD values for the review, so a route's size and cost read in money as well as tokens.
// Display only: nothing the route does depends on these, and they are never treated as an on-chain
// fact. Read from Dexscreener (already allowed in the page's CSP for the board), the deepest pool
// quoting each token in USD, cached for a minute. Any failure just hides the figure.

import { CONFIG } from "./config.js";

const API = "https://api.dexscreener.com/latest/dex/tokens/";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TTL_MS = 60_000;
let cache = null;

async function deepestUsd(mint) {
  const res = await fetch(API + mint);
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  const pairs = ((await res.json()).pairs || []).filter((p) => p.chainId === "solana" && p.baseToken?.address === mint && Number(p.priceUsd) > 0);
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  if (!pairs.length) throw new Error("no priced pool");
  return Number(pairs[0].priceUsd);
}

/** { sol, tao, at } in USD, either price null if unavailable; null entirely if both fail. */
export async function usdPrices() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const [sol, tao] = await Promise.allSettled([deepestUsd(SOL_MINT), deepestUsd(CONFIG.taoMint)]);
  const out = { sol: sol.status === "fulfilled" ? sol.value : null, tao: tao.status === "fulfilled" ? tao.value : null, at: Date.now() };
  if (out.sol === null && out.tao === null) return null;
  cache = out;
  return out;
}

/** "$3.10", "$1,240", "under $0.01". */
export function fmtUsd(n) {
  if (!(n >= 0)) return "";
  if (n < 0.01) return "under $0.01";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });
}
