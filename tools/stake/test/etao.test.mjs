import assert from "node:assert/strict";
import { decodeEmissionWeights, emissionSnapshot, EMISSION_ONE as ONE } from "../etao.mjs";

const owner = ONE * 18n / 100n;
const validator = (ONE - owner) / 2n;
const weights = [0n, 0n, owner, validator, ONE - owner - validator];
assert.equal(decodeEmissionWeights(weights).validator.parts, validator.toString());
assert.equal(decodeEmissionWeights(weights.map(String)).miner.percent, 41);
for (const bad of [[], weights.map(Number), [0n, 0n, 0n, 0n, 0n],
  [1n, 0n, owner - 1n, validator, weights[4]], [0n, 0n, -1n, 0n, ONE + 1n]]) {
  assert.throws(() => decodeEmissionWeights(bad));
}
const hash = { toHex: () => "0xfinalized" };
const at = { runtimeVersion: { toJSON: () => ({ specVersion: 481 }) }, query: {
  timestamp: { now: async () => "1792627200000" },
  subtensorModule: { networksAdded: async n => ({ isTrue: n === 8 }),
    subnetEmissionWeights: async () => weights, subnetCreatedViaLease: async () => ({ isTrue: false }) },
} };
const api = { rpc: { chain: { getFinalizedHead: async () => hash,
  getHeader: async h => { assert.equal(h, hash); return { number: 9319003 }; } } },
  at: async h => { assert.equal(h, hash); return at; } };
const snapshot = await emissionSnapshot(api, [8, 8]);
assert.equal(snapshot.rows.length, 1);
assert.equal(snapshot.rows[0].rootBaselinePercent, null);
assert.equal(snapshot.rows[0].alphaValidatorPercent, null);
assert.equal(snapshot.blockHash, "0xfinalized");
at.call = { subnetInfoRuntimeApi: { getSubnetEmissionWeights: async netuid => ({ toJSON: () => ({
  netuid, rootBaselineShare: "0x100", rootShare: "0x100",
}) }) } };
const withRoot = await emissionSnapshot(api, [8]);
assert.equal(withRoot.rows[0].rootPaidParts, "256");
assert.equal(withRoot.rows[0].alphaValidatorParts, (validator - 256n).toString());
at.call.subnetInfoRuntimeApi.getSubnetEmissionWeights = async netuid => ({ toJSON: () => ({
  netuid, rootBaselineShare: ONE.toString(), rootShare: validator.toString(),
}) });
assert.equal((await emissionSnapshot(api, [8])).rows[0].alphaValidatorParts, "0");
at.call.subnetInfoRuntimeApi.getSubnetEmissionWeights = async netuid => ({ toJSON: () => ({
  netuid, rootBaselineShare: "1", rootShare: "2",
}) });
await assert.rejects(() => emissionSnapshot(api, [8]), /validator cap/);
await assert.rejects(() => emissionSnapshot(api, [0]));
await assert.rejects(() => emissionSnapshot(api, [999]), /does not exist/);
delete at.query.subtensorModule.subnetEmissionWeights;
await assert.rejects(() => emissionSnapshot(api, [8]), /no legacy split assumed/);
console.log("PASS eTAO exact u64 decoding, invalid/unknown data rejection, finalized snapshot and unknown yield handling");
