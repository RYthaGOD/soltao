// Builds the exact transaction the page would hand to Phantom, for a real TAO holder, and runs it
// through Solana mainnet's simulator with signature checks off. Nothing is signed or sent; the
// holder's funds are never touched. If this passes, the only thing left between the page and a
// live send is the user's signature.

import { PublicKey } from "@solana/web3.js";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import { createClients, buildRouteTransaction, quoteNativeFee, lzOptions, h160Bytes32, removeDust, getTaoBalance, quotePriorityFee, priorityFeeLamports } from "../src/solana.js";
import { CONFIG } from "../src/config.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const hex = (b) => Buffer.from(b).toString("hex");

// A transit address as the page would derive it; any H160 exercises the Solana side the same way.
const TRANSIT = "0xe00a4459090378cfbe2f8c7c93a993237911cbcc";

// Encoders against LayerZero's own library.
{
  const ours = hex(lzOptions({ dropWei: CONFIG.gasDropWei, receiver: TRANSIT }));
  const theirs = Options.newOptions().addExecutorNativeDropOption(CONFIG.gasDropWei, "0x" + hex(h160Bytes32(TRANSIT))).toHex().slice(2);
  expect("native-drop options match LayerZero's Options builder", ours === theirs, ours);
  expect("an H160 is left-padded to 32 bytes", hex(h160Bytes32(TRANSIT)) === "0".repeat(24) + TRANSIT.slice(2));
  let threw = false; try { h160Bytes32("0x1234"); } catch { threw = true; }
  expect("a short EVM address is refused", threw);
  expect("dust is trimmed to 0.000001 TAO", removeDust(123_456_789n) === 123_456_000n);
}

// A wallet seen holding both TAO and SOL on 21 Sep 2026, used only as a simulation identity.
const HOLDER = process.env.SIM_HOLDER || "E7wdV5qCYL1fZJf6YfvHEyheAeow67Mf7BTpByX89mNQ";
// The configured fee wallet, or a stand-in until there is one.
const FEE = { wallet: CONFIG.fee.wallet ?? "11111111111111111111111111111112", lamports: CONFIG.fee.lamports };
const clients = createClients();

const [bal, lamports] = await Promise.all([getTaoBalance(clients.connection, HOLDER), clients.connection.getBalance(new PublicKey(HOLDER))]);
console.log(`simulating as ${HOLDER} (${Number(bal) / 1e9} TAO, ${lamports / 1e9} SOL)`);

const sim = (tx) => clients.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
const why = (r) => JSON.stringify(r.value.err) + " " + (r.value.logs || []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-3).join(" | ");

// The whole transaction, exactly as signed: compute budget, OFT send with the gas drop, soltao's fee.
{
  const amountLd = 100_000_000n; // 0.1 TAO
  const nativeFee = await quoteNativeFee(clients, { user: HOLDER, transit: TRANSIT, amountLd });
  expect("LayerZero fee is quoted from the TAO program", nativeFee > 0n && nativeFee < 50_000_000n, `${Number(nativeFee) / 1e9} SOL incl. the ${Number(CONFIG.gasDropWei) / 1e18} TAO gas drop`);

  const priority = await quotePriorityFee(clients.connection);
  const { minMicroLamports: lo, maxMicroLamports: hi } = CONFIG.priorityFee;
  expect("priority fee is quoted from recent fees and clamped", priority >= lo && priority <= hi, `${priority} µlamports/CU = ${Number(priorityFeeLamports(priority)) / 1e9} SOL`);

  const { transaction } = await buildRouteTransaction(clients, { user: HOLDER, transit: TRANSIT, amountLd, nativeFee, fee: FEE, priorityMicroLamports: priority });
  const budget = transaction.message.compiledInstructions.filter((ix) => transaction.message.staticAccountKeys[ix.programIdIndex].toBase58() === "ComputeBudget111111111111111111111111111111");
  const price = budget.map((ix) => Buffer.from(ix.data)).find((d) => d[0] === 3);
  expect("the transaction carries exactly the quoted priority fee", price && price.readBigUInt64LE(1) === priority, price ? `${price.readBigUInt64LE(1)}` : "none");
  const size = transaction.serialize().length;
  expect("transaction fits with LayerZero's lookup table alone", size <= 1232, `${size} of 1232 bytes`);

  const r = await sim(transaction);
  const ok = !r.value.err && (r.value.logs || []).some((l) => /Instruction: Send/.test(l));
  expect("OFT send + fee simulates cleanly on mainnet", ok, ok ? `${r.value.unitsConsumed} CU` : why(r));
  const units = r.value.unitsConsumed ?? 0;
  expect("send leaves compute headroom under the configured limit", units > 0 && units < CONFIG.computeUnits * 0.85, `${units} of ${CONFIG.computeUnits} CU`);

  // Decode the fee instruction itself: System Program transfer (u32 index 2, u64 lamports), user → wallet.
  const keys = transaction.message.staticAccountKeys.map((k) => k.toBase58());
  const fees = transaction.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === "11111111111111111111111111111111");
  const f = fees[0], data = f && Buffer.from(f.data);
  const paid = f && data.readUInt32LE(0) === 2 ? data.readBigUInt64LE(4) : null;
  expect(`exactly one fee transfer, ${Number(FEE.lamports) / 1e9} SOL from the user to ${FEE.wallet}`,
    fees.length === 1 && paid === FEE.lamports && keys[f.accountKeyIndexes[0]] === HOLDER && keys[f.accountKeyIndexes[1]] === FEE.wallet,
    paid === null ? "no transfer found" : `${Number(paid) / 1e9} SOL → ${keys[f.accountKeyIndexes[1]]}`);
}

// Without the fee wallet set, the transaction carries no fee instruction at all.
{
  const nativeFee = await quoteNativeFee(clients, { user: HOLDER, transit: TRANSIT, amountLd: 100_000_000n });
  const { transaction } = await buildRouteTransaction(clients, { user: HOLDER, transit: TRANSIT, amountLd: 100_000_000n, nativeFee, fee: { wallet: null, lamports: FEE.lamports } });
  expect("no fee wallet → no transfer instruction", transaction.message.compiledInstructions.length === 2);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
