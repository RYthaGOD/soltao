// soltao's fee, one rule everywhere (Craig's decision, 28 Sep 2026): 0.25% of what an action moves.
//
//   - The route from Solana pays it in SOL, in the same Solana transaction as the bridge, never less than
//     0.0035 SOL. The TAO sent is valued in SOL at the on-chain price of the deepest TAO/SOL pool
//     (src/orca.js), read when the route is quoted; the fee is then fixed in the transaction the user signs.
//   - Actions on Bittensor (stake, unstake, Move, root claims, Chutes top-ups, the return to Solana) pay it
//     in TAO, from the user's coldkey to CONFIG.fee.bittensor, batched with the action in one
//     `utility.batchAll`: all or nothing, so a refused action pays nothing. Never less than 0.001 TAO.
//
// A $SOLTAO balance in the connected Solana wallet lowers that percentage and nothing else (Craig, 30 Sep
// 2026). 10 million or more takes 25% off, 50 million or more takes half. The floors stay. No balance,
// or a balance that could not be read, pays the full 0.25%. Callers that do not pass `offBps` charge
// the full fee, which is what every test and every resume of an already-signed action does.
//
// Every quote shows the fee before anything is signed.

import { CONFIG } from "./config.js";

const TEN_K = 10_000n;
const atLeast = (share, floor) => (share > floor ? share : floor);

/** The percentage after a holder cut, as a decimal string: "0.25", "0.1875", "0.125". */
export function feeRateText(cfg = CONFIG.fee) {
  const off = BigInt(cfg.offBps ?? 0);
  const kept = off <= 0n ? TEN_K : off >= TEN_K ? 0n : TEN_K - off;
  const micros = BigInt(cfg.bps) * kept; // percent, in millionths: 25 bps kept in full is 0.250000%
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * How much of the 0.25% a raw $SOLTAO balance takes off, in bps of the fee (2500 is 25% off, 5000 is
 * half). Whole tokens, highest matching tier. Zero when the balance is below every tier.
 */
export function holderOffBps(rawBalance, tiers = CONFIG.soltao.tiers) {
  const raw = BigInt(rawBalance ?? 0);
  const unit = 10n ** BigInt(CONFIG.soltao.decimals);
  let off = 0n;
  for (const t of tiers) {
    const cut = BigInt(t.offBps);
    if (raw >= BigInt(t.minTokens) * unit && cut > off) off = cut;
  }
  return off;
}

/** The fee config with a holder cut applied. `offBps` 0 is the full 0.25%. */
export function feeWithOff(offBps, base = CONFIG.fee) {
  return { ...base, offBps: BigInt(offBps ?? 0) };
}

/** The fee config for a raw $SOLTAO balance. Unread or zero pays the full fee. */
export const feeCfgFor = (rawBalance, base = CONFIG.fee) => feeWithOff(holderOffBps(rawBalance), base);

/** The percentage of `value` the fee takes, before the floor. The cut applies to this share only. */
function percentShare(value, cfg) {
  const gross = (BigInt(value) * BigInt(cfg.bps)) / TEN_K;
  const off = BigInt(cfg.offBps ?? 0);
  if (off <= 0n) return gross;
  const kept = off >= TEN_K ? 0n : TEN_K - off;
  return (gross * kept) / TEN_K;
}

/** The route's fee in lamports: bps of the TAO sent, valued in SOL, at least the SOL floor. */
export function routeFeeLamports(taoRao, lamportsPerTao, cfg = CONFIG.fee) {
  const value = (BigInt(taoRao) * BigInt(lamportsPerTao)) / 1_000_000_000n; // TAO has 9 decimals, SOL 9
  return atLeast(percentShare(value, cfg), BigInt(cfg.minLamports));
}

/** A Bittensor action's fee in rao: bps of the TAO it moves (or its TAO value), at least the TAO floor. */
export function actionFeeRao(valueRao, cfg = CONFIG.fee) {
  const v = BigInt(valueRao);
  if (v <= 0n) return BigInt(cfg.minRao);
  return atLeast(percentShare(v, cfg), BigInt(cfg.minRao));
}

/**
 * "0.25%, at least 0.0035 SOL", or with a holder cut
 * "0.1875%, 25% off the 0.25%, at least 0.0035 SOL". The floor figure never changes.
 */
export const feeRuleText = (unit, cfg = CONFIG.fee) => {
  const floor = unit === "SOL" ? Number(cfg.minLamports) / 1e9 : Number(cfg.minRao) / 1e9;
  const off = BigInt(cfg.offBps ?? 0);
  const cut = off > 0n ? `, ${Number(off) / 100}% off the ${Number(cfg.bps) / 100}%` : "";
  return `${feeRateText(cfg)}%${cut}, at least ${floor} ${unit}`;
};
