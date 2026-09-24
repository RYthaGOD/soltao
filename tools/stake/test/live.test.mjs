// Post-deploy check against the real domain. Read-only: no wallet, nothing signed or sent.
// Run after every `railway up --ci` once the new hash is serving:
//   node test/live.test.mjs            (or SITE=https://other.host node test/live.test.mjs)
//
// It checks what a page-load smoke test misses: that the served script is the one just built, that
// both RPC origins the page talks to pass the live CSP from inside the page, and that the subnet
// hotkey check behaves on mainnet in the deployed bundle.

import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CONFIG } from "../src/config.js";

const SITE = (process.env.SITE || "https://soltao.xyz").replace(/\/$/, "");
const MIRRORS = SITE === "https://soltao.xyz" ? ["https://soltao-production.up.railway.app/stake/", "https://rythagod.github.io/soltao/stake/"] : [];
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const builtHash = readFileSync(join(here, "../../../stake/index.html"), "utf8").match(/stake\.js\?v=([0-9a-f]+)/)[1];

// Test data, not picks. See test/page.test.mjs for where each came from.
const VALIDATOR = "5CoZxgtfhcJKX2HmkwnsN18KbaT9aih9eF3b6qVPTgAUbifj";
const FOUNDATION_HOTKEY = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";
const SUBNET1_OWNER_HOTKEY = "5HCFWvRqzSHWRPecN7q8J6c7aKQnrCZTMHstPv39xL1wgDHh";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

async function open(path) {
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const res = await page.goto(`${SITE}${path}?live-check=${Date.now()}`, { waitUntil: "networkidle2", timeout: 60_000 });
  return { page, problems, status: res.status() };
}
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const waitText = (page, sel, re, timeout = 60_000) => page.waitForFunction((s, r) => new RegExp(r).test(document.querySelector(s)?.textContent || ""), { timeout }, sel, re.source);
// Set a field the way typing would, even while its step is visually locked.
const setField = (page, sel, value) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, value);

try {
  // ── soltao.xyz opens the stake page; the board lives at /board/ ──
  {
    const res = await fetch(`${SITE}/?live-check=1`, { redirect: "manual" });
    expect("/ redirects to the stake page", res.status === 302 && new URL(res.headers.get("location"), SITE).pathname === "/stake/", `${res.status} ${res.headers.get("location")}`);
  }
  {
    const { page, problems, status } = await open("/board/");
    await new Promise((r) => setTimeout(r, 3000));
    expect("the board loads at /board/", status === 200, `HTTP ${status}`);
    expect("board: no page or console errors", problems.length === 0, problems.join(" | "));
    expect("board: no CSP violations", (await page.evaluate(() => window.__csp)).length === 0, (await page.evaluate(() => window.__csp)).join(" | "));
    await page.close();
  }

  // ── stake page ──
  const { page, problems, status } = await open("/stake/");
  expect("/stake/ loads", status === 200, `HTTP ${status}`);
  const served = await page.evaluate(() => document.querySelector('script[src*="stake.js"]')?.getAttribute("src"));
  expect("the served script is the one just built", served?.endsWith(`v=${builtHash}`), `${served} vs v=${builtHash}`);

  // Caching: the hashed script is kept for good, the HTML that names it stays fresh.
  const cacheOf = async (url) => (await fetch(url, { method: "HEAD" })).headers.get("cache-control") || "";
  const jsCache = await cacheOf(`${SITE}/stake/${served}`), htmlCache = await cacheOf(`${SITE}/stake/`);
  expect("the hashed script is cached for a year", /max-age=31536000/.test(jsCache), jsCache);
  expect("the stake page HTML is cached for at most 5 minutes", /max-age=300\b/.test(htmlCache), htmlCache);

  // The page's own RPC calls, made from inside the live page so the live CSP applies.
  const solana = await page.evaluate(async (url) => {
    try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) }); return `${r.status} ${JSON.stringify((await r.json()).result)}`; } catch (e) { return `blocked: ${e.message}`; }
  }, CONFIG.solanaRpc);
  expect("Solana RPC reachable from the live page", /^200 /.test(solana), solana);
  const batch = await page.evaluate(async (url) => {
    try {
      const body = [0, 1].map((id) => ({ jsonrpc: "2.0", id, method: "eth_chainId", params: [] }));
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json(); return `${r.status} ${Array.isArray(j) ? j.map((x) => x.result).join(",") : JSON.stringify(j)}`;
    } catch (e) { return `blocked: ${e.message}`; }
  }, CONFIG.bittensorEvmRpc);
  expect("Bittensor RPC accepts a batched request from the live page", /^200 0x3c4,0x3c4$/.test(batch), batch);

  // The subnet-aware hotkey check, in the deployed bundle, against mainnet.
  await setField(page, "#netuid-in", "60000");
  await waitText(page, "#netuid-note", /not registered|Could not reach/);
  expect("a subnet that does not exist is refused", /Subnet 60000 is not registered/.test(await text(page, "#netuid-note")), await text(page, "#netuid-note"));
  await setField(page, "#netuid-in", "1");
  await waitText(page, "#netuid-note", /registered hotkeys|Could not reach/);
  expect("subnet 1 is found", /Subnet 1 · \d+ registered hotkeys/.test(await text(page, "#netuid-note")), await text(page, "#netuid-note"));
  await setField(page, "#hotkey-in", FOUNDATION_HOTKEY);
  await waitText(page, "#hotkey-note", /Not on subnet 1|Validator on subnet 1|permit|Could not reach/);
  expect("a delegate with no slot on subnet 1 is refused", /^Not on subnet 1:/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  await setField(page, "#hotkey-in", SUBNET1_OWNER_HOTKEY);
  await waitText(page, "#hotkey-note", /Validator on subnet 1|Not on subnet 1|permit|Could not reach/);
  expect("a validator on subnet 1 passes", /^Validator on subnet 1 · uid \d+/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  await setField(page, "#netuid-in", "");
  await waitText(page, "#hotkey-note", /Registered validator|Not a registered|Could not reach/);
  expect("switching back to root re-checks the same hotkey as a delegate", /Registered validator · take/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  await setField(page, "#hotkey-in", VALIDATOR);
  await waitText(page, "#hotkey-note", /Registered validator|Not a registered|Could not reach/);
  expect("the root validator used by the page test still passes", /Registered validator · take/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));

  // Bug history item 1: the bundle once leaked Node's `process`/`Buffer` onto window and broke Phantom.
  const leaks = await page.evaluate(() => ["process", "Buffer", "global"].filter((k) => k in window));
  expect("the bundle adds no Node globals to window", leaks.length === 0, leaks.join(", "));
  expect("the forward page never downloads the return code", !(await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("return.js")))));
  const returnSrc = (await (await fetch(`${SITE}/stake/${served}`)).text()).match(/return\.js\?v=[0-9a-f]{8}/)?.[0];
  if (returnSrc) {
    const res = await fetch(`${SITE}/stake/${returnSrc}`, { method: "HEAD" });
    expect("the return bundle the page names is served, cached for a year", res.status === 200 && /max-age=31536000/.test(res.headers.get("cache-control") || ""), `${returnSrc} · ${res.status} · ${res.headers.get("cache-control")}`);
  }
  expect("the return direction is open (CONFIG.returnLive)", await page.evaluate(() => document.querySelector('input[name="direction"][value="reverse"]')?.disabled === false));
  const csp = await page.evaluate(() => window.__csp);
  expect("/stake/: no CSP violations", csp.length === 0, csp.join(" | "));
  expect("/stake/: no page or console errors", problems.length === 0, problems.join(" | "));
  await page.close();

  // Mirrors cannot sign in (the message names soltao.xyz) or serve the CSP, so they must hand off.
  for (const mirror of MIRRORS) {
    const p = await browser.newPage();
    await p.goto(`${mirror}?from=mirror`, { waitUntil: "networkidle2", timeout: 60_000 });
    expect(`mirror ${new URL(mirror).host} sends /stake/ to the real domain`, p.url().startsWith(`${SITE}/stake/?from=mirror`), p.url());
    await p.close();
  }
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
