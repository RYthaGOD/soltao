// Recognising a soltao Chutes top-up in one block's events, for chutes_usage.mjs. Pure, so it is tested
// without a node (test/topups.test.mjs).
//
// A tagged top-up is one extrinsic, a utility.batchAll (src/payments.js), whose events include:
//   system.Remarked      [sender, hash]         hash is the tag's blake2-256 (SOLTAO_TAG_HASH)
//   balances.Transfer    [from, to, amount]     from the same sender: the payment to Chutes
//   system.ExtrinsicSuccess                     the batch completed (batchAll is all or nothing)
// Events are { extrinsic, section, method, data: [string…] }, as polkadot prints them.

/** Every tagged top-up in one block's events: { block, extrinsic, at, from, to, amountRao, ok }. */
export function topupsInBlock(events, { block, at, tagHash }) {
  const want = String(tagHash).toLowerCase();
  const out = [];
  for (const e of events) {
    if (e.extrinsic === null || e.section !== "system" || e.method !== "Remarked" || String(e.data[1]).toLowerCase() !== want) continue;
    const sender = String(e.data[0]);
    const same = events.filter((x) => x.extrinsic === e.extrinsic);
    const ok = same.some((x) => x.section === "system" && x.method === "ExtrinsicSuccess");
    // A batch that failed has no transfer; one that succeeded has exactly the one it was built with.
    const transfers = same.filter((x) => x.section === "balances" && x.method === "Transfer" && String(x.data[0]) === sender);
    if (!transfers.length) out.push({ block, extrinsic: e.extrinsic, at, from: sender, to: null, amountRao: "0", ok: false });
    for (const t of transfers) out.push({ block, extrinsic: e.extrinsic, at, from: sender, to: String(t.data[1]), amountRao: String(BigInt(String(t.data[2]).replace(/,/g, ""))), ok });
  }
  return out;
}

/** Totals over every top-up found: only completed ones at or above Chutes' minimum count. */
export function summarize(topups, { minRao }) {
  const done = topups.filter((t) => t.ok && t.to);
  const counted = done.filter((t) => BigInt(t.amountRao) >= BigInt(minRao));
  const list = [...counted].sort((a, b) => a.block - b.block || a.extrinsic - b.extrinsic);
  return {
    count: counted.length,
    totalRao: counted.reduce((a, t) => a + BigInt(t.amountRao), 0n),
    payers: new Set(counted.map((t) => t.from)).size,
    accounts: new Set(counted.map((t) => t.to)).size,
    belowMin: done.length - counted.length,
    failed: topups.length - done.length,
    list,
  };
}
