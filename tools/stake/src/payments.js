// Paying a service on Bittensor from the derived coldkey: today, topping up a Chutes (subnet 64)
// account with free TAO. Chutes gives every account its own SS58 payment address and credits a plain
// TAO transfer to it at the TAO price of that moment (`api/payment/watcher.py` in chutesai/chutes-api,
// read 24 Sep 2026: a Balances.Transfer to the address; below 0.01 TAO it is ignored as dust).
//
// This is the one place the page sends TAO to an address that is not the user's own, so it is never
// part of the route: it is a separate action the user takes on free TAO in their own wallet, to an
// address they paste. The chain cannot tell us an address belongs to Chutes; the page says so.
//
// Every top-up carries a public tag, so top-ups made through soltao can be counted by anyone, soltao
// and Chutes included, from the chain alone (soltao has no server to count them). The transfer and a
// `system.remarkWithEvent(SOLTAO_TAG)` are sent together as one `utility.batchAll`: both happen or
// neither does. The remark emits `System.Remarked { sender, hash }`, where `hash` is the blake2-256 of
// the tag, the same for every soltao top-up (SOLTAO_TAG_HASH). Chutes' watcher reads every event in
// every block, so the Balances.Transfer inside the batch is credited as before. The live runtime allows
// batch_all of these calls; it refuses only a batch nested inside a batch (NoNestingCallFilter in
// opentensor/subtensor's runtime, read at 923fd1f, 23 Sep 2026).
//
// Same discipline as stake moves (src/stake_moves.js): the transfer is signed and its identity (signed
// bytes, nonce) handed to `onCheckpoint` before it is submitted, and a resume settles that exact
// transfer before doing anything new, so a closed tab can never pay twice. The outcome is judged by the
// coldkey's free balance, read before and after.

import { blake2b } from "@noble/hashes/blake2b";
import { settleSigned } from "./settle.js";
import { ss58Decode } from "./derive.js";
import { accountNonce, coldkeySigner, freeBalance, getApi, prepareCall, submitSigned } from "./substrate.js";

/** Chutes ignores smaller payments as dust (DUST_THRESHOLD_RAO in chutesai/chutes-api). */
export const CHUTES_MIN_RAO = 10_000_000n; // 0.01 TAO

/** The public tag on every soltao top-up, and the hash its System.Remarked event carries. */
export const SOLTAO_TAG = "soltao.xyz:chutes-topup:v1";
export const SOLTAO_TAG_HASH = "0x" + Array.from(blake2b(new TextEncoder().encode(SOLTAO_TAG), { dkLen: 32 }), (x) => x.toString(16).padStart(2, "0")).join("");

/** The tagged top-up as one call: the transfer and the tag, all or nothing. */
export function paymentCall(api, to, amount) {
  if (!api.tx.utility?.batchAll || !api.tx.system?.remarkWithEvent) throw new Error("Bittensor no longer offers the calls a tagged top-up needs; nothing was sent");
  return api.tx.utility.batchAll([api.tx.balances.transferAllowDeath(String(to), BigInt(amount)), api.tx.system.remarkWithEvent(SOLTAO_TAG)]);
}

/** Read-only fee and balance check for a tagged top-up: { freeRao, feeRao, remainingRao }. */
export async function quotePayment(mnemonic, to, amount) {
  const api = await getApi();
  const { address } = coldkeySigner(mnemonic);
  const [payment, account] = await Promise.all([paymentCall(api, to, amount).paymentInfo(address), api.query.system.account(address)]);
  const feeRao = payment.partialFee.toBigInt(), freeRao = account.data.free.toBigInt();
  return { freeRao, feeRao, remainingRao: freeRao - BigInt(amount) - feeRao };
}

const realOps = {
  signerAddress: (mnemonic) => coldkeySigner(mnemonic).address,
  free: freeBalance,
  prepare: (mnemonic, to, amount) => prepareCall(mnemonic, (api) => paymentCall(api, to, amount)),
  submit: submitSigned,
  coldkeyNonce: accountNonce,
};

/** Why `to` cannot be paid, or null. `own` is the paying coldkey. */
export function payeeProblem(to, own) {
  const t = String(to || "").trim();
  if (!t) return "paste the payment address";
  try { ss58Decode(t); } catch (e) { return e.message; }
  if (t === own) return "that is this wallet's own address";
  return null;
}

const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));

/**
 * Sends `amount` rao of free TAO from the coldkey to `to`. Returns { done, refused, sent, freeAfter }.
 * `progress` is the last checkpoint; pass it back to resume.
 */
export async function runPayment({
  mnemonic, to, amount, min = CHUTES_MIN_RAO, progress = {},
  onStep = () => {}, onCheckpoint = () => {}, waitMs = 2 * 60_000, pollMs = 4_000, ops = realOps,
}) {
  const coldkey = ops.signerAddress(mnemonic);
  let saved = { ...progress };
  const save = (patch) => { saved = { ...saved, ...patch }; onCheckpoint(saved); };
  const outcome = async () => {
    const freeAfter = await ops.free(coldkey);
    // Free TAO falls by at least the amount (plus the fee) only if the transfer dispatched.
    const landed = saved.rec?.status === "included" && BigInt(saved.freeBefore) - freeAfter >= BigInt(saved.amount);
    save({ stage: landed ? "done" : "refused" });
    onStep("pay", landed ? "ok" : "bad", landed ? "done" : "Bittensor did not make this transfer; nothing was sent but, at most, the transaction fee");
    return { done: landed, refused: !landed, sent: landed ? BigInt(saved.amount) : 0n, freeAfter };
  };

  // Resume: settle the saved transfer first; never sign a second one while the first could land.
  if (saved.rec && saved.stage !== "done" && saved.stage !== "refused") {
    if (saved.rec.status === "signed") {
      onStep("pay", "busy", "checking the earlier transfer");
      save({ rec: { ...saved.rec, status: await settleSigned({ coldkeyNonce: ops.coldkeyNonce, submit: ops.submit }, saved.rec, { waitMs, pollMs, what: "payment" }) } });
    }
    return outcome();
  }
  if (saved.stage === "done" || saved.stage === "refused") return { done: saved.stage === "done", refused: saved.stage === "refused", sent: 0n };

  const problem = payeeProblem(to, coldkey);
  if (problem) throw new Error(problem);
  const amt = BigInt(amount);
  if (amt < BigInt(min)) throw new Error(`send at least ${Number(min) / 1e9} TAO: Chutes ignores smaller payments`);
  const freeBefore = await ops.free(coldkey);
  if (amt > freeBefore) throw new Error("that is more free TAO than this wallet holds");
  onStep("pay", "busy", "signing");
  const rec = await ops.prepare(mnemonic, String(to).trim(), amt);
  if (rec.address !== coldkey) throw new Error("the payment was signed by a different coldkey");
  save({ stage: "signed", to: String(to).trim(), amount: String(amt), freeBefore: String(freeBefore), rec: { ...str(rec), status: "signed" } });
  onStep("pay", "busy", "sent to Bittensor");
  const sub = await ops.submit(rec.signed);
  const status = sub.state === "rejected" ? "dead" : await settleSigned({ coldkeyNonce: ops.coldkeyNonce, submit: ops.submit }, saved.rec, { waitMs, pollMs, what: "payment" });
  save({ rec: { ...saved.rec, status } });
  return outcome();
}
