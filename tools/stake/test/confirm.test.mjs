// confirmSignature / mayForgetPending: a lagged RPC must not be treated as "nothing was sent".

import { confirmSignature, mayForgetPending } from "../src/confirm.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

const sleep = async () => {};

function connection({ statuses, heights }) {
  let si = 0, hi = 0;
  return {
    getSignatureStatuses: async () => ({ value: [statuses[Math.min(si++, statuses.length - 1)]] }),
    getBlockHeight: async () => heights[Math.min(hi++, heights.length - 1)],
  };
}

{
  const r = await confirmSignature(connection({
    statuses: [{ confirmationStatus: "confirmed" }],
    heights: [10],
  }), "sig", 20, { sleep });
  expect("a confirmed signature is ok", r.ok === true && !r.failed && !r.uncertain);
}

{
  const r = await confirmSignature(connection({
    statuses: [null, { confirmationStatus: "finalized" }],
    heights: [10, 10],
  }), "sig", 20, { sleep });
  expect("a later finalized status is ok", r.ok === true);
}

{
  const r = await confirmSignature(connection({
    statuses: [{ err: { InstructionError: [0, "Custom"] } }],
    heights: [10],
  }), "sig", 20, { sleep });
  expect("a chain error is failed, not uncertain", r.failed === true && !r.ok && !r.uncertain && /failed on Solana/.test(r.why));
}

{
  const r = await confirmSignature(connection({
    statuses: [null, { confirmationStatus: "confirmed" }],
    heights: [30, 30],
  }), "sig", 20, { sleep, lagMs: 0 });
  expect("a lagging confirm after the blockhash deadline is still ok", r.ok === true && !r.uncertain);
}

{
  const r = await confirmSignature(connection({
    statuses: [null, null],
    heights: [30, 30],
  }), "sig", 20, { sleep, lagMs: 0 });
  expect("expiry with no status is uncertain, never 'nothing was sent'", r.uncertain === true && !r.ok && !r.failed && /Do not send again/.test(r.why));
}

{
  const r = await confirmSignature(connection({
    statuses: [null, { err: "AlreadyProcessed" }],
    heights: [30, 30],
  }), "sig", 20, { sleep, lagMs: 0 });
  expect("a lagging chain error after the deadline is failed", r.failed === true && !r.uncertain);
}

expect("no signature may be forgotten", mayForgetPending({ holds: false, sig: null }) === true);
expect("funds on transit may not be forgotten", mayForgetPending({ holds: true, sig: null }) === false);
expect("a confirmed signature may not be forgotten", mayForgetPending({ holds: false, sig: "x", status: { confirmationStatus: "confirmed" } }) === false);
expect("a processed signature may not be forgotten", mayForgetPending({ holds: false, sig: "x", status: { confirmationStatus: "processed" } }) === false);
expect("a failed signature may be forgotten", mayForgetPending({ holds: false, sig: "x", status: { err: "x" } }) === true);
expect("a missing RPC record is kept while the blockhash could still land", mayForgetPending({ holds: false, sig: "x", status: null, sentAt: Date.now() - 60_000, now: Date.now() }) === false);
expect("a missing RPC record older than 3 minutes may be forgotten", mayForgetPending({ holds: false, sig: "x", status: null, sentAt: Date.now() - 4 * 60_000, now: Date.now() }) === true);
expect("a failed status read may not be forgotten", mayForgetPending({ holds: false, sig: "x", status: undefined }) === false);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
