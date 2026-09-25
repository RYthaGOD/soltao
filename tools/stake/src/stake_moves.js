// Stake moves from the derived coldkey, for the holdings view: unstake a position into free TAO (which
// the return direction can then bring back to Solana), or stake free TAO, which is how a subnet stake
// the chain refused on price can be retried at today's price. Also claims the root rewards waiting
// with a validator (runRootClaim), which the chain pays into the root stake.
//
// Same discipline as the return route: the extrinsic is signed and its identity (signed bytes, nonce)
// handed to `onCheckpoint` before it is submitted, and a resume settles that exact extrinsic before
// doing anything new (src/settle.js). An included extrinsic can still fail to dispatch (a price limit
// not met), and the chain's events are not read here, so the outcome is judged by what it was meant to
// change: the coldkey's free balance and this position's stake, read before and after.

import { CONFIG } from "./config.js";
import { settleSigned } from "./settle.js";
import { accountNonce, alphaPriceRao, coldkeySigner, freeBalance, prepareRootClaim, prepareStakeMove, rootPayout, stakeOf, submitSigned } from "./substrate.js";

const realOps = {
  signerAddress: (mnemonic) => coldkeySigner(mnemonic).address,
  free: freeBalance,
  stakeOf,
  alphaPrice: alphaPriceRao,
  prepare: prepareStakeMove,
  submit: submitSigned,
  coldkeyNonce: accountNonce,
  rootPayout,
  prepareClaim: prepareRootClaim,
};

/** The worst price accepted, in rao per Alpha: a ceiling when buying Alpha, a floor when selling it. */
export function limitPrice(kind, priceRao, toleranceBps) {
  const p = BigInt(priceRao), t = BigInt(toleranceBps);
  return kind === "stake" ? (p * (10_000n + t)) / 10_000n : (p * (10_000n - t)) / 10_000n;
}

const str = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));

/**
 * Stake (`kind: "stake"`, `amount` in rao of TAO) or unstake (`kind: "unstake"`, `amount` in the
 * position's own units) on `netuid` under `hotkey`. Returns { done, refused, moved } where `moved` is
 * the change in the position's stake. `progress` is the last checkpoint; pass it back to resume.
 */
export async function runStakeMove({
  mnemonic, kind, hotkey, netuid, amount, toleranceBps = CONFIG.subnetPriceToleranceBps, progress = {},
  onStep = () => {}, onCheckpoint = () => {}, waitMs = 2 * 60_000, pollMs = 4_000, ops = realOps,
}) {
  if (kind !== "stake" && kind !== "unstake") throw new Error(`unknown stake move ${kind}`);
  const coldkey = ops.signerAddress(mnemonic);
  let saved = { ...progress };
  const save = (patch) => { saved = { ...saved, ...patch }; onCheckpoint(saved); };
  const outcome = async () => {
    const [stakeAfter, freeAfter] = await Promise.all([ops.stakeOf(coldkey, hotkey, netuid), ops.free(coldkey)]);
    const before = BigInt(saved.stakeBefore), freeBefore = BigInt(saved.freeBefore);
    const moved = kind === "unstake" ? before - stakeAfter : stakeAfter - before;
    // Free TAO rises on an unstake and falls by at least the amount on a stake; either alone could be
    // noise (emission, another wallet's transfer), together they are the move.
    const landed = saved.rec?.status === "included" && moved > 0n && (kind === "unstake" ? freeAfter > freeBefore : freeBefore - freeAfter >= BigInt(saved.amount));
    // `freed`: free TAO gained by an unstake (after its fee), which is what a chained return may send.
    const freed = landed && kind === "unstake" ? freeAfter - freeBefore : 0n;
    const result = { done: landed, refused: !landed, moved: landed ? moved : 0n, freed, stakeAfter, freeAfter };
    save({ stage: landed ? "done" : "refused" });
    onStep(kind, landed ? "ok" : "bad", landed ? "done" : "Bittensor did not make this move (the price moved past the limit, or a rule refused it); nothing was spent but the transaction fee");
    return result;
  };

  // Resume: settle the saved extrinsic first; never sign a second one while the first could land.
  if (saved.rec && saved.stage !== "done" && saved.stage !== "refused") {
    if (saved.rec.status === "signed") {
      onStep(kind, "busy", "checking the earlier transaction");
      save({ rec: { ...saved.rec, status: await settleSigned({ coldkeyNonce: ops.coldkeyNonce, submit: ops.submit }, saved.rec, { waitMs, pollMs, what: kind }) } });
    }
    return outcome();
  }
  if (saved.stage === "done" || saved.stage === "refused") return { done: saved.stage === "done", refused: saved.stage === "refused", moved: 0n };

  const [stakeBefore, freeBefore, price] = await Promise.all([ops.stakeOf(coldkey, hotkey, netuid), ops.free(coldkey), ops.alphaPrice(netuid)]);
  const amt = BigInt(amount);
  if (amt <= 0n) throw new Error("enter an amount above zero");
  if (kind === "unstake" && amt > stakeBefore) throw new Error("that is more than this position holds");
  if (kind === "stake" && amt > freeBefore) throw new Error("that is more free TAO than this wallet holds");
  const limitRao = Number(netuid) === 0 ? 0n : limitPrice(kind, price, toleranceBps);
  onStep(kind, "busy", "signing");
  const rec = await ops.prepare(mnemonic, { kind, hotkey, netuid, amount: amt, limitRao });
  if (rec.address !== coldkey) throw new Error("the stake move was signed by a different coldkey");
  save({ stage: "signed", kind, hotkey, netuid: String(netuid), amount: String(amt), stakeBefore: String(stakeBefore), freeBefore: String(freeBefore), priceRao: String(price), limitRao: String(limitRao), rec: { ...str(rec), status: "signed" } });
  onStep(kind, "busy", "sent to Bittensor");
  const sub = await ops.submit(rec.signed);
  const status = sub.state === "rejected" ? "dead" : await settleSigned({ coldkeyNonce: ops.coldkeyNonce, submit: ops.submit }, saved.rec, { waitMs, pollMs, what: kind });
  save({ rec: { ...saved.rec, status } });
  return outcome();
}

/**
 * Claims the root rewards waiting with one validator (`claim_root_with_hotkey`). The chain sells the
 * coldkey's slice of that validator's basket and stakes the TAO on root under the same validator, and
 * root stake does not grow any other way under the basket model, so the outcome is judged by that root
 * stake rising. Same sign, save, submit and settle discipline as a stake move.
 * Returns { done, refused, gained, stakeAfter }; `progress` is the last checkpoint, pass it back to resume.
 */
export async function runRootClaim({
  mnemonic, hotkey, progress = {}, onStep = () => {}, onCheckpoint = () => {}, waitMs = 2 * 60_000, pollMs = 4_000, ops = realOps,
}) {
  const coldkey = ops.signerAddress(mnemonic);
  let saved = { ...progress };
  const save = (patch) => { saved = { ...saved, ...patch }; onCheckpoint(saved); };
  const outcome = async () => {
    const stakeAfter = await ops.stakeOf(coldkey, hotkey, 0);
    const gained = stakeAfter - BigInt(saved.stakeBefore);
    const landed = saved.rec?.status === "included" && gained > 0n;
    save({ stage: landed ? "done" : "refused" });
    onStep("claim", landed ? "ok" : "bad", landed ? "done" : "Bittensor paid nothing for this claim (it may have been under the chain's minimum); only the transaction fee was spent");
    return { done: landed, refused: !landed, gained: landed ? gained : 0n, stakeAfter };
  };

  // Resume: settle the saved extrinsic first; never sign a second one while the first could land.
  if (saved.rec && saved.stage !== "done" && saved.stage !== "refused") {
    if (saved.rec.status === "signed") {
      onStep("claim", "busy", "checking the earlier transaction");
      save({ rec: { ...saved.rec, status: await settleSigned({ coldkeyNonce: ops.coldkeyNonce, submit: ops.submit }, saved.rec, { waitMs, pollMs, what: "claim" }) } });
    }
    return outcome();
  }
  if (saved.stage === "done" || saved.stage === "refused") return { done: saved.stage === "done", refused: saved.stage === "refused", gained: 0n };

  const [stakeBefore, payout] = await Promise.all([ops.stakeOf(coldkey, hotkey, 0), ops.rootPayout(coldkey, hotkey)]);
  if (payout <= 0n) throw new Error("no root rewards are waiting with this validator");
  onStep("claim", "busy", "signing");
  const rec = await ops.prepareClaim(mnemonic, hotkey);
  if (rec.address !== coldkey) throw new Error("the claim was signed by a different coldkey");
  save({ stage: "signed", kind: "claim", hotkey, stakeBefore: String(stakeBefore), payoutRao: String(payout), rec: { ...str(rec), status: "signed" } });
  onStep("claim", "busy", "sent to Bittensor");
  const sub = await ops.submit(rec.signed);
  const status = sub.state === "rejected" ? "dead" : await settleSigned({ coldkeyNonce: ops.coldkeyNonce, submit: ops.submit }, saved.rec, { waitMs, pollMs, what: "claim" });
  save({ rec: { ...saved.rec, status } });
  return outcome();
}
