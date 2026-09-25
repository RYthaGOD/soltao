// Settling a signed coldkey extrinsic whose outcome is not yet known, shared by the return route's
// funding transfer and the stake/unstake actions. The extrinsic was signed and saved before it was
// submitted (so `rec` holds its signed bytes and nonce). It is:
//
//   included   the coldkey's on-chain nonce has moved past it: it landed (dispatch may still have
//              failed, which callers detect from the state it was meant to change)
//   pending    not included yet: re-submit the identical bytes and wait (at most one can ever land)
//   dead       refused outright and its nonce never used: it can never land, fresh work is safe
//
// `ops` = { coldkeyNonce(address), submit(signedHex) -> { state: "submitted" | "rejected" } }.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function settleSigned(ops, rec, { waitMs = 2 * 60_000, pollMs = 4_000, what = "transaction" } = {}) {
  const nonce = BigInt(rec.nonce);
  if ((await ops.coldkeyNonce(rec.address)) > nonce) return "included";
  const sub = await ops.submit(rec.signed);
  if (sub.state === "rejected") return (await ops.coldkeyNonce(rec.address)) > nonce ? "included" : "dead";
  const start = Date.now();
  while ((await ops.coldkeyNonce(rec.address)) <= nonce) {
    if (Date.now() - start >= waitMs) throw new Error(`the ${what} is still pending on Bittensor: come back and sign again to finish`);
    await sleep(pollMs);
  }
  return "included";
}

// Whether an included extrinsic's dispatch succeeded, from its own ExtrinsicSuccess / ExtrinsicFailed
// event rather than from a balance or stake moving, which another transfer landing at the same time can
// fake. `ops.outcome(id, fromBlock)` finds the extrinsic by hash between the block it was signed at and
// the end of its mortal era. Returns "success", "failed", or null when it cannot tell (no such op, old
// blocks pruned by the node, a read failed); callers then fall back to reading state.
export async function dispatchResult(ops, rec) {
  if (!ops.outcome || rec?.status !== "included" || rec.fromBlock == null) return null;
  try { return await ops.outcome(rec.id, Number(rec.fromBlock)); } catch { return null; }
}
