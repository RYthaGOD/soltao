import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { base58 } from "@scure/base";
import { CONFIG } from "../src/config.js";
import { usageOptions, createUsageRpc, routeFromTransaction, readUsage } from "../usage.mjs";

const since = Date.parse("2026-10-01T00:00:00Z") / 1000;
const sig = (signature, blockTime = since, err = null) => ({ signature, blockTime, err });
const older = sig("older", since - 1);
const send = () => ({ programId: CONFIG.taoOftProgram,
  data: base58.encode(createHash("sha256").update("global:send").digest().subarray(0, 8)) });
const fee = (source = "wallet-a", lamports = 3_000_000) => ({
  programId: "11111111111111111111111111111111", parsed: { type: "transfer",
    info: { source, destination: CONFIG.fee.wallet, lamports } },
});
const tx = (instructions = [fee(), send()]) => ({
  version: 1, meta: { err: null, innerInstructions: [] },
  transaction: { message: { instructions, accountKeys: [{ pubkey: CONFIG.taoOftProgram }] } },
});
const reply = (request, result) => new Response(JSON.stringify({
  jsonrpc: "2.0", id: JSON.parse(request.body).id, result,
}));
const noWait = async () => {};

test("validates arguments before doing any RPC work", () => {
  assert.equal(usageOptions([]).since, Date.parse("2026-09-21T00:00:00Z") / 1000);
  assert.equal(usageOptions(["--since", "2026-10-01", "--json"]).asJson, true);
  assert.equal(usageOptions(["--since", "2026-10-01T12:30:00.123Z"]).since, since + 45000.123);
  for (const args of [["--since", "nonsense"], ["--since", "2026-02-30"], ["--since"],
    ["--rpc", "file:///tmp/a"], ["--timeout-ms", "0"], ["--max-duration-ms", "2147483648"], ["--wat"]]) {
    assert.throws(() => usageOptions(args));
  }
});

test("requires a successful send and a real system transfer at the historical fee floor", () => {
  assert.equal(routeFromTransaction(tx(), "send", since).feeLamports, 3_000_000);
  assert.equal(routeFromTransaction(tx([fee()]), "reference-only", since), null);
  assert.equal(routeFromTransaction(tx([send()]), "no-fee", since), null);
  assert.equal(routeFromTransaction(tx([fee("wallet-a", 2_999_999), send()]), "small", since), null);
  assert.equal(routeFromTransaction(tx([{ ...fee(), programId: "another-program" }, send()]), "fake-fee", since), null);
  const quote = { ...send(), data: base58.encode(createHash("sha256").update("global:quote_send").digest().subarray(0, 8)) };
  assert.equal(routeFromTransaction(tx([fee(), quote]), "quote", since), null);
  const failed = tx();
  failed.meta.err = { InstructionError: [0, "Custom"] };
  assert.equal(routeFromTransaction(failed, "failed", since), null);
});

test("does not infer success from a CPI and rejects missing metadata or malformed OFT data", () => {
  const inner = tx([fee()]);
  inner.meta.innerInstructions = [{ index: 1, instructions: [send()] }];
  assert.equal(routeFromTransaction(inner, "inner", since), null);
  assert.throws(() => routeFromTransaction({ ...tx(), meta: null }, "missing", since), /Missing transaction metadata/);
  assert.throws(() => routeFromTransaction(tx([fee(), { ...send(), data: "!" }]), "bad", since), /Invalid OFT/);
});

test("paginates short pages, includes the date boundary and labels only Solana submissions", async () => {
  const pages = [[sig("a", since + 1)], [sig("b"), sig("failed", since, "failed"), older]];
  const calls = [];
  const report = await readUsage({ since, rpc: async (method, params) => {
    calls.push([method, params]);
    return method === "getSignaturesForAddress" ? pages.shift() : tx();
  } });
  assert.equal(calls[1][1][1].before, "a");
  assert.equal(calls[2][1][1].maxSupportedTransactionVersion, 1);
  assert.equal(report.checked, 2);
  assert.equal(report.routes.length, 2);
  assert.equal(report.wallets, 1);
  assert.equal(report.feeSol, 0.006);
  assert.equal(report.metric, "solana_oft_submissions");
  assert.match(report.limitation, /completion are not verified/);
});

test("rejects empty and truncated history before requesting transactions", async () => {
  for (const pages of [[[]], [[sig("recent")], []]]) {
    await assert.rejects(readUsage({ since, rpc: async (method) => {
      assert.equal(method, "getSignaturesForAddress");
      return pages.shift();
    } }), /without reaching before --since/);
  }
});

test("rejects unknown timestamps, missing status and non-advancing pagination", async () => {
  for (const signature of [sig("unknown", null), { signature: "unknown", blockTime: since }]) {
    await assert.rejects(readUsage({ since, rpc: async () => [signature, older] }), /Missing timestamp or status/);
  }
  await assert.rejects(readUsage({ since, rpc: async () => [sig("repeated")] }), /repeated signatures/);
});

test("never reports a partial count when a transaction is unavailable", async () => {
  await assert.rejects(readUsage({ since, rpc: async (method) =>
    method === "getSignaturesForAddress" ? [sig("missing"), older] : null }), /could not return transaction/);
});

test("can report zero when the requested history window is covered", async () => {
  const report = await readUsage({ since, rpc: async () => [older] });
  assert.equal(report.routes.length, 0);
  assert.equal(report.checked, 0);
});

test("retries HTTP rate limits and server errors within a fixed attempt budget", async () => {
  let attempts = 0;
  const rpc = createUsageRpc("https://rpc.invalid", { wait: noWait, fetchImpl: async (_, request) => {
    attempts++;
    return attempts < 3 ? new Response("busy", { status: attempts === 1 ? 429 : 503 }) : reply(request, []);
  } });
  assert.deepEqual(await rpc("getSignaturesForAddress", []), []);
  assert.equal(attempts, 3);
  attempts = 0;
  const limited = createUsageRpc("https://rpc.invalid", { wait: noWait, fetchImpl: async () => {
    attempts++;
    return new Response("busy", { status: 429 });
  } });
  await assert.rejects(limited("getTransaction", []), /HTTP 429/);
  assert.equal(attempts, 3);
});

test("does not retry authentication failures or expose provider error messages", async () => {
  let attempts = 0;
  const rpc = createUsageRpc("https://rpc.invalid/?key=secret", { wait: noWait, fetchImpl: async () => {
    attempts++;
    return new Response("secret", { status: 403 });
  } });
  await assert.rejects(rpc("getTransaction", []), (error) => /HTTP 403/.test(error.message) && !/secret/.test(error.message));
  assert.equal(attempts, 1);
  const denied = createUsageRpc("https://rpc.invalid", { fetchImpl: async (_, request) => new Response(JSON.stringify({
    jsonrpc: "2.0", id: JSON.parse(request.body).id, error: { code: -32602, message: "secret" },
  })) });
  await assert.rejects(denied("getTransaction", []), (error) => /-32602/.test(error.message) && !/secret/.test(error.message));
});

test("respects Retry-After and retries an unhealthy JSON-RPC node", async () => {
  let attempts = 0;
  const delays = [];
  const rpc = createUsageRpc("https://rpc.invalid", { wait: async (ms) => delays.push(ms), fetchImpl: async (_, request) => {
    attempts++;
    if (attempts === 1) return new Response("busy", { status: 429, headers: { "retry-after": "2" } });
    if (attempts === 2) return new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(request.body).id,
      error: { code: -32005, message: "unhealthy" } }));
    return reply(request, []);
  } });
  assert.deepEqual(await rpc("getTransaction", []), []);
  assert.deepEqual(delays, [2000, 1000]);
});

test("rejects malformed JSON-RPC envelopes", async () => {
  for (const body of ["not json", JSON.stringify({ jsonrpc: "2.0", id: 999, result: [] }), JSON.stringify({ jsonrpc: "2.0", id: 1 })]) {
    const rpc = createUsageRpc("https://rpc.invalid", { fetchImpl: async () => new Response(body) });
    await assert.rejects(rpc("getTransaction", []), /invalid JSON|has no result/);
  }
});

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}

test("aborts stalled headers and stalled response bodies", async () => {
  for (const partialBody of [false, true]) {
    await withServer((_, res) => {
      if (partialBody) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"jsonrpc":'); }
    }, async (url) => {
      const rpc = createUsageRpc(url, { timeoutMs: 30, wait: noWait });
      await assert.rejects(rpc("getTransaction", []), /request timed out/);
    });
  }
});

test("the whole-scan budget stops an in-flight request", async () => {
  await withServer(() => {}, async (url) => {
    const rpc = createUsageRpc(url, { timeoutMs: 5000, signal: AbortSignal.timeout(30) });
    await assert.rejects(rpc("getSignaturesForAddress", []), /time budget/);
  });
});

test("CLI leaves JSON stdout empty and exits 2 on incomplete history", async () => {
  await withServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: [] }));
  }, async (url) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../usage.mjs", import.meta.url)), "--rpc", url, "--json"]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /returned no signatures/);
  });
});

test("CLI keeps a complete JSON report separate from progress", async () => {
  await withServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: request.method === "getSignaturesForAddress" ? [sig("complete"), older] : tx() }));
  }, async (url) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../usage.mjs", import.meta.url)), "--rpc", url, "--since", "2026-10-01", "--json"]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).routes.length, 1);
    assert.match(stderr, /Checking transaction/);
  });
});
