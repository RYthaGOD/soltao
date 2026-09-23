// The Bittensor half of a route, run by the page (or Node) with the user's transit key. No contract:
// every step is an ordinary transaction to wTAO or a Bittensor precompile.
//
//   1. wait for the bridge to credit wTAO (and the gas drop) to the transit account
//   2. unwrap wTAO to native TAO
//   3. stake:  addStake on the selected netuid as the transit account, then transferStake to the user's coldkey
//   4. sweep:  transferAll of whatever is left to the user's coldkey, as free TAO
//
// It works from chain state, not from memory, so it can be re-run after any interruption: it picks
// up wTAO still waiting to be unwrapped, stake still owned by the transit account, and TAO still
// waiting to be swept. If the chain refuses the stake itself, the TAO is delivered unstaked. Nothing
// here can send funds anywhere but the user's own coldkey.

import { CONFIG } from "./config.js";
import { evmAddress } from "./derive.js";
import { sendTx, getBalance, getGasPrice } from "./evm.js";
import { PRECOMPILE, encode, getWtao, getStake, mirrorColdkey } from "./bittensor.js";

const RAO = 1_000_000_000n; // wei per rao
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const upfront = (limits, price) => limits.reduce((a, l) => a + l, 0n) * price;

/** Wei the transit account must hold back, beyond the stake itself, to pay for the stake steps. */
export function stakeGasReserve(price) {
  const g = CONFIG.gasLimit;
  // 10% headroom in case the gas price moves between steps.
  return (upfront([g.addStake, g.transferStake, g.sweep], price) * 11n) / 10n;
}

/** The smallest amount (in 9-decimal TAO units) that still stakes, at a given gas price. */
export function minStakeAmount({ reserveRao, gasPriceWei }) {
  return CONFIG.minStakeRao + BigInt(reserveRao) + stakeGasReserve(gasPriceWei) / RAO + 1n;
}

/** Below this, native TAO on the transit account is not worth a sweep: it would cost more gas than it moves. */
export const sweepFloor = (price) => CONFIG.gasLimit.sweep * price + 1000n * RAO;

/** What the transit account holds right now: enough to decide whether there is a route to finish. */
export async function transitState(transitKey, hotkey, netuid = 0n) {
  const address = evmAddress(transitKey);
  const [wtao, native, self] = await Promise.all([getWtao(address), getBalance(address), mirrorColdkey(address)]);
  const stake = hotkey ? await getStake(hotkey, self, BigInt(netuid)) : 0n;
  return { address, self, wtao, native, stake };
}

/**
 * Finish a route. `expectLd` (9-decimal units) makes it wait for a delivery of at least that size;
 * leave it null to finish whatever is already there. `onStep(key, status, text)` reports progress.
 */
export async function finishRoute({ transitKey, coldkey, hotkey, netuid = 0n, plan, reserveRao, expectLd = null, onStep = () => {}, waitMs = 25 * 60_000, dropWaitMs = 10 * 60_000 }) {
  const address = evmAddress(transitKey);
  const self = await mirrorColdkey(address);
  const summary = { stakedRao: 0n, txs: [] };
  const track = (r, label) => { summary.txs.push({ label, ...r }); return r; };

  // 1. arrival
  if (expectLd !== null) {
    const want = BigInt(expectLd) * RAO; // wTAO has 18 decimals
    onStep("bridge", "busy", "crossing: usually a few minutes");
    const start = Date.now();
    for (;;) {
      const w = await getWtao(address);
      if (w >= want) break;
      if (Date.now() - start > waitMs) throw new Error("the bridge has not delivered yet: come back and sign the same message to finish");
      onStep("bridge", "busy", `crossing · ${Math.round((Date.now() - start) / 1000)}s`);
      await sleep(6000);
    }
    onStep("bridge", "ok", "delivered to your transit account");
  }

  // 2. unwrap
  const wtao = await getWtao(address);
  if (wtao > 0n) {
    // LayerZero's executor sends the gas drop as its own transaction. On every past drop on this path
    // it landed a few blocks before the wTAO (LayerZero Scan, checked 22 Sep 2026), but nothing
    // guarantees the order, so wait for it rather than fail.
    let price = await getGasPrice();
    const start = Date.now();
    while ((await getBalance(address)) < CONFIG.gasLimit.unwrap * price) {
      if (Date.now() - start >= dropWaitMs) throw new Error("no gas on the transit account yet: the gas drop has not arrived");
      onStep("unwrap", "busy", "waiting for the gas drop");
      await sleep(6000);
      price = await getGasPrice();
    }
    onStep("unwrap", "busy", "unwrapping wTAO");
    track(await sendTx(transitKey, { to: CONFIG.wtao, data: encode("withdraw(uint256)", wtao), gasLimit: CONFIG.gasLimit.unwrap, gasPrice: price }), "unwrap");
  }
  onStep("unwrap", "ok", "native TAO");

  // 3. stake, then hand it over
  if (plan === "stake" && hotkey) {
    const netuidBn = BigInt(netuid);
    let owned = await getStake(hotkey, self, netuidBn);
    if (owned === 0n) {
      const price = await getGasPrice();
      const balance = await getBalance(address);
      const free = balance - BigInt(reserveRao) * RAO - stakeGasReserve(price);
      const stakeRao = free > 0n ? free / RAO : 0n;
      if (stakeRao >= CONFIG.minStakeRao) {
        onStep("stake", "busy", netuidBn === 0n ? "staking on root" : `staking on subnet ${netuidBn}`);
        try {
          track(await sendTx(transitKey, { to: PRECOMPILE.staking, data: encode("addStake(bytes32,uint256,uint256)", hotkey, stakeRao, netuidBn), gasLimit: CONFIG.gasLimit.addStake, gasPrice: price }), "stake");
        } catch (e) {
          // Refused by the chain (the hotkey stopped being a validator, a rule changed): retrying the
          // same stake would fail again, so deliver the TAO unstaked instead of leaving it here.
          if (!e.reverted) throw e;
          summary.txs.push({ label: "stake", hash: e.hash, reverted: true });
          summary.stakeRefused = true;
          onStep("stake", "bad", "staking was refused on Bittensor: delivering it unstaked");
        }
        owned = await getStake(hotkey, self, netuidBn);
      } else {
        onStep("stake", "bad", "too little left to stake after gas: delivering it unstaked");
      }
    }
    if (owned > 0n) {
      onStep("stake", "busy", "handing the stake to your coldkey");
      const before = await getStake(hotkey, coldkey, netuidBn);
      track(await sendTx(transitKey, { to: PRECOMPILE.staking, data: encode("transferStake(bytes32,bytes32,uint256,uint256,uint256)", coldkey, hotkey, netuidBn, netuidBn, owned), gasLimit: CONFIG.gasLimit.transferStake }), "handover");
      const after = await getStake(hotkey, coldkey, netuidBn);
      if (after <= before) throw new Error("the handover did not land: the stake is still on your transit account; sign again to retry");
      summary.stakedRao = after - before;
      onStep("stake", "ok", netuidBn === 0n ? `staked on root, owned by your coldkey` : `staked on subnet ${netuidBn}, owned by your coldkey`);
    }
  }

  // 4. sweep everything else to the coldkey as free TAO
  const price = await getGasPrice();
  if ((await getBalance(address)) > sweepFloor(price)) {
    onStep("sweep", "busy", "sending the rest to your wallet");
    track(await sendTx(transitKey, { to: PRECOMPILE.balanceTransfer, data: encode("transferAll(bytes32,bool)", coldkey, 0n), gasLimit: CONFIG.gasLimit.sweep, gasPrice: price }), "sweep");
  }
  onStep("sweep", "ok", "done");
  return summary;
}
