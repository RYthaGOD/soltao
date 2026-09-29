// soltao's fee, one rule everywhere (Craig's decision, 28 Sep 2026): 0.25% of what an action moves.
//
//   - The route from Solana pays it in SOL, in the same Solana transaction as the bridge, never less than
//     0.0035 SOL. The TAO sent is valued in SOL at the on-chain price of the deepest TAO/SOL pool
//     (src/orca.js), read when the route is quoted; the fee is then fixed in the transaction the user signs.
//   - Actions on Bittensor (stake, unstake, Move, root claims, Chutes top-ups, the return to Solana) pay it
//     in TAO, from the user's coldkey to CONFIG.fee.bittensor, batched with the action in one
//     `utility.batchAll`: all or nothing, so a refused action pays nothing. Never less than 0.001 TAO.
//
// Every quote shows the fee before anything is signed.

import { CONFIG } from "./config.js";

const TEN_K = 10_000n;
const atLeast = (share, floor) => (share > floor ? share : floor);

/** The route's fee in lamports: bps of the TAO sent, valued in SOL, at least the SOL floor. */
export function routeFeeLamports(taoRao, lamportsPerTao, cfg = CONFIG.fee) {
  const value = (BigInt(taoRao) * BigInt(lamportsPerTao)) / 1_000_000_000n; // TAO has 9 decimals, SOL 9
  return atLeast((value * BigInt(cfg.bps)) / TEN_K, BigInt(cfg.minLamports));
}

/** A Bittensor action's fee in rao: bps of the TAO it moves (or its TAO value), at least the TAO floor. */
export function actionFeeRao(valueRao, cfg = CONFIG.fee) {
  const v = BigInt(valueRao);
  if (v <= 0n) return BigInt(cfg.minRao);
  return atLeast((v * BigInt(cfg.bps)) / TEN_K, BigInt(cfg.minRao));
}

/** "0.25%, at least 0.0035 SOL" or "0.25%, at least 0.001 TAO", for the page's copy. */
export const feeRuleText = (unit, cfg = CONFIG.fee) =>
  `${Number(cfg.bps) / 100}%, at least ${unit === "SOL" ? Number(cfg.minLamports) / 1e9 : Number(cfg.minRao) / 1e9} ${unit}`;
