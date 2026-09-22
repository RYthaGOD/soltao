// Runs the page's real route code (src/route.js, src/evm.js: the same signing, calldata and amounts)
// against live Bittensor EVM mainnet state, without funds and without changing anything.
//
// Every JSON-RPC call route.js makes is answered from one eth_call with state overrides:
// test/Replay.sol is placed at LayerZero's endpoint address, delivers a plain Solana send through
// the real wTAO OFT to the transit account (plus the executor's 0.001 TAO gas drop), and has the
// transit account replay, in order, every transaction route.js has signed so far. So each step runs
// on Bittensor's real runtime: wTAO's real code, the real staking and transfer precompiles, real
// validator and account state. What this cannot show: LayerZero's executor actually delivering,
// and gas being charged (eth_call runs at gas price 0; test/route.test.mjs models the charging).
//
//   node test/mainnet.test.mjs

import solc from "solc";
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const RPC = process.env.BITTENSOR_EVM_RPC || "https://lite.chain.opentensor.ai";
const ENDPOINT = "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B"; // LayerZero V2 endpoint on Bittensor EVM
const WTAO = "0x134f59E8B8637FD70ae12f263492B1dc73A25D1e"; // really holds TAO: pays the gas drop inside the call
// A registered root delegate, used as a known-good hotkey, not a recommendation.
const HOTKEY = "0x20b0f8ac1d5416d32f5a552f98b570f06e8392ccb803029e04f63fbe0553c954";
const RAO = 1_000_000_000n;

const here = dirname(fileURLToPath(import.meta.url));
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "Replay.sol": { content: readFileSync(join(here, "Replay.sol"), "utf8") } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode.object"] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === "error");
if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
const art = (n) => out.contracts["Replay.sol"][n];
const endpointI = new ethers.Interface(art("Endpoint").abi);
const codeOf = (n) => "0x" + art(n).evm.deployedBytecode.object;

// ── the replaying JSON-RPC ──────────────────────────────────────────────────
const realFetch = globalThis.fetch;
async function real(method, params) {
  const res = await realFetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const hex = (v) => "0x" + BigInt(v).toString(16);

let S; // the scenario being replayed
function scenario({ transit, amountSD, dropWei }) {
  S = { transit: transit.toLowerCase(), amountSD, dropWei, calls: [], receipts: new Map(), failSendAt: null, sends: 0, signers: [] };
}
async function replay(readTo = ethers.ZeroAddress, readData = "0x") {
  const data = endpointI.encodeFunctionData("replay", [S.transit, S.amountSD, S.calls.map((c) => c.to), S.calls.map((c) => c.value), S.calls.map((c) => c.data), readTo, readData]);
  const overrides = { [ENDPOINT]: { code: codeOf("Endpoint") }, [S.transit]: { code: codeOf("Transit") } };
  const res = await real("eth_call", [{ from: WTAO, to: ENDPOINT, data, value: hex(S.dropWei), gas: hex(30_000_000) }, "latest", overrides]);
  const [ok, gasUsed, read, transitBalance] = endpointI.decodeFunctionResult("replay", res);
  return { ok, gasUsed, read, transitBalance };
}

globalThis.fetch = async (_url, { body }) => {
  const { method, params } = JSON.parse(body);
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
  const fail = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { message } }) });
  try {
    switch (method) {
      case "eth_gasPrice": return reply(await real(method, params));
      case "eth_getTransactionCount": return reply(params[0].toLowerCase() === S.transit ? hex(S.calls.length) : await real(method, params));
      case "eth_getBalance": return reply(params[0].toLowerCase() === S.transit ? hex((await replay()).transitBalance) : await real(method, params));
      case "eth_call": return reply((await replay(params[0].to, params[0].data)).read);
      case "eth_getTransactionReceipt": return reply(S.receipts.get(params[0]) ?? null);
      case "eth_sendRawTransaction": {
        if (S.failSendAt !== null && S.sends++ >= S.failSendAt) return fail("connection reset (simulated: the page closed)");
        const tx = ethers.Transaction.from(params[0]);
        S.signers.push({ from: tx.from.toLowerCase(), chainId: tx.chainId, type: tx.type, nonce: tx.nonce, expectNonce: S.calls.length });
        S.calls.push({ to: tx.to, value: tx.value, data: tx.data, gasLimit: tx.gasLimit, label: tx.data.slice(0, 10) });
        const r = await replay();
        const i = S.calls.length - 1;
        S.calls[i].ok = r.ok[i]; S.calls[i].gasUsed = r.gasUsed[i];
        S.receipts.set(tx.hash, { status: r.ok[i] ? "0x1" : "0x0", gasUsed: hex(r.gasUsed[i]) });
        return reply(tx.hash);
      }
      default: return fail(`not replayed: ${method}`);
    }
  } catch (e) { return fail(e.message); }
};

const { finishRoute, sweepFloor } = await import("../src/route.js");
const { transitKeyFromSignature, evmAddress } = await import("../src/derive.js");
const { getRootStake, getFreeBalance, getWtao, mirrorColdkey, encode, selector } = await import("../src/bittensor.js");
const { CONFIG } = await import("../src/config.js");

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const fmt = (rao) => (Number(rao) / 1e9).toFixed(9);
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const NAMES = { [("0x" + selector("withdraw(uint256)"))]: "unwrap", [("0x" + selector("addStake(bytes32,uint256,uint256)"))]: "stake", [("0x" + selector("transferStake(bytes32,bytes32,uint256,uint256,uint256)"))]: "handover", [("0x" + selector("transferAll(bytes32,bool)"))]: "sweep" };
const steps = () => S.calls.map((c) => NAMES[c.label] ?? c.label).join(",");
const price = BigInt(await real("eth_gasPrice", []));
console.log(`Bittensor EVM mainnet via ${RPC}, gas price ${Number(price) / 1e9} gwei\n`);

/** A fresh user: transit key from a random stand-in signature, a fresh coldkey. */
function freshUser() {
  const signature = randomBytes(64), solana = "E7wdV5qCYL1fZJf6YfvHEyheAeow67Mf7BTpByX89mNQ";
  const transitKey = transitKeyFromSignature(Uint8Array.from(signature), solana);
  return { transitKey, transit: evmAddress(transitKey), coldkey: Uint8Array.from(randomBytes(32)) };
}

function checkSigning(label) {
  const ok = S.signers.every((s) => s.from === S.transit && s.chainId === 964n && s.type === 0 && s.nonce === s.expectNonce);
  expect(`${label}: every transaction is a legacy chain-964 tx signed by the transit key, nonces in order`, ok, JSON.stringify(S.signers.map((s) => s.nonce)));
  const within = S.calls.every((c) => c.gasUsed + 21_000n + 16n * BigInt((c.data.length - 2) / 2) <= c.gasLimit);
  expect(`${label}: every step fits its configured gas limit`, within, S.calls.map((c) => `${NAMES[c.label]} ${c.gasUsed}/${c.gasLimit}`).join(", "));
}

// ── 1. Stake it for me: 0.1 TAO, 0.01 reserve ───────────────────────────────
{
  const u = freshUser(), amountSD = 100_000n; // 0.1 TAO in the OFT's 6 shared decimals
  scenario({ transit: u.transit, amountSD, dropWei: CONFIG.gasDropWei });
  const wtao = await getWtao(u.transit);
  expect("the real wTAO OFT credits a plain transit address from a Solana send", wtao === amountSD * 1_000_000_000_000n, `${Number(wtao) / 1e18} wTAO`);

  const before = await getRootStake(bytes(HOTKEY), u.coldkey);
  const summary = await finishRoute({ transitKey: u.transitKey, coldkey: u.coldkey, hotkey: bytes(HOTKEY), plan: "stake", reserveRao: CONFIG.defaultReserveRao, expectLd: amountSD * 1000n });
  expect("stake plan: unwrap, stake, handover, sweep, all succeed on mainnet", steps() === "unwrap,stake,handover,sweep" && S.calls.every((c) => c.ok), steps());
  checkSigning("stake plan");

  const stake = (await getRootStake(bytes(HOTKEY), u.coldkey)) - before;
  const free = await getFreeBalance(u.coldkey);
  const self = await mirrorColdkey(u.transit);
  const leftStake = await getRootStake(bytes(HOTKEY), self);
  const leftWtao = await getWtao(u.transit), leftNative = (await replay()).transitBalance;
  expect("the stake is owned by the user's coldkey on the chosen validator", stake > 0n && stake === summary.stakedRao, `${fmt(stake)} TAO staked`);
  expect("the reserve and unused gas money arrive as free TAO", free > CONFIG.defaultReserveRao, `${fmt(free)} TAO free`);
  expect("the transit account ends with no wTAO, no stake, and native TAO under the sweep floor", leftWtao === 0n && leftStake === 0n && leftNative <= sweepFloor(price), `${leftNative} wei left`);
  const inRao = amountSD * 1000n + CONFIG.gasDropWei / RAO, outRao = stake + free + leftNative / RAO;
  expect("every rao accounted for (no gas is charged inside eth_call)", inRao - outRao >= 0n && inRao - outRao <= 10n, `in ${fmt(inRao)}, out ${fmt(outRao)}, Δ ${inRao - outRao} rao`);
}

// ── 2. Just deliver it: 0.05 TAO ────────────────────────────────────────────
{
  const u = freshUser(), amountSD = 50_000n;
  scenario({ transit: u.transit, amountSD, dropWei: CONFIG.gasDropWei });
  await finishRoute({ transitKey: u.transitKey, coldkey: u.coldkey, hotkey: null, plan: "deliver", reserveRao: 0n, expectLd: amountSD * 1000n });
  expect("deliver plan: unwrap, sweep, both succeed on mainnet", steps() === "unwrap,sweep" && S.calls.every((c) => c.ok), steps());
  checkSigning("deliver plan");
  const free = await getFreeBalance(u.coldkey), leftNative = (await replay()).transitBalance;
  const inRao = amountSD * 1000n + CONFIG.gasDropWei / RAO;
  expect("all of it arrives as free TAO in the coldkey", inRao - free <= 1n && leftNative <= sweepFloor(price), `${fmt(free)} TAO free of ${fmt(inRao)}`);
}

// ── 3. The page closes between staking and the handover; the user signs again ──
{
  const u = freshUser(), amountSD = 100_000n;
  scenario({ transit: u.transit, amountSD, dropWei: CONFIG.gasDropWei });
  S.failSendAt = 2; // the third transaction, the handover, never reaches the chain
  let stopped = "";
  try { await finishRoute({ transitKey: u.transitKey, coldkey: u.coldkey, hotkey: bytes(HOTKEY), plan: "stake", reserveRao: CONFIG.defaultReserveRao, expectLd: amountSD * 1000n }); } catch (e) { stopped = e.message; }
  const self = await mirrorColdkey(u.transit);
  const stranded = await getRootStake(bytes(HOTKEY), self);
  expect("interrupted: the stake waits on the transit account, owned by the user's key", Boolean(stopped) && stranded > 0n, `${fmt(stranded)} TAO · ${stopped}`);

  S.failSendAt = null;
  const summary = await finishRoute({ transitKey: u.transitKey, coldkey: u.coldkey, hotkey: bytes(HOTKEY), plan: "stake", reserveRao: CONFIG.defaultReserveRao });
  const stake = await getRootStake(bytes(HOTKEY), u.coldkey);
  expect("signing again finishes it: handover and sweep, no second stake", steps() === "unwrap,stake,handover,sweep" && S.calls.every((c) => c.ok) && stake === summary.stakedRao && stake > 0n, `${steps()} · ${fmt(stake)} TAO staked`);
  expect("nothing left behind after the resume", (await getRootStake(bytes(HOTKEY), self)) === 0n && (await replay()).transitBalance <= sweepFloor(price));
}

// ── 4. The chain refuses the stake: it is delivered unstaked, not left behind ──
{
  // A random account is not a validator, so addStake reverts on mainnet.
  const u = freshUser(), amountSD = 100_000n;
  scenario({ transit: u.transit, amountSD, dropWei: CONFIG.gasDropWei });
  const summary = await finishRoute({ transitKey: u.transitKey, coldkey: u.coldkey, hotkey: Uint8Array.from(randomBytes(32)), plan: "stake", reserveRao: CONFIG.defaultReserveRao, expectLd: amountSD * 1000n });
  const stakeTx = S.calls.find((c) => NAMES[c.label] === "stake");
  expect("a hotkey that is not a validator is refused by the chain", stakeTx && !stakeTx.ok && summary.stakeRefused === true, steps());
  const free = await getFreeBalance(u.coldkey), leftNative = (await replay()).transitBalance;
  const inRao = amountSD * 1000n + CONFIG.gasDropWei / RAO;
  expect("…and the TAO is delivered unstaked to the coldkey, nothing left on the transit account", steps() === "unwrap,stake,sweep" && inRao - free <= 1n && leftNative <= sweepFloor(price), `${fmt(free)} TAO free of ${fmt(inRao)}`);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
