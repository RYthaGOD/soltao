// The TAO/SOL price the route's fee is valued at: read straight from the deepest canonical TAO/SOL pool on
// Solana, an Orca Whirlpool (about $196k deep on 28 Sep 2026), over the page's own Solana RPC. No price
// feed and no API: the pool's own square-root price, the same number its swaps trade at.
//
// Whirlpool account layout (orca-so/whirlpools, programs/whirlpool/src/state/whirlpool.rs), checked on
// 28 Sep 2026 against the live pool: sqrt_price u128 (Q64.64) at 65, token_mint_a at 101, token_mint_b at
// 181. The price is token B per token A in raw units; wSOL and TAO both have 9 decimals.

import { PublicKey } from "@solana/web3.js";
import { CONFIG } from "./config.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const u128 = (d, o) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

/** The pool's state as far as pricing needs it; throws on anything that is not the pinned TAO/SOL pool. */
export function decodeWhirlpool(info) {
  if (!info || !info.owner.equals(new PublicKey(CONFIG.orca.program))) throw new Error("the TAO/SOL pool was not found");
  const d = info.data;
  if (d.length !== 653) throw new Error("the TAO/SOL pool's account has an unexpected size");
  const mintA = new PublicKey(d.subarray(101, 133)).toBase58(), mintB = new PublicKey(d.subarray(181, 213)).toBase58();
  const pair = new Set([mintA, mintB]);
  if (!pair.has(WSOL_MINT) || !pair.has(CONFIG.taoMint) || mintA === mintB) throw new Error("that pool is not canonical TAO against SOL");
  const sqrtPriceX64 = u128(d, 65);
  if (sqrtPriceX64 === 0n) throw new Error("the TAO/SOL pool has no price");
  return { mintA, mintB, sqrtPriceX64, tickSpacing: d.readUInt16LE(41), feeRate: d.readUInt16LE(45), tickCurrent: d.readInt32LE(81), vaultA: new PublicKey(d.subarray(133, 165)), vaultB: new PublicKey(d.subarray(213, 245)) };
}

/** Lamports per whole TAO at the pool's price. */
export function lamportsPerTao(pool) {
  const q = 1n << 128n, p2 = pool.sqrtPriceX64 * pool.sqrtPriceX64; // B per A = p2 / 2^128
  // A = wSOL, B = TAO: TAO per SOL = p2/2^128, so lamports per TAO = 1e9 * 2^128 / p2. Reversed if flipped.
  return pool.mintA === WSOL_MINT ? (1_000_000_000n * q) / p2 : (1_000_000_000n * p2) / q;
}

/** Reads the pool and returns lamports per TAO. */
export async function readLamportsPerTao(connection) {
  return lamportsPerTao(decodeWhirlpool(await connection.getAccountInfo(new PublicKey(CONFIG.orca.pool))));
}
