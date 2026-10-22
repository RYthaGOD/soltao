// Operator-only, read-only eTAO evidence. Deliberately outside the published bundles.
export const EMISSION_ONE = (1n << 64n) - 1n;
const roles = ["burn", "recycle", "owner", "validator", "miner"];
const percent = parts => Number((parts * 1_000_000n + EMISSION_ONE / 2n) / EMISSION_ONE) / 10_000;

export function decodeEmissionWeights(values) {
  if (!Array.isArray(values) || values.length !== 5) throw new Error("Expected five eTAO slots");
  const parts = values.map((value) => {
    // Never accept rounded JS numbers for a u64 fraction.
    if (typeof value !== "bigint" && !(typeof value === "string" && /^\d+$/.test(value))) {
      throw new Error("Emission parts must be exact integer strings or BigInts");
    }
    const n = BigInt(value);
    if (n < 0n || n > EMISSION_ONE) throw new Error("Emission part outside u64 range");
    return n;
  });
  if (parts.reduce((a, b) => a + b, 0n) !== EMISSION_ONE) throw new Error("Emission slots do not sum to u64::MAX");
  if (parts[0] || parts[1]) throw new Error("Unsupported emission version: burn/recycle enabled");
  return Object.fromEntries(roles.map((role, i) => [role, {
    parts: parts[i].toString(),
    // Display only; exact parts above are the evidence and arithmetic input.
    percent: percent(parts[i]),
  }]));
}

export async function emissionSnapshot(api, netuids) {
  if (!Array.isArray(netuids) || !netuids.length || netuids.length > 128 ||
      netuids.some(n => !Number.isInteger(n) || n < 1 || n > 65535)) {
    throw new Error("Supply 1–128 subnet IDs between 1 and 65535; root has no subnet split");
  }
  const hash = await api.rpc.chain.getFinalizedHead();
  const at = await api.at(hash);
  const q = at.query.subtensorModule;
  if (!q?.subnetEmissionWeights || !q?.networksAdded || !q?.subnetCreatedViaLease) {
    throw new Error("Finalized runtime lacks required eTAO storage; no legacy split assumed");
  }
  const header = await api.rpc.chain.getHeader(hash);
  const timestamp = await at.query.timestamp.now();
  const rows = [];
  for (const netuid of new Set(netuids)) {
    if (!(await q.networksAdded(netuid)).isTrue) throw new Error(`Subnet ${netuid} does not exist`);
    const weights = await q.subnetEmissionWeights(netuid);
    let root = null;
    const runtimeRead = at.call?.subnetInfoRuntimeApi?.getSubnetEmissionWeights;
    if (runtimeRead) {
      const view = (await runtimeRead(netuid)).toJSON();
      if (!view || view.netuid !== netuid) throw new Error("Unexpected eTAO runtime view");
      const exact = value => {
        if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Inexact runtime fraction");
        if (value === null || value === undefined || typeof value === "boolean") throw new Error("Missing runtime fraction");
        const n = BigInt(value);
        if (n < 0n || n > EMISSION_ONE) throw new Error("Runtime fraction outside u64 range");
        return n;
      };
      const baseline = exact(view.rootBaselineShare);
      const paid = exact(view.rootShare);
      const v = BigInt(weights[3].toString());
      if (paid !== (baseline < v ? baseline : v)) throw new Error("Root payment disagrees with validator cap");
      root = { baseline, paid, remaining: v - paid };
    }
    rows.push({ netuid, createdViaLease: (await q.subnetCreatedViaLease(netuid)).isTrue,
      split: decodeEmissionWeights(Array.from(weights, v => v.toString())),
      rootBaselineParts: root?.baseline.toString() ?? null,
      rootPaidParts: root?.paid.toString() ?? null,
      alphaValidatorParts: root?.remaining.toString() ?? null,
      rootBaselinePercent: root ? percent(root.baseline) : null,
      alphaValidatorPercent: root ? percent(root.remaining) : null });
  }
  return { schemaVersion: 1, blockHash: hash.toHex(), blockNumber: header.number.toString(),
    chainTime: new Date(Number(timestamp.toString())).toISOString(),
    runtime: at.runtimeVersion.toJSON(), rows,
    limitations: ["Root baseline and alpha-validator remainder are null if the runtime view is unavailable.",
      "Validator allocation includes Root; it is not staker APY or a ranking.",
      "Snapshot only: allocations and the Root baseline can change."] };
}
