// Read-only mainnet check of the SOLTAO → TAO swap (src/soltao_swap.js). It reads the real pool,
// quotes a small swap for a real SOLTAO holder, builds the exact transaction the page would ask them to
// sign, and simulates it (no signature, nothing sent). The simulated TAO received must equal the quote
// to the unit, which checks the fee maths and the account list against Raydium's program itself.
//
//   npm run test:soltao:live

import { Connection } from "@solana/web3.js";
import { CONFIG } from "../src/config.js";
import { readSwapState, quoteSwap, minimumOut, buildSwapTransaction, ata, tokenAmount, TOKEN_PROGRAM } from "../src/soltao_swap.js";
import { findSoltaoHolder } from "./soltao_holder.mjs";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const connection = new Connection(CONFIG.solanaRpc, "confirmed");
const findHolder = (min) => findSoltaoHolder(connection, min);

const s = await readSwapState(connection);
expect("the pinned pool reads and checks out (mints, programs, authority, open for swaps)", Boolean(s));
console.log(`      reserves: ${Number(s.rIn) / 1e6} SOLTAO, ${Number(s.rOut) / 1e9} TAO; tax ${s.fee.bps} bps; trade ${s.config.tradeFeeRate}, creator ${s.config.creatorFeeRate} per million; creator fee on input: ${s.creatorOnInput}`);
expect("SOLTAO's transfer tax reads as 1%", s.fee.bps === 100n, String(s.fee.bps));

const amountIn = 100_000_000_000n; // 100,000 SOLTAO
const holder = await findHolder(amountIn);
expect("found a real SOLTAO holder to simulate from", Boolean(holder), holder ?? "none in the last 40 swaps");
if (holder) {
  const q = quoteSwap(s, amountIn);
  console.log(`      quote: ${Number(amountIn) / 1e6} SOLTAO → ${Number(q.out) / 1e9} TAO (at spot ${Number(q.atSpot) / 1e9}; cost ${Number(q.costBps) / 100}%: tax ${q.tax}, trade fee ${q.tradeFee}, creator fee ${q.creatorFee})`);
  const minOut = minimumOut(q.out);
  const { transaction } = await buildSwapTransaction(connection, s, { user: holder, amountIn, minOut, priorityMicroLamports: 5_000n });
  const taoAccount = ata(holder, CONFIG.taoMint, TOKEN_PROGRAM);
  const before = tokenAmount((await connection.getAccountInfo(taoAccount))?.data, { mint: CONFIG.taoMint, owner: holder });
  const sim = await connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [taoAccount.toBase58()] } });
  expect("the swap transaction simulates cleanly", !sim.value.err, JSON.stringify(sim.value.err) + " " + (sim.value.logs || []).slice(-4).join(" | "));
  if (!sim.value.err) {
    const after = tokenAmount(Buffer.from(sim.value.accounts[0].data[0], "base64"), { mint: CONFIG.taoMint, owner: holder });
    expect("the TAO it delivers equals the quote exactly", after - before === q.out, `simulated ${after - before}, quoted ${q.out}`);
    expect("…and is above the minimum the transaction enforces", after - before >= minOut);
    expect(`it fits the compute limit (${CONFIG.soltao.computeUnits})`, sim.value.unitsConsumed < CONFIG.soltao.computeUnits, `${sim.value.unitsConsumed} used`);
  }
  const size = transaction.serialize().length;
  expect("the transaction fits Solana's 1,232-byte limit", size <= 1232, `${size} bytes`);

  // Asking for more than the pool can give must fail on-chain, not fill worse.
  const greedy = await buildSwapTransaction(connection, s, { user: holder, amountIn, minOut: q.out * 2n });
  const simGreedy = await connection.simulateTransaction(greedy.transaction, { sigVerify: false, replaceRecentBlockhash: true });
  expect("a minimum above what the pool gives is refused by the pool (ExceededSlippage)", Boolean(simGreedy.value.err) && (simGreedy.value.logs || []).some((l) => /ExceededSlippage|exceeds desired slippage/i.test(l)), (simGreedy.value.logs || []).filter((l) => /Error/.test(l)).join(" | "));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
