import { finishFreeReturn } from "../src/return_route.js";
import { RETURN_GAS_LIMIT, WEI_PER_RAO } from "../src/oft_return.js";

const PRICE = 5_000_000_000n;
const FEE = 2_859_118_000_000_000n;
const AMOUNT_RAO = 1_000_000_000n;
const AMOUNT_WEI = AMOUNT_RAO * WEI_PER_RAO;
let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

function simulator({ nativeWei = 0n, wtaoWei = 0n, coldkeyFreeRao = 2_000_000_000n, sendReceipt = null, failAfter = null, bridgeFees = [FEE] } = {}) {
  const s = { nativeWei, wtaoWei, coldkeyFreeRao, calls: [], checkpoints: [], receipts: new Map(), nonce: 0n, quotes: 0 };
  if (sendReceipt) s.receipts.set(sendReceipt.hash, sendReceipt.receipt);
  const maybeFail = (stage) => { if (failAfter === stage) throw new Error(`interrupted after ${stage}`); };
  const ops = {
    signerAddress: () => "5DerivedColdkey",
    transitAddress: () => "0x1111111111111111111111111111111111111111",
    mirrorAddress: async () => "5TransitMirror",
    state: async () => ({ nativeWei: s.nativeWei, wtaoWei: s.wtaoWei }),
    gasPrice: async () => PRICE,
    quoteBridge: async () => ({ nativeFee: bridgeFees[Math.min(s.quotes++, bridgeFees.length - 1)], lzTokenFee: 0n, amountWei: AMOUNT_WEI, amountRao: AMOUNT_RAO, solanaAmountLd: AMOUNT_RAO }),
    quoteFunding: async (_m, to, amountRao) => ({ address: "5DerivedColdkey", freeRao: s.coldkeyFreeRao, feeRao: 85_569n, amountRao, remainingRao: s.coldkeyFreeRao - amountRao - 85_569n, to }),
    fund: async (_m, to, amountRao) => {
      s.calls.push(`fund:${amountRao}`); s.coldkeyFreeRao -= amountRao + 85_569n; s.nativeWei += amountRao * WEI_PER_RAO;
      maybeFail("fund"); return "0xfund";
    },
    wrap: async (_key, amountWei) => {
      s.calls.push(`wrap:${amountWei}`); s.nativeWei -= amountWei + RETURN_GAS_LIMIT.wrap * PRICE; s.wtaoWei += amountWei;
      maybeFail("wrap"); return { hash: "0xwrap" };
    },
    send: async (_key, { amountWei, nativeFeeWei, onBroadcast }) => {
      const hash = "0xsend"; onBroadcast({ hash, nonce: s.nonce++ });
      s.calls.push(`send:${amountWei}`); s.nativeWei -= nativeFeeWei + RETURN_GAS_LIMIT.send * PRICE; s.wtaoWei -= amountWei;
      s.receipts.set(hash, { status: "0x1", gasUsed: RETURN_GAS_LIMIT.send }); maybeFail("send"); return { hash };
    },
    receipt: async (hash) => s.receipts.get(hash) ?? null,
  };
  const run = (progress = {}) => finishFreeReturn({
    mnemonic: "words", transitKey: new Uint8Array(32), solanaRecipient: `0x${"42".repeat(32)}`,
    amountRao: AMOUNT_RAO, expectedColdkey: "5DerivedColdkey", progress, ops, pollMs: 0,
    onCheckpoint: (value) => s.checkpoints.push(value),
  });
  return { s, run };
}

// A higher LayerZero re-quote is covered by a precise top-up before the OFT send.
{
  const higherFee = FEE + 10_000_000_000_000_000n;
  const { s, run } = simulator({ coldkeyFreeRao: 3_000_000_000n, bridgeFees: [FEE, higherFee] });
  await run();
  expect("a higher final bridge quote tops up instead of reverting after wrap",
    s.calls.filter((x) => x.startsWith("fund:")).length === 2 && s.calls.at(-1).startsWith("send:"), s.calls.join(","));
}

// The route refuses before the first mutation if the coldkey cannot cover amount plus fees.
{
  const { s, run } = simulator({ coldkeyFreeRao: 500_000_000n });
  let message = ""; try { await run(); } catch (e) { message = e.message; }
  expect("insufficient free TAO fails before any mutation", /not enough free TAO/.test(message) && s.calls.length === 0, message);
}

// Excess wTAO belongs to the user and is not swept into the requested return.
{
  const extra = 200_000_000_000_000_000n;
  const native = FEE + (RETURN_GAS_LIMIT.send * PRICE * 12n) / 10n;
  const { s, run } = simulator({ nativeWei: native, wtaoWei: AMOUNT_WEI + extra });
  await run();
  expect("a partial return leaves unrelated wTAO on transit untouched", s.wtaoWei === extra && s.calls.length === 1 && s.calls[0].startsWith("send:"), `${s.wtaoWei} wei left`);
}

// Clean route: fund once, wrap once, send once.
{
  const { s, run } = simulator();
  const result = await run();
  expect("free return completes all three mutations once", s.calls.filter((x) => x.startsWith("fund:")).length === 1 && s.calls.filter((x) => x.startsWith("wrap:")).length === 1 && s.calls.filter((x) => x.startsWith("send:")).length === 1);
  expect("canonical amount is sent to the saved Solana recipient", result.stage === "sent" && result.amountRao === AMOUNT_RAO && s.wtaoWei === 0n);
  expect("broadcast hash is checkpointed before completion", s.checkpoints.some((x) => x.stage === "send-broadcast" && x.sendHash === "0xsend"));
}

// Resume after funding: chain state prevents a duplicate coldkey transfer.
{
  const required = AMOUNT_WEI + FEE + ((RETURN_GAS_LIMIT.wrap + RETURN_GAS_LIMIT.send) * PRICE * 12n) / 10n;
  const { s, run } = simulator({ nativeWei: required });
  await run({ stage: "funded", fundingHash: "0xfund" });
  expect("resume after funding does not fund twice", !s.calls.some((x) => x.startsWith("fund:")) && s.calls[0].startsWith("wrap:"), s.calls.join(","));
}

// Resume after wrapping: existing wTAO is reused and only fee/gas funding is considered.
{
  const native = FEE + (RETURN_GAS_LIMIT.send * PRICE * 12n) / 10n;
  const { s, run } = simulator({ nativeWei: native, wtaoWei: AMOUNT_WEI });
  await run({ stage: "wrapped", wrapHash: "0xwrap" });
  expect("resume after wrap does not wrap or fund twice", s.calls.length === 1 && s.calls[0].startsWith("send:"), s.calls.join(","));
}

// Resume after broadcast: receipt proves completion and prevents a second OFT send.
{
  const { s, run } = simulator({ sendReceipt: { hash: "0xprior", receipt: { status: "0x1", gasUsed: 1n } } });
  const result = await run({ stage: "send-broadcast", sendHash: "0xprior" });
  expect("resume after broadcast reads the receipt and never sends twice", result.stage === "sent" && result.sendHash === "0xprior" && s.calls.length === 0);
}

// A pending broadcast remains pending; the route never guesses and broadcasts another send.
{
  const { s, run } = simulator();
  const result = await run({ stage: "send-broadcast", sendHash: "0xpending" });
  expect("pending broadcast blocks duplicate OFT sends", result.pending === true && s.calls.length === 0);
}

// Wrong derived signer is rejected before any quote or mutation.
{
  const { s, run } = simulator();
  let message = ""; try { await finishFreeReturn({ mnemonic: "words", transitKey: new Uint8Array(32), solanaRecipient: `0x${"42".repeat(32)}`, amountRao: AMOUNT_RAO, expectedColdkey: "5Wrong", ops: { signerAddress: () => "5DerivedColdkey" } }); } catch (e) { message = e.message; }
  // Use the simulator route for the actual mutation count; mismatch must happen before it could run.
  expect("a mismatched coldkey cannot start a return", /does not match/.test(message) && s.calls.length === 0, message);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
