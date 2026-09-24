// The subnet-aware hotkey check: batched metagraph reads (src/evm.js rpcBatch) and the lookup built on
// them (src/bittensor.js findOnSubnet), against a mocked RPC. test/subnet_live.test.mjs runs the same
// lookup read-only against mainnet.

import { selector } from "../src/bittensor.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const w = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const SEL = { count: selector("getUidCount(uint16)"), hotkey: selector("getHotkey(uint16,uint16)"), permit: selector("getValidatorStatus(uint16,uint16)"), div: selector("getDividends(uint16,uint16)"), delegate: selector("getDelegate(bytes32)") };

// A fake subnet 7 with 120 uids; hotkey k(uid) = uid + 1000. uids 101, 7 and 55 hold permits, with
// these dividend shares (of 65535). uid 55 is not a registered delegate; the others take 18%.
const SUBNETS = { 7: 120 };
const permitted = new Set([101, 7, 55]);
const SHARE = { 101: 32768, 7: 60000, 55: 32768 };
let requests = 0, biggest = 0;
function answer({ params: [{ data }] }) {
  const sel = data.slice(2, 10), a = BigInt("0x" + data.slice(10, 74)), b = data.length > 74 ? BigInt("0x" + data.slice(74, 138)) : 0n;
  if (sel === SEL.count) return w(SUBNETS[a] ?? 0);
  if (sel === SEL.hotkey) return w(b + 1000n);
  if (sel === SEL.permit) return w(permitted.has(Number(b)) ? 1 : 0);
  if (sel === SEL.div) return w(permitted.has(Number(b)) ? SHARE[Number(b)] : 0);
  if (sel === SEL.delegate) return Number(a - 1000n) === 55 ? w(0) + w(0).slice(2) : w(1) + w(11796).slice(2);
  throw new Error("unexpected call " + sel);
}
globalThis.fetch = async (_url, { body }) => {
  requests++;
  const req = JSON.parse(body);
  const json = Array.isArray(req)
    ? (biggest = Math.max(biggest, req.length), req.length > 50 ? { jsonrpc: "2.0", id: null, error: { code: -32010, message: "Exceeded max limit of 50" } } : req.map((r) => ({ jsonrpc: "2.0", id: r.id, result: answer(r) })).reverse())
    : { jsonrpc: "2.0", id: 1, result: answer(req) };
  return { ok: true, status: 200, json: async () => json };
};

const { findOnSubnet, subnetHotkeys, getUidCount, subnetValidators } = await import("../src/bittensor.js");
const key = (n) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(64, "0"), "hex"));

const keys = await subnetHotkeys(7);
expect("every uid's hotkey is read, in uid order, despite out-of-order batch replies", keys.length === 120 && keys[0].endsWith((1000).toString(16)) && keys[119].endsWith((1119).toString(16)));
expect("batches never exceed the RPC's 50-call cap", biggest === 50, `largest batch ${biggest}`);
expect("120 uids cost 1 count read plus 3 batches", requests === 4, `${requests} requests`);

const before = requests;
await subnetHotkeys(7);
expect("a second read of the same subnet within a minute costs no requests", requests === before, `${requests - before} requests`);

const v = await findOnSubnet(key(1101), 7);
expect("a validator on the subnet is found with its permit and dividend share", v.uid === 101 && v.validatorPermit === true && Math.abs(v.dividendShare - 0.5) < 1e-4, JSON.stringify(v));
const m = await findOnSubnet(key(1005), 7);
expect("a hotkey with a slot but no permit is reported as such", m.uid === 5 && m.validatorPermit === false);
const off = await findOnSubnet(key(99), 7);
expect("a hotkey with no slot on the subnet is reported as absent", off.uid === null && off.uidCount === 120);
const none = await findOnSubnet(key(1101), 42);
expect("a subnet that does not exist has no uids", none.uidCount === 0 && none.uid === null && (await getUidCount(42)) === 0);

const vals = await subnetValidators(7);
expect("the picker lists only permit holders, by dividend share then uid", vals.map((v) => v.uid).join() === "7,55,101", vals.map((v) => `${v.uid}:${v.dividendShare.toFixed(3)}`).join(" "));
expect("…with take for delegates and none for a non-delegate", Math.abs(vals[0].takePct - 18) < 0.01 && vals[1].takePct === null, vals.map((v) => v.takePct).join());

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
