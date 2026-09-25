// Runs the real route runner (src/route.js) against a simulated Bittensor EVM that enforces the
// rules measured on mainnet on 21 Sep 2026: per-step minimum gas limits, balance >= limit x price
// up front, transferStake refused under ~2.36M gas, one rao lost per stake operation, and
// transferAll leaving its unused-gas refund behind. Every rao is accounted for at the end.

import { ethers } from "ethers";

const PRICE = 5_000_000_000n, RAO = 1_000_000_000n, TAO = RAO * RAO;
const W = "0x134f59e8b8637fd70ae12f263492b1dc73a25d1e", STAKING = "0x0000000000000000000000000000000000000805";
const XFER = "0x0000000000000000000000000000000000000800", MAP = "0x000000000000000000000000000000000000080c";
const MIN_GAS = { withdraw: 43_181n, addStake: 100_637n, transferStake: 2_357_280n, transferAll: 27_545n };
const USED = { withdraw: 38_000n, addStake: 80_000n, transferStake: 84_000n, transferAll: 26_000n };
const sel = (s) => ethers.id(s).slice(0, 10);
const S = { withdraw: sel("withdraw(uint256)"), balanceOf: sel("balanceOf(address)"), addStake: sel("addStake(bytes32,uint256,uint256)"), transferStake: sel("transferStake(bytes32,bytes32,uint256,uint256,uint256)"), getStake: sel("getStake(bytes32,bytes32,uint256)"), transferAll: sel("transferAll(bytes32,bool)"), map: sel("addressMapping(address)"), addStakeLimit: sel("addStakeLimit(bytes32,uint256,uint256,bool,uint256)"), alphaPrice: sel("getAlphaPrice(uint16)") };
const ALPHA = "0x0000000000000000000000000000000000000808";
const ALPHA_PRICE = 10_000_000_000_000_000n; // 0.01 TAO per Alpha, in wei

let chain;
function freshChain() {
  return { native: new Map(), wtao: new Map(), stake: new Map(), free: new Map(), nonce: new Map(), receipts: new Map(), hotkeys: new Set(), pendingDelivery: null, balanceReads: 0, gasSpent: 0n, priceMove: 0n, stakeCalls: [] };
}
const get = (m, k) => m.get(k.toLowerCase()) ?? 0n;
const add = (m, k, v) => m.set(k.toLowerCase(), get(m, k) + v);
const mirror = (addr) => ethers.keccak256(ethers.concat([ethers.toUtf8Bytes("evm:"), addr]));
const stakeKey = (hotkey, coldkey, netuid = 0n) => `${hotkey}|${coldkey}|${BigInt(netuid)}`;
const word = (data, i) => "0x" + data.slice(10 + i * 64, 10 + (i + 1) * 64);
const u = (data, i) => BigInt(word(data, i));

function execute(tx) {
  const from = tx.from.toLowerCase(), to = tx.to.toLowerCase(), d = tx.data, limit = tx.gasLimit;
  const need = limit * tx.gasPrice + tx.value;
  if (get(chain.native, from) < need) throw new Error("insufficient funds for gas * price + value");
  if (tx.nonce !== Number(get(chain.nonce, from))) throw new Error("invalid nonce");
  add(chain.nonce, from, 1n);
  add(chain.native, from, -limit * tx.gasPrice); // charged up front, unused part refunded below
  let kind, ok = true;
  const run = () => {
    if (to === W && d.startsWith(S.withdraw)) {
      kind = "withdraw"; if (limit < MIN_GAS.withdraw) return false;
      const amt = u(d, 0); if (get(chain.wtao, from) < amt) return false;
      add(chain.wtao, from, -amt); add(chain.native, from, amt); return true;
    }
    if (to === STAKING && d.startsWith(S.addStake)) {
      kind = "addStake"; chain.stakeCalls.push("addStake"); if (limit < MIN_GAS.addStake) return false;
      const hk = word(d, 0), rao = u(d, 1), netuid = u(d, 2);
      if (!chain.hotkeys.has(hk) || rao < 2_000_000n || get(chain.native, from) < rao * RAO) return false;
      add(chain.native, from, -rao * RAO); add(chain.stake, stakeKey(hk, mirror(from), netuid), rao - 1n); return true;
    }
    if (to === STAKING && d.startsWith(S.addStakeLimit)) {
      // The pool price can move between the page's read and execution: chain.priceMove models that.
      kind = "addStake"; chain.stakeCalls.push("addStakeLimit"); if (limit < MIN_GAS.addStake) return false;
      const hk = word(d, 0), rao = u(d, 1), limitRao = u(d, 2), partial = u(d, 3), netuid = u(d, 4);
      const priceNow = ALPHA_PRICE + chain.priceMove;
      if (partial !== 0n || limitRao * RAO < priceNow) return false;
      if (!chain.hotkeys.has(hk) || rao < 2_000_000n || get(chain.native, from) < rao * RAO) return false;
      add(chain.native, from, -rao * RAO); add(chain.stake, stakeKey(hk, mirror(from), netuid), rao - 1n); return true;
    }
    if (to === STAKING && d.startsWith(S.transferStake)) {
      kind = "transferStake"; if (limit < MIN_GAS.transferStake) return false;
      const ck = word(d, 0), hk = word(d, 1), fromNetuid = u(d, 2), toNetuid = u(d, 3), amt = u(d, 4);
      const key = stakeKey(hk, mirror(from), fromNetuid);
      if (get(chain.stake, key) < amt) return false;
      add(chain.stake, key, -amt); add(chain.stake, stakeKey(hk, ck, toNetuid), amt - 1n); return true;
    }
    if (to === XFER && d.startsWith(S.transferAll)) {
      kind = "transferAll"; if (limit < MIN_GAS.transferAll) return false;
      // keep_alive leaves the existential deposit (500 rao) behind, as pallet_balances does
      const all = get(chain.native, from), rao = all / RAO - (u(d, 1) ? 500n : 0n);
      add(chain.native, from, -rao * RAO); add(chain.free, word(d, 0), rao); return true;
    }
    kind = "unknown"; return false;
  };
  ok = run();
  const used = ok ? USED[kind] : limit; // a failed precompile dispatch burns the frame
  add(chain.native, from, (limit - used) * tx.gasPrice);
  chain.gasSpent += used * tx.gasPrice;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(`${from}-${tx.nonce}`));
  chain.receipts.set(hash, { status: ok ? "0x1" : "0x0", gasUsed: "0x" + used.toString(16) });
  return hash;
}

globalThis.fetch = async (_url, { body }) => {
  const { method, params } = JSON.parse(body);
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  const fail = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message } }) });
  const hex = (v) => "0x" + BigInt(v).toString(16);
  switch (method) {
    case "eth_gasPrice": return reply(hex(PRICE));
    case "eth_getBalance": return reply(hex(get(chain.native, params[0])));
    case "eth_getTransactionCount": return reply(hex(get(chain.nonce, params[0])));
    case "eth_getTransactionReceipt": return reply(chain.receipts.get(params[0]) ?? null);
    case "eth_sendRawTransaction": try { return reply(execute(ethers.Transaction.from(params[0]))); } catch (e) { return fail(e.message); }
    case "eth_call": {
      const { to, data } = params[0];
      if (to.toLowerCase() === W && data.startsWith(S.balanceOf)) {
        const addr = "0x" + data.slice(34, 74);
        if (chain.pendingDelivery && ++chain.balanceReads >= 2) { add(chain.wtao, addr, chain.pendingDelivery); chain.pendingDelivery = null; }
        return reply(ethers.toBeHex(get(chain.wtao, addr), 32));
      }
      if (to.toLowerCase() === ALPHA && data.startsWith(S.alphaPrice)) return reply(ethers.toBeHex(ALPHA_PRICE, 32));
      if (to.toLowerCase() === MAP) return reply(mirror("0x" + data.slice(34, 74)));
      if (to.toLowerCase() === STAKING && data.startsWith(S.getStake)) return reply(ethers.toBeHex(get(chain.stake, stakeKey(word(data, 0), word(data, 1), u(data, 2))), 32));
      return fail(`unmocked call ${to} ${data.slice(0, 10)}`);
    }
    default: return fail(`unmocked ${method}`);
  }
};

const { finishRoute, minStakeAmount, stakeGasReserve } = await import("../src/route.js");
const { evmAddress } = await import("../src/derive.js");

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const fmt = (rao) => (Number(rao) / 1e9).toFixed(9);
const bytes = (h) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
const HOTKEY = ethers.hexlify(ethers.randomBytes(32));

function setup({ wtao = 0n, native = 0n, delivery = null, transitStake = 0n, netuid = 0n } = {}) {
  chain = freshChain(); chain.hotkeys.add(HOTKEY);
  const key = bytes(ethers.Wallet.createRandom().privateKey), addr = evmAddress(key);
  chain.native.set(addr, native); chain.wtao.set(addr, wtao); chain.pendingDelivery = delivery;
  if (transitStake) chain.stake.set(stakeKey(HOTKEY, mirror(addr), netuid), transitStake);
  const coldkey = ethers.hexlify(ethers.randomBytes(32));
  return { key, addr, coldkey, ck: bytes(coldkey), hk: bytes(HOTKEY) };
}
const userStake = (t, netuid = 0n) => get(chain.stake, stakeKey(HOTKEY, t.coldkey, netuid));
const userFree = (t) => get(chain.free, t.coldkey);
const DROP = 1_000_000_000_000_000n; // 0.001 TAO

// A. The full stake route: waits for the delivery, unwraps, stakes, hands over, sweeps.
{
  const t = setup({ native: DROP, delivery: TAO });
  const steps = [];
  const r = await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, plan: "stake", reserveRao: 10_000_000n, expectLd: RAO, onStep: (k, s) => steps.push(`${k}:${s}`) });
  const staked = userStake(t), free = userFree(t), dust = get(chain.native, t.addr);
  expect("stake lands on the user's coldkey", staked > 970_000_000n && r.stakedRao === staked, `${fmt(staked)} TAO staked`);
  expect("reserve and unused gas budget arrive as free TAO", free >= 10_000_000n && free < 30_000_000n, `${fmt(free)} TAO free`);
  expect("transit account ends empty but for sub-deposit dust", get(chain.wtao, t.addr) === 0n && get(chain.stake, stakeKey(HOTKEY, mirror(t.addr))) === 0n && dust < 200_000n * RAO, `dust ${fmt(dust / RAO)} TAO`);
  const accounted = (staked + free) * RAO + dust + chain.gasSpent + 2n * RAO; // + the two rao the chain keeps as rounding
  expect("every rao accounted for (stake + free + dust + gas + rounding = delivered + drop)", accounted === TAO + DROP, `${accounted} vs ${TAO + DROP}`);
  expect("four transactions: unwrap, stake, handover, sweep", r.txs.map((x) => x.label).join(",") === "unwrap,stake,handover,sweep", r.txs.map((x) => x.label).join(","));
  expect("gas actually spent is small", chain.gasSpent < 250_000n * PRICE, `${fmt(chain.gasSpent / RAO)} TAO`);
}

// B. Deliver only.
{
  const t = setup({ native: DROP, delivery: TAO });
  await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: null, plan: "deliver", reserveRao: 0n, expectLd: RAO });
  const free = userFree(t);
  expect("deliver-only: everything but gas arrives as free TAO", free > 1_000_000_000n - 500_000n && userStake(t) === 0n, `${fmt(free)} TAO free`);
}

// C. Resume after the unwrap: native TAO is sitting on the transit account.
{
  const t = setup({ native: TAO + DROP });
  const r = await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, plan: "stake", reserveRao: 10_000_000n });
  expect("resume from native TAO stakes and sweeps", userStake(t) > 970_000_000n && r.txs.map((x) => x.label).join(",") === "stake,handover,sweep", r.txs.map((x) => x.label).join(","));
}

// D. Resume with stake stuck on the transit account (the handover never ran).
{
  const t = setup({ native: 20_000_000n * RAO, transitStake: 500_000_000n });
  const r = await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, plan: "stake", reserveRao: 10_000_000n });
  expect("resume hands over stake the transit account still owns", userStake(t) === 499_999_999n && r.txs[0].label === "handover", `${fmt(userStake(t))} TAO`);
}

// E. Too little to stake after gas: delivered unstaked rather than failing.
{
  const t = setup({ native: DROP, delivery: 30_000_000n * RAO });
  await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, plan: "stake", reserveRao: 10_000_000n, expectLd: 30_000_000n });
  expect("0.03 TAO with a 0.01 reserve is delivered unstaked", userStake(t) === 0n && userFree(t) > 29_000_000n, `${fmt(userFree(t))} TAO free`);
}

// J. Resume a subnet route from the exact saved netuid, without touching root stake.
{
  const netuid = 17n;
  const t = setup({ native: 20_000_000n * RAO, transitStake: 500_000_000n, netuid });
  const r = await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, netuid, plan: "stake", reserveRao: 10_000_000n });
  expect("subnet resume reads and hands over stake on the saved netuid",
    userStake(t, netuid) === 499_999_999n && userStake(t, 0n) === 0n && r.stakedRao === 499_999_999n && r.txs[0].label === "handover",
    `${fmt(userStake(t, netuid))} Alpha on subnet ${netuid}`);
}

// F. The page's minimum really is the minimum.
{
  const min = minStakeAmount({ reserveRao: 10_000_000n, gasPriceWei: PRICE });
  const t = setup({ native: DROP, delivery: min * RAO });
  await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, plan: "stake", reserveRao: 10_000_000n, expectLd: min });
  expect("an amount at the page's stated minimum does stake", userStake(t) >= 19_000_000n, `minimum ${fmt(min)} TAO → ${fmt(userStake(t))} staked`);
  expect("the gas reserve covers the handover's up-front requirement", stakeGasReserve(PRICE) >= MIN_GAS.transferStake * PRICE);
}

// H. The chain refuses the stake (the hotkey is no longer a validator): delivered unstaked, gas paid.
{
  const t = setup({ native: DROP, delivery: TAO });
  chain.hotkeys.clear();
  const r = await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, plan: "stake", reserveRao: 10_000_000n, expectLd: RAO });
  const dust = get(chain.native, t.addr);
  expect("a refused stake is delivered unstaked, not left on the transit account",
    r.stakeRefused === true && userStake(t) === 0n && userFree(t) > 999_000_000n && dust < 200_000n * RAO && r.txs.map((x) => x.label).join(",") === "unwrap,stake,sweep",
    `${fmt(userFree(t))} TAO free · ${r.txs.map((x) => x.label + (x.reverted ? "(refused)" : "")).join(",")}`);
}

// I. The wTAO lands before the gas drop: the route waits for the drop, then carries on.
{
  const t = setup({ wtao: TAO });
  const steps = [];
  setTimeout(() => add(chain.native, t.addr, DROP), 50); // the executor's drop, a moment later
  const r = await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, plan: "stake", reserveRao: 10_000_000n, onStep: (k, s, m) => steps.push(m), dropWaitMs: 60_000 });
  expect("wTAO before the gas drop: waits for the drop, then stakes", steps.includes("waiting for the gas drop") && userStake(t) > 970_000_000n && r.txs[0].label === "unwrap", `${fmt(userStake(t))} TAO staked`);
}

// K. A fresh subnet stake is price-limited; root stays plain addStake (case A).
{
  const t = setup({ native: DROP, delivery: TAO });
  const r = await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, netuid: 5n, plan: "stake", reserveRao: 10_000_000n, expectLd: RAO });
  expect("subnet stake goes out as addStakeLimit, never partial, and lands", chain.stakeCalls.join() === "addStakeLimit" && userStake(t, 5n) > 970_000_000n && r.stakedRao === userStake(t, 5n), chain.stakeCalls.join());
}

// L. The subnet price moves more than the tolerance before the stake lands: delivered unstaked.
{
  const t = setup({ native: DROP, delivery: TAO });
  chain.priceMove = ALPHA_PRICE / 20n; // +5%, past the 2% default
  const r = await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, netuid: 5n, plan: "stake", reserveRao: 10_000_000n, expectLd: RAO });
  expect("a price move past the tolerance is refused and the TAO arrives free", r.stakeRefused === true && userStake(t, 5n) === 0n && userFree(t) > 970_000_000n && r.txs.map((x) => x.label).join(",") === "unwrap,stake,sweep", `${fmt(userFree(t))} TAO free`);
}

// G. No gas drop: refuses clearly instead of burning anything.
{
  const t = setup({ wtao: TAO });
  let msg = ""; try { await finishRoute({ transitKey: t.key, coldkey: t.ck, hotkey: t.hk, plan: "stake", reserveRao: 0n, dropWaitMs: 0 }); } catch (e) { msg = e.message; }
  expect("missing gas drop → clear error, wTAO untouched", /gas drop/.test(msg) && get(chain.wtao, t.addr) === TAO, msg);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
