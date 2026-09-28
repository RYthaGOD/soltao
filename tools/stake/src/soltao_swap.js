// Swap SOLTAO for canonical TAO in the user's own wallet, before the route, so someone holding SOLTAO
// can use this page without buying TAO somewhere else first. SOLTAO is the coin launched by the
// person who runs this page (disclosed in the footer and the README). The route itself never needs it.
//
// One Solana transaction, signed by the user's wallet, straight against the coin's one pool: a
// Raydium CPMM pool against canonical TAO. There's no aggregator and no soltao fee, and soltao keeps
// nothing. The pool address is pinned in CONFIG. Every other account is read from the pool's own
// state and checked, so a quote can only ever be for that pool.
//
// The math is Raydium's own, copied rather than recalled (raydium-io/raydium-cp-swap at 59fb845:
// curve/calculator.rs, curve/fees.rs, states/pool.rs, instructions/swap_base_input.rs), and the
// transfer tax is spl-token-2022's calculate_epoch_fee. The transaction must deliver the quote less
// the slippage allowance, or it fails as a whole and nothing moves.

import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2";
import { CONFIG } from "./config.js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const AUTH_SEED = "vault_and_lp_mint_auth_seed"; // lib.rs AUTH_SEED
const FEE_DENOMINATOR = 1_000_000n; // fees.rs FEE_RATE_DENOMINATOR_VALUE
const SWAP_BIT = 2; // states/pool.rs PoolStatusBitIndex: Deposit, Withdraw, Swap

// Anchor discriminators: the first 8 bytes of sha256("global:<ix>") and sha256("account:<Type>").
const disc = (s) => sha256(new TextEncoder().encode(s)).slice(0, 8);
export const SWAP_BASE_INPUT = disc("global:swap_base_input");
const POOL_STATE = disc("account:PoolState");
const AMM_CONFIG = disc("account:AmmConfig");
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const key = (data, o) => new PublicKey(data.subarray(o, o + 32));
const u64 = (data, o) => data.readBigUInt64LE(o);
const ceilDiv = (a, n, d) => (a * n + d - 1n) / d;
const floorDiv = (a, n, d) => (a * n) / d;

/** The wallet's associated token account for `mint` under `tokenProgram`. */
export function ata(owner, mint, tokenProgram) {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0];
}

/** Raydium's PoolState (637 bytes, repr(C, packed)), as far as a swap needs it. */
export function decodePool(data) {
  if (data.length !== 637 || !sameBytes(data.subarray(0, 8), POOL_STATE)) throw new Error("not a Raydium CPMM pool");
  return {
    ammConfig: key(data, 8), creator: key(data, 40), vault0: key(data, 72), vault1: key(data, 104),
    mint0: key(data, 168), mint1: key(data, 200), program0: key(data, 232), program1: key(data, 264), observation: key(data, 296),
    authBump: data[328], status: data[329], decimals0: data[331], decimals1: data[332],
    protocolFees0: u64(data, 341), protocolFees1: u64(data, 349), fundFees0: u64(data, 357), fundFees1: u64(data, 365),
    openTime: u64(data, 373), creatorFeeOn: data[389], enableCreatorFee: data[390] !== 0,
    creatorFees0: u64(data, 397), creatorFees1: u64(data, 405),
  };
}

/** Raydium's AmmConfig (236 bytes): the fee rates, in millionths. */
export function decodeAmmConfig(data) {
  if (data.length !== 236 || !sameBytes(data.subarray(0, 8), AMM_CONFIG)) throw new Error("not a Raydium CPMM config");
  return { tradeFeeRate: u64(data, 12), protocolFeeRate: u64(data, 20), fundFeeRate: u64(data, 28), creatorFeeRate: u64(data, 108) };
}

/** A token account's balance, or 0 if it is not `owner`'s account of `mint`. SPL Token and Token-2022 share this layout. */
export function tokenAmount(data, { mint, owner } = {}) {
  if (!data || data.length < 165) return 0n;
  if (mint && !key(data, 0).equals(new PublicKey(mint))) return 0n;
  if (owner && !key(data, 32).equals(new PublicKey(owner))) return 0n;
  return u64(data, 64);
}

// Token-2022 mint extensions this swap knows how to handle: TransferFeeConfig (1), MetadataPointer
// (18) and TokenMetadata (19), the set SOLTAO's mint carried on 28 Sep 2026. Anything else (a transfer
// hook, say, which needs accounts this transaction does not pass) switches the swap off.
const KNOWN_EXTENSIONS = new Set([1, 18, 19]);

/** SOLTAO's transfer tax from its mint account: { bps, max } for `epoch`, or none. */
export function decodeTransferFee(data, epoch) {
  if (data.length <= 166 || data[165] !== 1) throw new Error("not a Token-2022 mint with extensions");
  let fee = { bps: 0n, max: 0n };
  for (let o = 166; o + 4 <= data.length;) {
    const type = data.readUInt16LE(o), len = data.readUInt16LE(o + 2);
    if (type === 0 && len === 0) break; // zero padding
    if (!KNOWN_EXTENSIONS.has(type)) throw new Error(`SOLTAO's mint has an extension this page does not handle (${type})`);
    if (type === 1) {
      const d = data.subarray(o + 4, o + 4 + len);
      const older = { epoch: u64(d, 72), max: u64(d, 80), bps: BigInt(d.readUInt16LE(88)) };
      const newer = { epoch: u64(d, 90), max: u64(d, 98), bps: BigInt(d.readUInt16LE(106)) };
      const f = BigInt(epoch) >= newer.epoch ? newer : older;
      fee = { bps: f.bps, max: f.max };
    }
    o += 4 + len;
  }
  return fee;
}

/** spl-token-2022 TransferFee::calculate_fee: ceil(amount x bps / 10,000), capped at the maximum. */
export function transferFee({ bps, max }, amount) {
  if (bps === 0n || amount === 0n) return 0n;
  const raw = ceilDiv(amount, bps, 10_000n);
  return raw < max ? raw : max;
}

/**
 * What `amountIn` SOLTAO (6 decimals) swaps for, in TAO (9 decimals), at the state read in `s`.
 * `atSpot` is the whole amount at the pool's price before any fee, so `atSpot - out` is everything the
 * swap costs: SOLTAO's transfer tax, the pool's fees and price impact.
 */
export function quoteSwap(s, amountIn) {
  const a = BigInt(amountIn);
  if (a <= 0n) throw new Error("enter an amount above zero");
  const tax = transferFee(s.fee, a);
  const actualIn = a - tax;
  if (actualIn <= 0n) throw new Error("that is too small to swap");
  const { rIn, rOut } = s;
  const trade = s.config.tradeFeeRate, creator = s.pool.enableCreatorFee ? s.config.creatorFeeRate : 0n;
  let tradeFee, creatorFee = 0n, lessFees;
  if (s.creatorOnInput) {
    const total = ceilDiv(actualIn, trade + creator, FEE_DENOMINATOR);
    creatorFee = floorDiv(total, creator, trade + creator);
    tradeFee = total - creatorFee;
    lessFees = actualIn - total;
  } else {
    tradeFee = ceilDiv(actualIn, trade, FEE_DENOMINATOR);
    lessFees = actualIn - tradeFee;
  }
  const swapped = (lessFees * rOut) / (rIn + lessFees);
  if (!s.creatorOnInput) { creatorFee = ceilDiv(swapped, creator, FEE_DENOMINATOR); }
  const out = s.creatorOnInput ? swapped : swapped - creatorFee; // TAO is plain SPL Token: no tax on the way out
  if (out <= 0n) throw new Error("that is too small to swap");
  const atSpot = (a * rOut) / rIn;
  return { amountIn: a, tax, tradeFee, creatorFee, out, atSpot, costBps: atSpot > out ? ((atSpot - out) * 10_000n) / atSpot : 0n };
}

/** The least the swap may deliver: the quote less the allowance for other trades landing first. */
export const minimumOut = (out, bps = CONFIG.soltao.slippageBps) => (BigInt(out) * (10_000n - BigInt(bps))) / 10_000n;

/**
 * Checks a pool, its config, vaults and SOLTAO's mint, all as read together, and returns what a quote
 * and the transaction need. Throws on anything that is not the pinned SOLTAO/TAO pool, open for swaps.
 */
export function swapState({ poolAddress = CONFIG.soltao.pool, program = CONFIG.soltao.program, pool: poolInfo, config: configInfo, vault0: v0Info, vault1: v1Info, mint: mintInfo, epoch, now = Math.floor(Date.now() / 1000) }) {
  const prog = new PublicKey(program), soltao = new PublicKey(CONFIG.soltao.mint), taoMint = new PublicKey(CONFIG.taoMint);
  if (!poolInfo || !poolInfo.owner.equals(prog)) throw new Error("SOLTAO's pool was not found");
  const pool = decodePool(poolInfo.data);
  // Which side is which. The pool sorts its mints by address, so read it rather than assume it.
  const soltaoIs1 = pool.mint1.equals(soltao) && pool.mint0.equals(taoMint);
  const soltaoIs0 = pool.mint0.equals(soltao) && pool.mint1.equals(taoMint);
  if (!soltaoIs0 && !soltaoIs1) throw new Error("that pool is not SOLTAO against canonical TAO");
  const side = soltaoIs1
    ? { vaultIn: pool.vault1, vaultOut: pool.vault0, programIn: pool.program1, programOut: pool.program0, feesIn: pool.protocolFees1 + pool.fundFees1 + pool.creatorFees1, feesOut: pool.protocolFees0 + pool.fundFees0 + pool.creatorFees0, vInInfo: v1Info, vOutInfo: v0Info }
    : { vaultIn: pool.vault0, vaultOut: pool.vault1, programIn: pool.program0, programOut: pool.program1, feesIn: pool.protocolFees0 + pool.fundFees0 + pool.creatorFees0, feesOut: pool.protocolFees1 + pool.fundFees1 + pool.creatorFees1, vInInfo: v0Info, vOutInfo: v1Info };
  if (!side.programIn.equals(TOKEN_2022_PROGRAM) || !side.programOut.equals(TOKEN_PROGRAM)) throw new Error("SOLTAO's pool uses unexpected token programs");
  if (!mintInfo || !mintInfo.owner.equals(TOKEN_2022_PROGRAM)) throw new Error("SOLTAO's mint was not found");
  if ((pool.status >> SWAP_BIT) & 1) throw new Error("swaps are paused on SOLTAO's pool");
  if (BigInt(now) < pool.openTime) throw new Error("SOLTAO's pool is not open yet");
  if (pool.creatorFeeOn > 2) throw new Error("SOLTAO's pool has a fee model this page does not know");
  if (!configInfo || !configInfo.owner.equals(prog)) throw new Error("SOLTAO's pool config was not found");
  const config = decodeAmmConfig(configInfo.data);
  const [authority, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode(AUTH_SEED)], prog);
  if (bump !== pool.authBump) throw new Error("SOLTAO's pool authority does not match");
  const vIn = side.vInInfo, vOut = side.vOutInfo;
  if (!vIn || !vIn.owner.equals(TOKEN_2022_PROGRAM) || !vOut || !vOut.owner.equals(TOKEN_PROGRAM)) throw new Error("SOLTAO's pool vaults were not found");
  const vaultInAmount = tokenAmount(vIn.data, { mint: soltao, owner: authority });
  const vaultOutAmount = tokenAmount(vOut.data, { mint: taoMint, owner: authority });
  // states/pool.rs vault_amount_without_fee: the vaults also hold fees owed out, which do not trade.
  const rIn = vaultInAmount - side.feesIn, rOut = vaultOutAmount - side.feesOut;
  if (rIn <= 0n || rOut <= 0n) throw new Error("SOLTAO's pool is empty");
  // states/pool.rs is_creator_fee_on_input: BothToken, or the fee's own token being the input.
  const creatorOnInput = pool.creatorFeeOn === 0 || (pool.creatorFeeOn === 1 && soltaoIs0) || (pool.creatorFeeOn === 2 && soltaoIs1);
  return {
    poolAddress: new PublicKey(poolAddress), program: prog, authority, pool, config, fee: decodeTransferFee(mintInfo.data, epoch),
    vaultIn: side.vaultIn, vaultOut: side.vaultOut, rIn, rOut, creatorOnInput,
  };
}

/** Reads everything a quote needs from chain, in two rounds (the pool first, since it names the rest). */
export async function readSwapState(connection) {
  const poolAddress = new PublicKey(CONFIG.soltao.pool);
  const [pool, epochInfo] = await Promise.all([connection.getAccountInfo(poolAddress), connection.getEpochInfo()]);
  if (!pool) throw new Error("SOLTAO's pool was not found");
  const p = decodePool(pool.data);
  const [config, vault0, vault1, mint] = await connection.getMultipleAccountsInfo([p.ammConfig, p.vault0, p.vault1, new PublicKey(CONFIG.soltao.mint)]);
  return swapState({ pool, config, vault0, vault1, mint, epoch: epochInfo.epoch });
}

/** The wallet's SOLTAO (6 decimals), from its Token-2022 associated account. */
export async function getSoltaoBalance(connection, owner) {
  const info = await connection.getAccountInfo(ata(owner, CONFIG.soltao.mint, TOKEN_2022_PROGRAM));
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM)) return 0n;
  return tokenAmount(info.data, { mint: CONFIG.soltao.mint, owner });
}

/** Creates the wallet's TAO account if it has none; does nothing if it does. */
function createAtaIdempotent(payer, owner, mint, tokenProgram) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** swap_base_input(amount_in, minimum_amount_out), accounts in instructions/swap_base_input.rs order. */
export function swapInstruction(s, { user, amountIn, minOut }) {
  const owner = new PublicKey(user);
  const data = Buffer.alloc(24);
  data.set(SWAP_BASE_INPUT, 0);
  data.writeBigUInt64LE(BigInt(amountIn), 8);
  data.writeBigUInt64LE(BigInt(minOut), 16);
  return new TransactionInstruction({
    programId: s.program,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: s.authority, isSigner: false, isWritable: false },
      { pubkey: s.pool.ammConfig, isSigner: false, isWritable: false },
      { pubkey: s.poolAddress, isSigner: false, isWritable: true },
      { pubkey: ata(owner, CONFIG.soltao.mint, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
      { pubkey: ata(owner, CONFIG.taoMint, TOKEN_PROGRAM), isSigner: false, isWritable: true },
      { pubkey: s.vaultIn, isSigner: false, isWritable: true },
      { pubkey: s.vaultOut, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(CONFIG.soltao.mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(CONFIG.taoMint), isSigner: false, isWritable: false },
      { pubkey: s.pool.observation, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** The unsigned swap transaction: compute budget, the TAO account if missing, the swap. No soltao fee. */
export async function buildSwapTransaction(connection, s, { user, amountIn, minOut, priorityMicroLamports = 0n, computeUnits = CONFIG.soltao.computeUnits }) {
  const owner = new PublicKey(user);
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })];
  if (BigInt(priorityMicroLamports) > 0n) instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(priorityMicroLamports) }));
  instructions.push(createAtaIdempotent(owner, owner, CONFIG.taoMint, TOKEN_PROGRAM));
  instructions.push(swapInstruction(s, { user, amountIn, minOut }));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
}
