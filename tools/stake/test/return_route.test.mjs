// The resumable free-TAO return (src/return_route.js) against a simulated chain with a real mempool:
// transactions can sit pending, be re-broadcast, expire, have their reply lost, or have their nonce
// taken by something else. Every assertion counts mutations the chain actually APPLIED, not calls
// made, because the danger being tested is a second transfer, wrap or send landing on top of the first.

import { finishFreeReturn } from "../src/return_route.js";
import { RETURN_GAS_LIMIT, WEI_PER_RAO } from "../src/oft_return.js";

const PRICE = 5_000_000_000n;
const FEE = 2_859_118_000_000_000n;
const AMOUNT_RAO = 1_000_000_000n;
const AMOUNT_WEI = AMOUNT_RAO * WEI_PER_RAO;
const XFER_FEE = 85_569n;
let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const count = (s, kind) => s.applied.filter((x) => x === kind).length;

function chain({ nativeWei = 0n, wtaoWei = 0n, coldkeyFreeRao = 2_000_000_000n, bridgeFees = [FEE], sendReverts = false } = {}) {
  const s = {
    nativeWei, wtaoWei, coldkeyFreeRao, coldkeyNonce: 0n, evmNonce: 0n,
    pool: new Map(), receipts: new Map(), signed: new Map(), applied: [], log: [], quotes: 0, n: 0,
    autoMine: true, crashAfter: null, loseReplyOf: null, expired: new Set(),
  };
  const mine = () => {
    const txs = [...s.pool.values()].sort((a, b) => (a.nonce < b.nonce ? -1 : 1));
    for (const tx of txs) {
      s.pool.delete(tx.key);
      if (tx.chain === "substrate") {
        if (tx.nonce !== s.coldkeyNonce) continue;
        s.coldkeyNonce++; s.coldkeyFreeRao -= tx.amountRao + XFER_FEE; s.nativeWei += tx.amountRao * WEI_PER_RAO; s.applied.push("fund");
      } else {
        if (tx.nonce !== s.evmNonce) continue;
        s.evmNonce++;
        if (tx.kind === "send" && sendReverts) { s.nativeWei -= RETURN_GAS_LIMIT.send * PRICE; s.receipts.set(tx.hash, "0x0"); continue; }
        if (tx.kind === "wrap") { s.nativeWei -= tx.amountWei + RETURN_GAS_LIMIT.wrap * PRICE; s.wtaoWei += tx.amountWei; }
        else { s.nativeWei -= tx.nativeFeeWei + RETURN_GAS_LIMIT.send * PRICE; s.wtaoWei -= tx.amountWei; }
        s.receipts.set(tx.hash, "0x1"); s.applied.push(tx.kind);
      }
    }
  };
  // The page "closes" right after a named broadcast: the transaction is in the pool, not mined.
  const afterBroadcast = (kind) => { s.log.push(`broadcast:${kind}`); if (s.crashAfter === kind) { s.crashAfter = null; throw new Error(`page closed after ${kind} broadcast`); } };
  const ops = {
    signerAddress: () => "5DerivedColdkey",
    transitAddress: () => "0x1111111111111111111111111111111111111111",
    mirrorAddress: async () => "5TransitMirror",
    state: async () => ({ nativeWei: s.nativeWei, wtaoWei: s.wtaoWei }),
    gasPrice: async () => PRICE,
    quoteBridge: async () => ({ nativeFee: bridgeFees[Math.min(s.quotes++, bridgeFees.length - 1)], lzTokenFee: 0n, amountWei: AMOUNT_WEI, amountRao: AMOUNT_RAO, solanaAmountLd: AMOUNT_RAO }),
    quoteFunding: async (_m, to, amountRao) => ({ address: "5DerivedColdkey", freeRao: s.coldkeyFreeRao, feeRao: XFER_FEE, amountRao, remainingRao: s.coldkeyFreeRao - amountRao - XFER_FEE, to }),
    prepareFund: async (_m, _to, amountRao) => {
      const pendingFunds = [...s.pool.values()].filter((t) => t.chain === "substrate").length;
      const i = s.n++, rec = { id: `0xfund${i}`, signed: `signed-fund-${i}`, nonce: s.coldkeyNonce + BigInt(pendingFunds), address: "5DerivedColdkey" };
      s.signed.set(rec.signed, { chain: "substrate", key: rec.signed, nonce: rec.nonce, amountRao: BigInt(amountRao) });
      return { ...rec, nonce: String(rec.nonce) };
    },
    submitFund: async (signed) => {
      const tx = s.signed.get(signed);
      if (!tx || s.expired.has(signed) || tx.nonce < s.coldkeyNonce) return { state: "rejected", reason: "Transaction is outdated" };
      s.pool.set(tx.key, tx); afterBroadcast("fund");
      if (s.autoMine) mine();
      return { state: "submitted" };
    },
    coldkeyNonce: async () => s.coldkeyNonce,
    signWrap: async (_k, amountWei) => {
      const pend = [...s.pool.values()].filter((t) => t.chain === "evm").length;
      const i = s.n++, tx = { chain: "evm", kind: "wrap", key: `raw-wrap-${i}`, hash: `0xwrap${i}`, nonce: s.evmNonce + BigInt(pend), amountWei };
      s.signed.set(tx.key, tx); return { raw: tx.key, hash: tx.hash, nonce: tx.nonce, from: "0x1111" };
    },
    signSend: async (_k, { amountWei, nativeFeeWei }) => {
      const pend = [...s.pool.values()].filter((t) => t.chain === "evm").length;
      const i = s.n++, tx = { chain: "evm", kind: "send", key: `raw-send-${i}`, hash: `0xsend${i}`, nonce: s.evmNonce + BigInt(pend), amountWei, nativeFeeWei };
      s.signed.set(tx.key, tx); return { raw: tx.key, hash: tx.hash, nonce: tx.nonce, from: "0x1111" };
    },
    broadcast: async (raw) => {
      const tx = s.signed.get(raw);
      if (tx.nonce < s.evmNonce) { if (s.receipts.has(tx.hash)) return tx.hash; throw new Error("nonce too low"); }
      s.pool.set(tx.key, tx); afterBroadcast(tx.kind);
      if (s.loseReplyOf === tx.kind) { s.loseReplyOf = null; throw new Error("connection reset after the RPC accepted it"); }
      return tx.hash;
    },
    evmStatus: async ({ hash, nonce }) => {
      if (s.receipts.has(hash)) return { state: "mined", ok: s.receipts.get(hash) === "0x1" };
      return s.evmNonce > BigInt(nonce) ? { state: "dead" } : { state: "pending" };
    },
    waitMined: async (hash) => {
      if (s.autoMine) mine();
      if (!s.receipts.has(hash)) throw new Error(`transaction ${hash} not mined yet`);
      if (s.receipts.get(hash) !== "0x1") throw Object.assign(new Error(`transaction ${hash} reverted`), { reverted: true, hash });
      return { hash };
    },
  };
  let last = {};
  const run = (progress = last) => finishFreeReturn({
    mnemonic: "words", transitKey: new Uint8Array(32), solanaRecipient: `0x${"42".repeat(32)}`,
    amountRao: AMOUNT_RAO, expectedColdkey: "5DerivedColdkey", progress, ops, pollMs: 0, waitMs: 0,
    onCheckpoint: (value) => { last = JSON.parse(JSON.stringify(value)); s.log.push(`checkpoint:${value.stage}`); },
  });
  const interrupted = async () => { try { await run({}); return null; } catch (e) { return e.message; } };
  return { s, run, interrupted, mine, saved: () => last };
}

// ── the clean route ──
{
  const { s, run } = chain();
  const result = await run({});
  expect("free return applies each mutation exactly once", count(s, "fund") === 1 && count(s, "wrap") === 1 && count(s, "send") === 1, s.applied.join(","));
  expect("canonical amount is sent and no wTAO is left", result.stage === "sent" && result.amountRao === AMOUNT_RAO && s.wtaoWei === 0n);
  const order = s.log.filter((x) => /^(checkpoint:(funding|wrapping|send-signed)|broadcast:)/.test(x)).join(",");
  expect("every mutation is checkpointed before it is broadcast", order === "checkpoint:funding,broadcast:fund,checkpoint:wrapping,broadcast:wrap,checkpoint:send-signed,broadcast:send", order);
}

// ── the review findings: a page closed while a mutation is still pending ──
{
  const { s, run, interrupted } = chain();
  s.autoMine = false; s.crashAfter = "fund";
  const why = await interrupted();
  expect("page closes with the funding transfer pending, not included", /closed after fund/.test(why) && count(s, "fund") === 0 && s.pool.size === 1, why);
  s.autoMine = true;
  await run();
  expect("resume re-submits the same signed transfer and never funds twice", count(s, "fund") === 1 && count(s, "wrap") === 1 && count(s, "send") === 1, s.applied.join(","));
}
{
  // The funding mines; the wrap is broadcast but the page closes before it is mined.
  const { s, run, interrupted } = chain();
  s.crashAfter = "wrap";
  const why = await interrupted();
  expect("page closes with the wrap in the pool", /closed after wrap/.test(why) && count(s, "wrap") === 0, `${why} · ${s.applied.join(",")}`);
  await run();
  expect("resume settles that wrap and never wraps twice", count(s, "fund") === 1 && count(s, "wrap") === 1 && count(s, "send") === 1, s.applied.join(","));
}
{
  // The funding and wrap mine; the RPC accepts the send but its reply is lost, so it looks unsent.
  const { s, run, interrupted } = chain();
  s.loseReplyOf = "send";
  const why = await interrupted();
  expect("an accepted send with a lost reply leaves it in the pool", /connection reset/.test(why) && count(s, "send") === 0, `${why} · pool ${s.pool.size}`);
  const result = await run();
  expect("resume finds that exact send and never sends a second", count(s, "send") === 1 && result.stage === "sent", s.applied.join(","));
}

// ── transactions that can never land ──
{
  const { s, run, interrupted, saved } = chain();
  s.autoMine = false; s.crashAfter = "fund";
  await interrupted();
  s.expired.add(saved().fund.signed); s.pool.clear(); // mortal era passed: it can never be included
  s.autoMine = true;
  await run();
  expect("an expired funding transfer is replaced once, not stacked", count(s, "fund") === 1 && count(s, "send") === 1 && s.log.filter((x) => x === "broadcast:fund").length === 2, s.applied.join(","));
}
{
  const { s, run } = chain();
  s.crashAfter = "wrap";
  try { await run({}); } catch { /* page closed */ }
  // The wrap's nonce is taken by another transaction from the transit key: it can never be mined.
  s.pool.clear(); s.evmNonce++;
  await run();
  expect("a wrap whose nonce was used elsewhere is treated as dead and redone once", count(s, "wrap") === 1 && count(s, "send") === 1, s.applied.join(","));
}
{
  const { s, run } = chain({ sendReverts: true });
  let first = ""; try { await run({}); } catch (e) { first = e.message; }
  let second = ""; try { await run(); } catch (e) { second = e.message; }
  expect("a reverted send stops the route, and a resume does not send again", /reverted/.test(first) && /reverted/.test(second) && s.log.filter((x) => x === "broadcast:send").length === 1, `${first} | ${second}`);
}

// ── carried over: quoting and funding rules ──
{
  const { s, run } = chain({ coldkeyFreeRao: 3_000_000_000n, bridgeFees: [FEE, FEE + 10_000_000_000_000_000n] });
  await run({});
  expect("a higher final bridge quote tops up instead of reverting after wrap", count(s, "fund") === 2 && s.applied.at(-1) === "send", s.applied.join(","));
}
{
  const { s, run } = chain({ coldkeyFreeRao: 500_000_000n });
  let message = ""; try { await run({}); } catch (e) { message = e.message; }
  expect("insufficient free TAO fails before any mutation", /not enough free TAO/.test(message) && s.applied.length === 0 && s.pool.size === 0, message);
}
{
  const extra = 200_000_000_000_000_000n;
  const { s, run } = chain({ nativeWei: FEE + (RETURN_GAS_LIMIT.send * PRICE * 12n) / 10n, wtaoWei: AMOUNT_WEI + extra });
  await run({});
  expect("a partial return leaves unrelated wTAO on transit untouched", s.wtaoWei === extra && s.applied.join(",") === "send", `${s.wtaoWei} wei left`);
}
{
  let message = ""; try { await finishFreeReturn({ mnemonic: "words", transitKey: new Uint8Array(32), solanaRecipient: `0x${"42".repeat(32)}`, amountRao: AMOUNT_RAO, expectedColdkey: "5Wrong", ops: { signerAddress: () => "5DerivedColdkey" } }); } catch (e) { message = e.message; }
  expect("a mismatched coldkey cannot start a return", /does not match/.test(message), message);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
