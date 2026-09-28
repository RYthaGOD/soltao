// Offline checks of the SOLTAO → TAO swap (src/soltao_swap.js), against the pool's real accounts as
// captured from mainnet (test/fixtures/soltao_pool.json) and the TAO a real holder's swap delivered in
// simulation from that same state. The live counterpart is test/soltao_swap_live.test.mjs.

import { readFileSync } from "node:fs";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { CONFIG } from "../src/config.js";
import {
  SWAP_BASE_INPUT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ata, decodePool, decodeTransferFee, transferFee, tokenAmount,
  swapState, quoteSwap, minimumOut, swapInstruction, buildSwapTransaction,
} from "../src/soltao_swap.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const fx = JSON.parse(readFileSync(new URL("./fixtures/soltao_pool.json", import.meta.url), "utf8"));
const acct = (a) => ({ owner: new PublicKey(a.owner), data: Buffer.from(a.data, "base64") });
const fixture = () => Object.fromEntries(Object.entries(fx.accounts).map(([k, v]) => [k, acct(v)]));
const stateFrom = (over = {}) => { const a = fixture(); return swapState({ ...a, epoch: fx.epoch, now: 1_800_000_000, ...over(a) }); };
const base = stateFrom(() => ({}));
// With one byte of the pool (or mint) changed: offset, value.
const patched = (which, offset, value) => stateFrom((a) => { a[which].data[offset] = value; return a; });

// The instruction and the accounts, against what a real swap on this pool used on 28 Sep 2026
// (an inner swap_base_input in a mainnet transaction, decoded by hand).
expect("swap_base_input's discriminator is the one seen on mainnet", Buffer.from(SWAP_BASE_INPUT).equals(Buffer.from([143, 190, 90, 218, 196, 30, 51, 222])));
expect("the pool's authority is Raydium's PDA seen on mainnet", base.authority.toBase58() === "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL");
expect("the pool's config is the one seen on mainnet", base.pool.ammConfig.toBase58() === "CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ");
expect("SOLTAO goes in through its vault, TAO comes out of its", base.vaultIn.toBase58() === "BUNsWJw83DopE4hrx3KC1TfquRrWY6UdjDiRTBMTt2KR" && base.vaultOut.toBase58() === "CgYZ1a7AYR8kTqBUYCdvvDVEZAMxPy3ugtCd1h9Vp4S");
expect("the observation account is the one seen on mainnet", base.pool.observation.toBase58() === "E3CCyMHiaBs5jrmkp1kRuBmS2oEb1v5sBBfqQcn9Nfb8");
expect("fees read as 0.25% trade and 1% creator, the creator's taken from the TAO side", base.config.tradeFeeRate === 2500n && base.config.creatorFeeRate === 10000n && base.creatorOnInput === false);
expect("SOLTAO's transfer tax reads as 1%", base.fee.bps === 100n);

// The quote, against the program itself: the TAO a real holder's swap delivered in simulation.
{
  const q = quoteSwap(base, BigInt(fx.swap.amountIn));
  expect("the quote equals what Raydium's program delivered for the same state, to the unit", q.out === BigInt(fx.swap.simulatedOut), `${q.out} vs ${fx.swap.simulatedOut}`);
  expect("the stated cost covers the tax, both fees and price impact (about 2.3% here)", q.costBps >= 225n && q.costBps <= 235n, `${q.costBps} bps`);
  expect("the tax is 1% of what is sent", q.tax === BigInt(fx.swap.amountIn) / 100n);
}

// The fee maths by hand, both creator-fee branches (curve/calculator.rs swap_base_input).
{
  const s = { fee: { bps: 100n, max: 10n ** 15n }, config: { tradeFeeRate: 2500n, creatorFeeRate: 10000n }, pool: { enableCreatorFee: true }, rIn: 1_000_000n, rOut: 1_000_000n };
  // tax ceil(100) = 100, in 9,900. Trade fee ceil(24.75) = 25; 9,875 in → 9,778 out; creator ceil(97.78) = 98.
  const out = quoteSwap({ ...s, creatorOnInput: false }, 10_000n);
  expect("creator fee on the output: 9,680 out", out.out === 9680n && out.tradeFee === 25n && out.creatorFee === 98n, JSON.stringify(out, (k, v) => (typeof v === "bigint" ? String(v) : v)));
  // Both fees together on the input: ceil(123.75) = 124, creator floor(99.2) = 99; 9,776 in → 9,681 out.
  const inp = quoteSwap({ ...s, creatorOnInput: true }, 10_000n);
  expect("creator fee on the input: 9,681 out", inp.out === 9681n && inp.tradeFee === 25n && inp.creatorFee === 99n);
  expect("a disabled creator fee charges none", quoteSwap({ ...s, pool: { enableCreatorFee: false }, creatorOnInput: false }, 10_000n).creatorFee === 0n);
  expect("the cost is measured against the whole amount at the pool's price", out.atSpot === 10_000n && out.costBps === 320n);
  expect("nothing, or dust the tax swallows, is refused", throws(() => quoteSwap({ ...s, creatorOnInput: false }, 0n), /above zero/) && throws(() => quoteSwap({ ...s, creatorOnInput: false }, 1n), /too small/));
}

// Token-2022's transfer fee: rounded up, capped, and the newer rate only from its epoch.
{
  expect("the tax rounds up", transferFee({ bps: 100n, max: 1000n }, 150n) === 2n && transferFee({ bps: 100n, max: 1000n }, 1n) === 1n);
  expect("the tax stops at its maximum", transferFee({ bps: 100n, max: 5n }, 1_000_000n) === 5n);
  expect("a zero rate charges nothing", transferFee({ bps: 0n, max: 5n }, 1_000_000n) === 0n);
  const mint = fixture().mint.data;
  const tf = mint.indexOf(Buffer.from([1, 0, 108, 0])); // TransferFeeConfig's TLV header
  mint.writeBigUInt64LE(BigInt(fx.epoch) + 5n, tf + 4 + 90); // newer rate from a later epoch
  mint.writeUInt16LE(250, tf + 4 + 106);
  expect("before the newer rate's epoch, the older rate applies", decodeTransferFee(mint, fx.epoch).bps === 100n);
  expect("from that epoch, the newer rate applies", decodeTransferFee(mint, BigInt(fx.epoch) + 5n).bps === 250n);
}

// Anything that is not the pinned SOLTAO/TAO pool, open for swaps, is refused before a quote.
{
  const a = fixture();
  expect("a pool not owned by the CPMM program is refused", throws(() => swapState({ ...a, pool: { ...a.pool, owner: TOKEN_PROGRAM }, epoch: fx.epoch }), /not found/));
  expect("a pool of some other coin is refused", throws(() => patched("pool", 200, fixture().pool.data[200] ^ 1), /not SOLTAO against canonical TAO/));
  expect("a pool with swaps paused is refused", throws(() => patched("pool", 329, 4), /paused/));
  expect("a pool not open yet is refused", throws(() => stateFrom(() => ({ now: 0 })), /not open/));
  expect("an unknown creator-fee model is refused", throws(() => patched("pool", 389, 3), /fee model/));
  expect("a wrong authority bump is refused", throws(() => patched("pool", 328, 1), /authority/));
  const hook = fixture().mint.data; const at = hook.indexOf(Buffer.from([18, 0, 64, 0]));
  expect("a mint extension this page does not handle (a transfer hook) switches the swap off", at > 0 && throws(() => stateFrom((m) => { m.mint.data.writeUInt16LE(14, at); return m; }), /extension/));
  expect("a config account that is not the pool's is refused", throws(() => stateFrom((m) => ({ config: { ...m.config, owner: TOKEN_PROGRAM } })), /config/));
}

// Balances: only the wallet's own account of the right mint counts.
{
  const v = fixture().vault0.data;
  expect("a token account is read for its own mint and owner", tokenAmount(v, { mint: CONFIG.taoMint, owner: base.authority }) > 0n);
  expect("…and reads 0 for another mint or owner", tokenAmount(v, { mint: CONFIG.soltao.mint }) === 0n && tokenAmount(v, { owner: CONFIG.soltao.pool }) === 0n);
  expect("the slippage floor is the quote less 1%", minimumOut(1000n) === 990n && CONFIG.soltao.slippageBps === 100n);
}

// The transaction, as it would reach the wallet.
{
  const USER = "E7wdV5qCYL1fZJf6YfvHEyheAeow67Mf7BTpByX89mNQ";
  const ix = swapInstruction(base, { user: USER, amountIn: 123n, minOut: 45n });
  const k = ix.keys.map((x) => `${x.pubkey.toBase58()}${x.isSigner ? "s" : ""}${x.isWritable ? "w" : ""}`);
  const want = [
    `${USER}sw`, "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL", "CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ", `${CONFIG.soltao.pool}w`,
    `${ata(USER, CONFIG.soltao.mint, TOKEN_2022_PROGRAM).toBase58()}w`, `${ata(USER, CONFIG.taoMint, TOKEN_PROGRAM).toBase58()}w`,
    "BUNsWJw83DopE4hrx3KC1TfquRrWY6UdjDiRTBMTt2KRw", "CgYZ1a7AYR8kTqBUYCdvvDVEZAMxPy3ugtCd1h9Vp4Sw",
    TOKEN_2022_PROGRAM.toBase58(), TOKEN_PROGRAM.toBase58(), CONFIG.soltao.mint, CONFIG.taoMint, "E3CCyMHiaBs5jrmkp1kRuBmS2oEb1v5sBBfqQcn9Nfb8w",
  ];
  expect("the swap's accounts are in swap_base_input's order, with its signer and writable flags", k.join() === want.join(), k.join("\n"));
  expect("the swap goes to Raydium's CPMM program", ix.programId.toBase58() === CONFIG.soltao.program);
  expect("its data is the discriminator, then amount in and minimum out as u64 LE", ix.data.toString("hex") === Buffer.from(SWAP_BASE_INPUT).toString("hex") + "7b00000000000000" + "2d00000000000000");

  const conn = { getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }) };
  const { transaction } = await buildSwapTransaction(conn, base, { user: USER, amountIn: 123n, minOut: 45n, priorityMicroLamports: 7n });
  const m = transaction.message, keys = m.staticAccountKeys.map(String);
  const programs = m.compiledInstructions.map((i) => keys[i.programIdIndex]);
  expect("compute budget, the TAO account (created only if missing), then the swap; nothing else", programs.join() === [ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", CONFIG.soltao.program].join(), programs.join());
  const create = m.compiledInstructions[2];
  expect("the TAO account instruction is CreateIdempotent, for the user's own TAO account", Buffer.from(create.data).equals(Buffer.from([1])) && keys[create.accountKeyIndexes[1]] === ata(USER, CONFIG.taoMint, TOKEN_PROGRAM).toBase58() && keys[create.accountKeyIndexes[2]] === USER);
  expect("no soltao fee rides on the swap: the fee wallet is not in it", !keys.includes(CONFIG.fee.wallet));
  expect("the user pays and signs, and is the only signer", keys[0] === USER && m.header.numRequiredSignatures === 1);
  expect("it fits a Solana transaction", transaction.serialize().length <= 1232, `${transaction.serialize().length} bytes`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
