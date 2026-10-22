import { test } from "node:test";
import assert from "node:assert/strict";
import { createVault, applyEvent, assertConservation, previewExit } from "../vault/model.mjs";

function harness() {
  let state = createVault(), nonce = 0;
  const event = (type, data = {}) => ({ domain: state.domain, id: `event-${++nonce}`, type, ...data });
  const apply = (type, data) => state = applyEvent(state, event(type,data));
  const deposit = (owner, amount, operation = `deposit-${nonce}`) => {
    apply("depositReceived", {owner, amount, operation, minShares:1n});
    apply("depositAccepted", {operation});
  };
  return { get state() { return state; }, event, apply, deposit };
}

test("pending deposits do not change share price; realized rewards belong to existing shares", () => {
  const h = harness(); h.deposit("alice",100n);
  h.apply("rewardsObserved", {amount:10n});
  h.apply("depositReceived", {owner:"bob",amount:100n,operation:"bob",minShares:1n});
  assert.equal(h.state.active,100n);
  const before = structuredClone(h.state);
  assert.throws(()=>h.apply("depositAccepted",{operation:"bob"}), /outstanding rewards/);
  assert.deepEqual(h.state,before);
  h.apply("rewardsRealized",{amount:10n}); h.apply("depositAccepted",{operation:"bob"});
  assert.ok(h.state.balances.get("bob") < h.state.balances.get("alice"));
});

test("duplicate events are idempotent, conflicting IDs and domains are rejected", () => {
  const h = harness(); const e = h.event("donationReceived",{amount:10n});
  const s = applyEvent(h.state,e);
  assert.equal(applyEvent(s,e),s);
  assert.throws(()=>applyEvent(s,{...e,amount:20n}), /reused/);
  assert.throws(()=>applyEvent(s,{...e,domain:"other-vault"}), /domain/);
});

test("quarantined donations cannot inflate mint price, including before bootstrap", () => {
  const h = harness(); h.apply("donationReceived",{amount:1_000_000n});
  h.deposit("alice",1n); h.apply("donationReceived",{amount:1_000_000n}); h.deposit("bob",1n);
  assert.equal(h.state.balances.get("alice"),h.state.balances.get("bob"));
  assert.equal(h.state.active,2n); assert.equal(h.state.quarantined,2_000_000n);
});

test("minimum output failure is atomic and deposit can be refunded only once", () => {
  const h=harness(); h.deposit("alice",100n);
  h.apply("depositReceived",{owner:"bob",amount:1n,operation:"bob",minShares:10n**30n});
  const before=structuredClone(h.state);
  assert.throws(()=>h.apply("depositAccepted",{operation:"bob"}), /minimum/);
  assert.deepEqual(h.state,before);
  h.apply("pricingPaused"); h.apply("depositRefunded",{operation:"bob"});
  assert.throws(()=>h.apply("depositRefunded",{operation:"bob"}), /refundable/);
  assert.throws(()=>h.apply("depositAccepted",{operation:"bob"}));
});

test("exit burns shares, reserves a fixed payout and completes during a pricing pause", () => {
  const h=harness(); h.deposit("alice",100n);
  const shares=h.state.balances.get("alice")/2n;
  h.apply("exitReserved",{owner:"alice",shares,operation:"exit",minAssets:1n});
  assert.equal(h.state.reserved,50n);
  h.apply("lossRecognized",{amount:40n});
  h.apply("pricingPaused"); h.apply("exitPaid",{operation:"exit"});
  assert.equal(h.state.payouts,50n);
  assert.throws(()=>h.apply("exitPaid",{operation:"exit"}),/not payable/);
  assert.throws(()=>h.apply("lossRecognized",{amount:11n}));
});

test("expenses and losses reduce redemption value; insolvency stops fresh pricing", () => {
  const h=harness(); h.deposit("alice",100n); const shares=h.state.balances.get("alice");
  h.apply("expensePaid",{amount:5n}); h.apply("lossRecognized",{amount:5n});
  assert.ok(previewExit(h.state,shares)<100n);
  h.apply("lossRecognized",{amount:90n});
  assert.throws(()=>h.deposit("bob",1n),/insolvent/);
});

test("share transfers preserve total supply, and an exited share cannot be spent again", () => {
  const h=harness(); h.deposit("alice",100n); const shares=h.state.supply;
  h.apply("sharesTransferred",{owner:"alice",to:"bob",shares});
  h.apply("exitReserved",{owner:"bob",shares,operation:"exit",minAssets:1n});
  assert.throws(()=>h.apply("sharesTransferred",{owner:"bob",to:"alice",shares}),/insufficient/);
  assert.equal(h.state.supply,0n);
});

test("deposit and immediate exit cannot extract extra backing through rounding", () => {
  const h=harness(); h.deposit("seed",1000n);
  for(let i=1;i<=250;i++) {
    const owner=`user-${i}`, input=BigInt(i), previousPaid=h.state.payouts;
    h.deposit(owner,input);
    const shares=h.state.balances.get(owner);
    h.apply("exitReserved",{owner,shares,operation:`exit-${i}`,minAssets:1n});
    h.apply("exitPaid",{operation:`exit-${i}`});
    assert.ok(h.state.payouts-previousPaid<=input);
  }
});

test("inexact/negative amounts, altered rewards and impossible reordered payouts fail", () => {
  const h=harness();
  for(const n of [1, -1n, 0n, "1"]) assert.throws(()=>h.apply("donationReceived",{amount:n}));
  assert.throws(()=>h.apply("exitPaid",{operation:"not-reserved"}));
  h.deposit("alice",100n); h.apply("rewardsObserved",{amount:10n});
  assert.throws(()=>h.apply("rewardsRealized",{amount:11n}),/reconciliation/);
  assert.throws(()=>h.apply("exitReserved",{owner:"alice",shares:1n,operation:"exit",minAssets:1n}),/outstanding/);
});

test("staked assets cannot fund exits until a matched unstake is realized", () => {
  const h=harness(); h.deposit("alice",100n);
  h.apply("stakeAllocated",{operation:"stake",amount:100n});
  const exit={owner:"alice",shares:h.state.supply,operation:"exit",minAssets:100n};
  assert.throws(()=>h.apply("exitReserved",exit),/unstake/);
  h.apply("unstakeRequested",{operation:"unstake",amount:100n});
  assert.equal(h.state.liquid,0n);
  assert.throws(()=>h.apply("exitReserved",exit),/unstake/);
  assert.throws(()=>h.apply("unstakeRealized",{operation:"unstake",amount:99n}),/reconciliation/);
  h.apply("unstakeRealized",{operation:"unstake",amount:100n});
  h.apply("exitReserved",exit);h.apply("exitPaid",{operation:"exit"});
  assert.equal(h.state.payouts,100n);assert.equal(h.state.staked,0n);
  assert.throws(()=>h.apply("unstakeRealized",{operation:"unstake",amount:100n}),/not pending/);
});

test("unstake requests cannot overcommit backing and Root rewards stay staked", () => {
  const h=harness();h.deposit("alice",100n);
  h.apply("stakeAllocated",{operation:"stake",amount:100n});
  assert.throws(()=>h.apply("stakeAllocated",{operation:"stake",amount:1n}),/already/);
  h.apply("unstakeRequested",{operation:"first",amount:80n});
  assert.throws(()=>h.apply("unstakeRequested",{operation:"second",amount:21n}),/uncommitted/);
  h.apply("rewardsObserved",{amount:10n});h.apply("rewardsRealized",{amount:10n});
  assert.equal(h.state.staked,110n);assert.equal(h.state.liquid,0n);
  assert.throws(()=>h.apply("expensePaid",{amount:1n}),/unstake/);
  assertConservation(h.state);
});

test("5,000 seeded transitions conserve assets/shares and failed events do not mutate state", () => {
  const h=harness(); let seed=482;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed;};
  for(let i=0;i<5000;i++) {
    const before=structuredClone(h.state), n=BigInt(random()%100+1), owner=`user-${random()%4}`;
    const types=["depositReceived","depositAccepted","depositRefunded","rewardsObserved","rewardsRealized",
      "expensePaid","lossRecognized","donationReceived","exitReserved","exitPaid","sharesTransferred"];
    const type=types[random()%types.length];
    try { h.apply(type,{owner,to:`user-${random()%4}`,amount:n,shares:n*1_000_000_000n,
      operation:`op-${random()%50}`,minShares:1n,minAssets:1n}); }
    catch { assert.deepEqual(h.state,before); }
    assertConservation(h.state);
  }
});
