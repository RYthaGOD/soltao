// Drives the built /stake/ page in headless Chrome, served with the production CSP parsed from
// _headers, and a stub wallet. Reads are real (Solana and Bittensor mainnet); nothing is signed
// except a derivation message with a throwaway test key, and nothing is sent: the one run that
// reaches the wallet's send prompt rejects it. Runs A and B serve the bundle with the fee wallet
// switched off, to test the not-live gate; run C serves it as built.
//
//   npm run build && node test/page.test.mjs

import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { VersionedTransaction } from "@solana/web3.js";
import { derivationMessage, walletFromSignature } from "../src/derive.js";
import { CONFIG } from "../src/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const HOLDER = "E7wdV5qCYL1fZJf6YfvHEyheAeow67Mf7BTpByX89mNQ"; // real TAO + SOL holder, read-only use
const VALIDATOR = "5CoZxgtfhcJKX2HmkwnsN18KbaT9aih9eF3b6qVPTgAUbifj"; // a registered delegate (test data, not a pick)
// Run C checks the fee goes to the configured wallet, or to a stand-in if none is configured yet.
const FEE_WALLET = CONFIG.fee.wallet ?? "11111111111111111111111111111112";

// Production headers, from the same file Cloudflare/Netlify read.
const csp = readFileSync(join(root, "_headers"), "utf8").match(/Content-Security-Policy: (.+)/)[1].trim();
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".txt": "text/plain" };

// `feeWallet` patches the bundle's fee wallet as it is served (null switches sending off); leave it
// undefined to serve the bundle as built. The file on disk is never modified.
function serve({ feeWallet } = {}) {
  const server = http.createServer((req, res) => {
    let p = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    if (!existsSync(p)) { res.writeHead(404); return res.end(); }
    let body = readFileSync(p);
    if (feeWallet !== undefined && p.endsWith("stake.js")) {
      const src = body.toString("utf8"), re = /fee:{wallet:(null|"[1-9A-HJ-NP-Za-km-z]{32,44}"),/;
      if (!re.test(src)) throw new Error("fee config not found in the bundle");
      body = Buffer.from(src.replace(re, `fee:{wallet:${JSON.stringify(feeWallet)},`));
    }
    res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream", "content-security-policy": csp, "x-frame-options": "DENY", "x-content-type-options": "nosniff" });
    res.end(body);
  }).listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}/stake/` };
}
const plain = serve({ feeWallet: null }), live = serve(CONFIG.fee.wallet ? {} : { feeWallet: FEE_WALLET });

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

async function openWith({ pubkey, secret, base = plain.base, before }) {
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  await page.exposeFunction("__testSign", (bytes) => Array.from(ed25519.sign(Uint8Array.from(bytes), secret)));
  await page.evaluateOnNewDocument((pk, planted) => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    if (planted) localStorage.setItem(planted.key, planted.value);
    const key = { toString: () => pk, toBase58: () => pk };
    window.phantom = { solana: {
      isPhantom: true, publicKey: null,
      async connect() { this.publicKey = key; return { publicKey: key }; },
      async signMessage(msg) { return { signature: new Uint8Array(await window.__testSign(Array.from(msg))), publicKey: key }; },
      // Records what the page asks the wallet to send, and what it had remembered by then; then declines.
      async signAndSendTransaction(tx) {
        window.__sent = Array.from(tx.serialize());
        window.__pendingAtPrompt = Object.keys(localStorage).filter((k) => k.startsWith("soltao.stake.pending.")).map((k) => localStorage.getItem(k));
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      },
      on() {},
    } };
  }, pubkey, before ?? null);
  await page.goto(base, { waitUntil: "networkidle0" });
  return { page, problems };
}
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const attr = (page, sel, a) => page.$eval(sel, (el, a) => el.getAttribute(a), a);
const hidden = (page, sel) => page.$eval(sel, (el) => el.hidden || el.closest("[hidden]") !== null);
const waitText = (page, sel, re, timeout = 60_000) => page.waitForFunction((s, r) => new RegExp(r).test(document.querySelector(s)?.textContent || ""), { timeout }, sel, re.source);
const clickEl = (page, sel) => page.$eval(sel, (el) => el.click()); // by element: a coordinate click can land on the sticky header
const clean = async (page, problems, label) => {
  const v = await page.evaluate(() => window.__csp);
  expect(`${label}: no CSP violations`, v.length === 0, v.join(" | "));
  expect(`${label}: no page or console errors`, problems.length === 0, problems.join(" | "));
};

// ── Run A: a fresh wallet that signs the raw message, with an earlier route still in flight ──
{
  const secret = ed25519.utils.randomPrivateKey();
  const pubkey = base58.encode(ed25519.getPublicKey(secret));
  const expected = walletFromSignature(ed25519.sign(new TextEncoder().encode(derivationMessage(pubkey)), secret), pubkey);
  const planted = { key: `soltao.stake.pending.${expected.transitAddress}`, value: JSON.stringify({ plan: "deliver", hotkey: null, coldkey: expected.address, reserveRao: "0", amountLd: "100000000", sig: null, at: Date.now() - 120_000 }) };
  const { page, problems } = await openWith({ pubkey, secret, before: planted });

  expect("not-live banner is shown while the fee wallet is unset", !(await hidden(page, "#not-live")));
  // Wallet providers share this page's globals; a stand-in `process` or `Buffer` here can break them.
  const globals = await page.evaluate(() => ({ process: typeof window.process, Buffer: typeof window.Buffer }));
  expect("the page adds no Node globals (process, Buffer) a wallet could trip over", globals.process === "undefined" && globals.Buffer === "undefined", JSON.stringify(globals));
  expect("steps 2–5 start locked", (await attr(page, "#step-coldkey", "data-state")) === "locked" && (await attr(page, "#step-review", "data-state")) === "locked");
  await page.click("#connect");
  await waitText(page, "#tao-balance", /TAO/);
  expect("connect shows the wallet and a TAO balance", (await text(page, "#tao-balance")) === "0 TAO", await text(page, "#tao-balance"));

  await page.click("#derive");
  await waitText(page, "#coldkey-out", /^5/);
  expect("page derives the same Bittensor wallet as the Node module", (await text(page, "#coldkey-out")) === expected.address, await text(page, "#coldkey-out"));
  await waitText(page, "#resume-text", /./);
  expect("page derives the same transit account as the Node module", (await text(page, "#transit-out")) === expected.transitAddress, await text(page, "#transit-out"));
  expect("a raw ed25519 signature is recognised as portable", (await attr(page, "#derive-note", "data-tone")) === "ok");

  expect("a remembered route that has not arrived is offered", !(await hidden(page, "#resume")) && /has not reached your transit account yet/.test(await text(page, "#resume-text")), await text(page, "#resume-text"));
  expect("…with a way to forget it", !(await hidden(page, "#resume-forget")) && (await text(page, "#resume-go")) === "Wait for it");
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewport({ width, height: 900 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(`no horizontal overflow at ${width}px, addresses and the unfinished-route panel showing`, over <= 0, `${over}px`);
  }
  await clickEl(page, "#phrase-ack");
  expect("a new route is blocked while one is unfinished", (await attr(page, "#step-plan", "data-state")) === "locked" && /Finish the route in step 2 first/.test(await text(page, "#amount-note")));
  await clickEl(page, "#resume-forget");
  expect("forgetting it clears the panel and the stored route", (await hidden(page, "#resume")) && !(await page.evaluate((k) => localStorage.getItem(k), planted.key)));
  expect("…and unlocks step 3", (await attr(page, "#step-plan", "data-state")) === "active");

  await clickEl(page, "#phrase-ack");
  expect("step 3 stays locked until the phrase is acknowledged", (await attr(page, "#step-plan", "data-state")) === "locked");
  await page.click("#phrase-toggle");
  const words = await page.$$eval("#phrase li", (lis) => lis.map((li) => li.textContent).join(" "));
  expect("the recovery phrase shown is the derived 12 words", words === expected.mnemonic);
  await page.click("#phrase-toggle");
  expect("hiding the phrase removes it from the DOM", (await page.$$("#phrase li")).length === 0);
  await clickEl(page, "#phrase-ack");
  expect("acknowledging unlocks step 3", (await attr(page, "#step-plan", "data-state")) === "active");

  await clickEl(page, 'input[name="ck-mode"][value="paste"]');
  expect("paste mode hides the derived phrase", await hidden(page, "#phrase-box"));
  await page.type("#coldkey-in", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQZ");
  expect("a mistyped SS58 address is rejected", (await attr(page, "#coldkey-note", "data-tone")) === "bad", await text(page, "#coldkey-note"));
  await page.$eval("#coldkey-in", (el) => { el.value = ""; });
  await page.type("#coldkey-in", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
  expect("a valid SS58 address is accepted as the destination", (await attr(page, "#coldkey-note", "data-tone")) === "ok" && (await text(page, "#coldkey-out")) === "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
  expect("…and the transit account is unchanged", (await text(page, "#transit-out")) === expected.transitAddress);
  expect("a pasted address needs no phrase acknowledgement", (await attr(page, "#step-plan", "data-state")) === "active");

  await clean(page, problems, "run A");
  await page.close();
}

// ── Run B: a real holder, a signature that is not raw ed25519, and live quotes ──
{
  const { page, problems } = await openWith({ pubkey: HOLDER, secret: ed25519.utils.randomPrivateKey() });
  await page.click("#connect");
  await waitText(page, "#tao-balance", /TAO/);
  expect("reads a real holder's TAO balance", /^0\.\d+ TAO$/.test(await text(page, "#tao-balance")), await text(page, "#tao-balance"));

  await page.click("#derive");
  await waitText(page, "#coldkey-out", /^5/);
  expect("a signature that does not verify as raw ed25519 gets the save-the-phrase warning", (await attr(page, "#derive-note", "data-tone")) === "warn");
  await page.waitForFunction(() => document.querySelector("#derive")?.textContent === "Signed", { timeout: 60_000 });
  expect("an empty transit account shows no unfinished route", await hidden(page, "#resume"));
  await clickEl(page, "#phrase-ack");

  await page.type("#amount", "0.03");
  await page.waitForFunction(() => /Staking needs at least/.test(document.querySelector("#amount-note")?.textContent || ""), { timeout: 30_000 });
  expect("an amount below the staking minimum is refused, with the reason", /Staking needs at least 0\.04\d* TAO/.test(await text(page, "#amount-note")), await text(page, "#amount-note"));

  await page.$eval("#amount", (el) => { el.value = ""; });
  await page.type("#amount", "0.1");
  await page.type("#hotkey-in", VALIDATOR);
  await waitText(page, "#hotkey-note", /take/);
  expect("validator hotkey is checked on Bittensor", /Registered validator · take \d/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));

  await waitText(page, "#r-lzfee", /SOL/);
  const lz = parseFloat(await text(page, "#r-lzfee"));
  expect("live LayerZero quote, gas drop included", lz > 0.005 && lz < 0.05, `${lz} SOL`);
  const total = parseFloat(await text(page, "#r-total"));
  expect("total adds soltao's flat fee", Math.abs(total - lz - Number(CONFIG.fee.lamports) / 1e9) < 1e-9, `${total} SOL`);
  expect("review names the plan and the stake", /^Stake about 0\.0\d+ TAO on root/.test(await text(page, "#r-plan")), await text(page, "#r-plan"));
  expect("review shows the transit account", /^0x[0-9a-f]{40}$/.test(await text(page, "#r-via")));
  expect("review estimates Bittensor gas in TAO", /^about 0\.00\d+ TAO$/.test(await text(page, "#r-gas")), await text(page, "#r-gas"));
  expect("sign stays disabled while the route is not live", await page.$eval("#sign", (b) => b.disabled));

  const stakeGas = await text(page, "#r-gas");
  await clickEl(page, 'input[name="plan"][value="deliver"]');
  await waitText(page, "#r-lzfee", /SOL/);
  expect("'just deliver' names the plan", /^Deliver 0\.1 TAO/.test(await text(page, "#r-plan")), await text(page, "#r-plan"));
  expect("'just deliver' costs less Bittensor gas", parseFloat((await text(page, "#r-gas")).slice(6)) < parseFloat(stakeGas.slice(6)), `${await text(page, "#r-gas")} vs ${stakeGas}`);

  await page.$eval("#amount", (el) => { el.value = ""; });
  await page.type("#amount", "5000");
  expect("an amount above the balance is refused", /More than your/.test(await text(page, "#amount-note")), await text(page, "#amount-note"));

  await clean(page, problems, "run B");
  await page.close();
}

// ── Run C: the send path, live settings, up to the wallet's prompt (declined) ──
{
  const { page, problems } = await openWith({ pubkey: HOLDER, secret: ed25519.utils.randomPrivateKey(), base: live.base });
  expect("no not-live banner once the fee wallet is set", await hidden(page, "#not-live"));
  await page.click("#connect");
  await waitText(page, "#tao-balance", /TAO/);
  await page.click("#derive");
  await page.waitForFunction(() => document.querySelector("#derive")?.textContent === "Signed", { timeout: 60_000 });
  await clickEl(page, "#phrase-ack");
  await clickEl(page, 'input[name="plan"][value="deliver"]');
  await page.type("#amount", "0.1");
  await waitText(page, "#r-lzfee", /SOL/);
  await page.waitForFunction(() => !document.querySelector("#sign").disabled, { timeout: 30_000 });
  expect("sign is enabled for a funded wallet once live", true);

  await clickEl(page, "#sign");
  await page.waitForFunction(() => window.__sent || /failed|Could not/i.test(document.querySelector("#sign-note")?.textContent || ""), { timeout: 90_000 });
  const sent = await page.evaluate(() => window.__sent);
  expect("the page simulates, then hands the wallet a transaction", Boolean(sent), await text(page, "#sign-note"));
  if (sent) {
    const tx = VersionedTransaction.deserialize(Uint8Array.from(sent));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(`it carries the OFT send and the fee to ${FEE_WALLET}`, keys.includes(CONFIG.taoOftProgram) && keys.includes(FEE_WALLET) && tx.message.compiledInstructions.length === 3, `${tx.serialize().length} bytes`);
    const pending = await page.evaluate(() => window.__pendingAtPrompt);
    const route = pending.length === 1 ? JSON.parse(pending[0]) : null;
    expect("the route was remembered before the wallet opened", route?.plan === "deliver" && route?.amountLd === "100000000", pending.join(" | "));
  }
  await page.waitForFunction(() => document.querySelector("#step-status")?.dataset.state === "locked", { timeout: 10_000 }).catch(() => {});
  expect("declining clears the remembered route", (await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("soltao.stake.pending.")).length)) === 0);
  expect("declining leaves the page ready to try again", !(await page.$eval("#sign", (b) => b.disabled)) || (await text(page, "#sign-note")) === "", await text(page, "#sign-note"));

  await clean(page, problems, "run C");
  await page.close();
}

await browser.close();
plain.server.close(); live.server.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
