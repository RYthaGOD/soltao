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
import { sealRoute } from "../src/pending.js";
import { selector } from "../src/bittensor.js";
import { ss58Decode } from "../src/derive.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const HOLDER = "E7wdV5qCYL1fZJf6YfvHEyheAeow67Mf7BTpByX89mNQ"; // real TAO + SOL holder, read-only use
const VALIDATOR = "5CoZxgtfhcJKX2HmkwnsN18KbaT9aih9eF3b6qVPTgAUbifj"; // a registered delegate (test data, not a pick)
// Test data, not picks. Opentensor Foundation's hotkey is a delegate that held no uid on subnet 1 on
// 24 Sep 2026; subnet 1's owner hotkey held uid 248 there with a validator permit.
const FOUNDATION_HOTKEY = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";
const SUBNET1_OWNER_HOTKEY = "5HCFWvRqzSHWRPecN7q8J6c7aKQnrCZTMHstPv39xL1wgDHh";
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

// RUNS=B,F runs only those browser runs. They all read live mainnet, and the public Bittensor RPC
// rate-limits; run the heavy ones apart (with a quiet minute or five between) if a later run times out.
const want = (run) => !process.env.RUNS || process.env.RUNS.split(",").includes(run);
let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

// createSignInMessageText, by hand from @solana/wallet-standard-util's own source (fetched 22 Sep
// 2026): what any standards-following wallet's signIn() builds from structured fields. The stub
// below uses this to reconstruct the message itself, the way a real wallet would — not just echo
// back whatever derivationMessage() already produced — so the test actually proves the two paths
// agree, rather than assuming it.
function buildSiwsText(input) {
  let message = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`;
  if (input.statement) message += `\n\n${input.statement}`;
  const fields = [];
  if (input.uri) fields.push(`URI: ${input.uri}`);
  if (input.version) fields.push(`Version: ${input.version}`);
  if (input.chainId) fields.push(`Chain ID: ${input.chainId}`);
  if (fields.length) message += `\n\n${fields.join("\n")}`;
  return message;
}

async function openWith({ pubkey, secret, base = plain.base, before, signIn = false, intercept = null }) {
  const page = await browser.newPage();
  if (intercept) { await page.setRequestInterception(true); page.on("request", (req) => { if (!intercept(req)) req.continue(); }); }
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  await page.exposeFunction("__testSign", (bytes) => Array.from(ed25519.sign(Uint8Array.from(bytes), secret)));
  await page.exposeFunction("__testSignIn", (fields) => {
    const text = buildSiwsText(fields);
    const bytes = new TextEncoder().encode(text);
    return { signedMessage: Array.from(bytes), signature: Array.from(ed25519.sign(bytes, secret)) };
  });
  await page.evaluateOnNewDocument((pk, planted, withSignIn) => {
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
      ...(withSignIn ? { async signIn(input) {
        const out = await window.__testSignIn(input);
        return { account: { address: pk, publicKey: key }, signedMessage: Uint8Array.from(out.signedMessage), signature: Uint8Array.from(out.signature) };
      } } : {}),
    } };
  }, pubkey, before ?? null, signIn);
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
if (want("A")) {
  const secret = ed25519.utils.randomPrivateKey();
  const pubkey = base58.encode(ed25519.getPublicKey(secret));
  const expected = walletFromSignature(ed25519.sign(new TextEncoder().encode(derivationMessage(pubkey)), secret), pubkey);
  const planted = { key: `soltao.stake.pending.${expected.transitAddress}`, value: JSON.stringify(sealRoute({ plan: "deliver", hotkey: null, coldkey: expected.address, reserveRao: "0", amountLd: "100000000", sig: null, at: Date.now() - 120_000 }, expected.transitKey)) };
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

// ── Run A2: a wallet with a native signIn(), the path added after Phantom failed twice going ──
// through plain signMessage() on 22 Sep 2026. Proves it derives the identical wallet as run A's
// signMessage() path for a fresh key, since the stub reconstructs the message itself from the
// fields the page sends, the way a real wallet's signIn() does, rather than trusting our own text.
if (want("A2")) {
  const secret = ed25519.utils.randomPrivateKey();
  const pubkey = base58.encode(ed25519.getPublicKey(secret));
  const expected = walletFromSignature(ed25519.sign(new TextEncoder().encode(derivationMessage(pubkey)), secret), pubkey);
  const { page, problems } = await openWith({ pubkey, secret, signIn: true });

  await page.click("#connect");
  await waitText(page, "#tao-balance", /TAO/);
  await page.click("#derive");
  await waitText(page, "#coldkey-out", /^5/);
  expect("signIn() derives the identical wallet as signMessage() for the same key", (await text(page, "#coldkey-out")) === expected.address, await text(page, "#coldkey-out"));
  expect("…and the identical transit account", (await text(page, "#transit-out")) === expected.transitAddress);
  expect("recognised as portable, same as the signMessage() path", (await attr(page, "#derive-note", "data-tone")) === "ok", await text(page, "#derive-note"));

  await clean(page, problems, "run A2");
  await page.close();
}

// ── Run B: a real holder, a signature that is not raw ed25519, and live quotes ──
if (want("B")) {
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
  const prio = parseFloat(await text(page, "#r-prio"));
  expect("a Solana priority fee is quoted and shown", prio > 0 && prio <= Number(CONFIG.priorityFee.maxMicroLamports * BigInt(CONFIG.computeUnits)) / 1e15 + 1e-9, `${prio} SOL`);
  await waitText(page, "#r-usd", /Dexscreener|unavailable/, 30_000);
  expect("the review shows the amount and fees in dollars, with source and time", /^(\$[\d,.]+|under \$0\.01) of TAO, (\$[\d,.]+|under \$0\.01) in fees \(Dexscreener, \d\d:\d\d UTC\)$/.test(await text(page, "#r-usd")), await text(page, "#r-usd"));
  expect("total adds the priority fee and soltao's flat fee", Math.abs(total - lz - prio - Number(CONFIG.fee.lamports) / 1e9) < 2e-6, `${total} SOL`);
  expect("review names the plan and the stake", /^Stake about 0\.0\d+ TAO on root/.test(await text(page, "#r-plan")), await text(page, "#r-plan"));
  expect("review shows the transit account", /^0x[0-9a-f]{40}$/.test(await text(page, "#r-via")));
  expect("review estimates Bittensor gas in TAO", /^about 0\.00\d+ TAO$/.test(await text(page, "#r-gas")), await text(page, "#r-gas"));
  expect("sign stays disabled while the route is not live", await page.$eval("#sign", (b) => b.disabled));

  // Subnet staking: the hotkey must hold a validator slot on the chosen subnet, not merely be a
  // delegate somewhere. Live mainnet reads, as the page makes them.
  const setField = async (sel, value) => { await page.$eval(sel, (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }); if (value) await page.type(sel, value); };
  await setField("#netuid-in", "60000");
  await waitText(page, "#netuid-note", /not registered/);
  expect("a subnet that does not exist is refused before anything is sent", /Subnet 60000 is not registered/.test(await text(page, "#netuid-note")), await text(page, "#netuid-note"));
  await setField("#netuid-in", "1");
  await waitText(page, "#netuid-note", /registered hotkeys/);
  await setField("#hotkey-in", FOUNDATION_HOTKEY);
  await waitText(page, "#hotkey-note", /Not on subnet 1|Validator on subnet 1/);
  expect("a delegate with no slot on the chosen subnet is refused", /^Not on subnet 1: .* It validates elsewhere/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  expect("…and the review stays locked", (await text(page, "#r-plan")) === "—" && (await page.$eval("#sign", (b) => b.disabled)), await text(page, "#r-plan"));
  await setField("#hotkey-in", SUBNET1_OWNER_HOTKEY);
  await waitText(page, "#hotkey-note", /Validator on subnet 1|Not on subnet 1|no validator permit/);
  expect("a hotkey validating on the subnet passes, with its uid", /^Validator on subnet 1 · uid \d+/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  await waitText(page, "#r-plan", /subnet 1/);
  expect("review states the TAO going in, the subnet, and the price limit", /^Stake about 0\.0\d+ TAO on subnet 1 to .*bought as its Alpha at the pool price\. If that price is more than 2% worse/.test(await text(page, "#r-plan")), await text(page, "#r-plan"));
  await setField("#netuid-in", "2");
  expect("changing the subnet drops the hotkey's approval at once, before any re-check", /^waiting to check it on subnet 2/.test(await text(page, "#hotkey-note")) && (await text(page, "#r-plan")) === "—", `${await text(page, "#hotkey-note")} · ${await text(page, "#r-plan")}`);
  await setField("#netuid-in", "");
  await setField("#hotkey-in", VALIDATOR);
  await waitText(page, "#hotkey-note", /Registered validator/);
  await waitText(page, "#r-plan", /on root/);

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
if (want("C")) {
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
  expect("sign stays disabled until the permanent destination is acknowledged", await page.$eval("#sign", (button) => button.disabled));
  await clickEl(page, "#review-ack-check");
  await page.waitForFunction(() => !document.querySelector("#sign").disabled, { timeout: 30_000 });
  expect("sign is enabled for a funded wallet once live", true);

  await clickEl(page, "#sign");
  await page.waitForFunction(() => window.__sent || /failed|Could not/i.test(document.querySelector("#sign-note")?.textContent || ""), { timeout: 90_000 });
  const sent = await page.evaluate(() => window.__sent);
  expect("the page simulates, then hands the wallet a transaction", Boolean(sent), await text(page, "#sign-note"));
  if (sent) {
    const tx = VersionedTransaction.deserialize(Uint8Array.from(sent));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const budget = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === "ComputeBudget111111111111111111111111111111").map((ix) => Buffer.from(ix.data)[0]);
    expect(`it carries the unit limit, the priority fee, the OFT send and the fee to ${FEE_WALLET}`, keys.includes(CONFIG.taoOftProgram) && keys.includes(FEE_WALLET) && tx.message.compiledInstructions.length === 4 && budget.includes(2) && budget.includes(3), `${tx.serialize().length} bytes`);
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

// ── Run D: a route saved by the page before records were sealed, stake still on the transit account ──
// The live page before 24 Sep 2026 saved routes unsealed. One interrupted after a subnet stake but
// before the handover must still be found and handed over, but its saved destination is not trusted.
if (want("D")) {
  const secret = ed25519.utils.randomPrivateKey();
  const pubkey = base58.encode(ed25519.getPublicKey(secret));
  const expected = walletFromSignature(ed25519.sign(new TextEncoder().encode(derivationMessage(pubkey)), secret), pubkey);
  const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
  const hotkeyHex = "0xe2ee75ea11e4c5b7f5dac2e735278cfa0b1590c9856690f66653bdd85b709104";
  const legacy = { key: `soltao.stake.pending.${expected.transitAddress}`, value: JSON.stringify({ plan: "stake", hotkey: hotkeyHex, coldkey: OTHER, netuid: "17", reserveRao: "10000000", amountLd: "100000000", sig: null, at: Date.now() - 600_000 }) };
  // The chain is real except for one answer: the transit account holds 0.5 Alpha under that hotkey on
  // subnet 17 (nothing a test can put there for real), with native TAO below the sweep floor.
  const GET_STAKE = "0x" + selector("getStake(bytes32,bytes32,uint256)");
  const stakeAsked = [];
  const intercept = (req) => {
    if (req.method() !== "POST" || !req.url().startsWith(CONFIG.bittensorEvmRpc)) return false;
    const body = JSON.parse(req.postData() || "{}");
    if (Array.isArray(body) || body.method !== "eth_call" || !body.params?.[0]?.data?.startsWith(GET_STAKE)) return false;
    const d = body.params[0].data;
    stakeAsked.push({ hotkey: "0x" + d.slice(10, 74), netuid: BigInt("0x" + d.slice(138, 202)) });
    req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" + (500_000_000n).toString(16).padStart(64, "0") }) });
    return true;
  };
  const { page, problems } = await openWith({ pubkey, secret, before: legacy, intercept });
  await page.click("#connect");
  await waitText(page, "#tao-balance", /TAO/);
  await page.click("#derive");
  await waitText(page, "#resume-text", /./);
  const resumeText = await text(page, "#resume-text");
  expect("an unsealed saved route still finds the stake on the saved hotkey and subnet", stakeAsked.some((s) => s.hotkey === hotkeyHex && s.netuid === 17n), JSON.stringify(stakeAsked.map((s) => `${s.hotkey.slice(0, 10)}/${s.netuid}`)));
  expect("…offers to hand that stake over", /0\.5 Alpha staked but not yet handed over/.test(resumeText) && /hand the stake on 5HCFWv…1wgDHh to your wallet/.test(resumeText), resumeText);
  expect("…to the wallet on screen, not the saved destination", resumeText.includes(`to ${expected.address.slice(0, 6)}…${expected.address.slice(-6)}`) && /could not be verified/.test(resumeText) && resumeText.includes("It named 5FHneW…M694ty"), resumeText);
  expect("…and the finish button is available", !(await page.$eval("#resume-go", (b) => b.disabled)));
  await page.close();
}

// ── Run E: a shared link names the subnet and validator, and the validator picker ──
const setFieldE = async (page, sel, value) => { await page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, value); };
if (want("E")) {
  const secret = ed25519.utils.randomPrivateKey();
  const pubkey = base58.encode(ed25519.getPublicKey(secret));
  const { page, problems } = await openWith({ pubkey, secret, base: `${plain.base}?netuid=1&hotkey=${SUBNET1_OWNER_HOTKEY}` });
  await waitText(page, "#hotkey-note", /Validator on subnet 1|Not on subnet|Could not reach/);
  expect("a shared link fills the subnet and validator and checks them on-chain", (await page.$eval("#netuid-in", (el) => el.value)) === "1" && /^Validator on subnet 1 · uid \d+/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  const share = await page.$eval("#hotkey-note a", (a) => a.getAttribute("href")).catch(() => null);
  expect("a checked validator offers a link back to the same choice", share === `/stake/?netuid=1&hotkey=${SUBNET1_OWNER_HOTKEY}`, share);
  // The picker: lists subnet 1's permit holders, states its sort rule, and choosing fills and checks.
  expect("the picker offers this subnet's validators", (await text(page, "#pick-btn")) === "List subnet 1's validators", await text(page, "#pick-btn"));
  await clickEl(page, "#pick-btn");
  await waitText(page, "#pick-rule", /sorted by|No hotkey|Could not read/, 90_000);
  const rows = await page.$$eval("#pick-body tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  const shares = rows.map((r) => parseFloat(r[3]));
  expect("it lists permit holders with uid, take and dividend share, and states its sort rule", rows.length > 0 && /sorted by share of its validator dividends at the last epoch/.test(await text(page, "#pick-rule")) && /not a recommendation/.test(await text(page, "#pick-rule")), `${rows.length} rows · ${rows[0]?.join(" | ")}`);
  expect("…in exactly that order", shares.every((x, i) => i === 0 || shares[i - 1] >= x), shares.join(","));
  expect("the validator already chosen is marked", (await page.$$eval('#pick-body tr[aria-current="true"]', (x) => x.length)) === 1);
  const pickUid = rows.at(-1)[0];
  await page.$$eval("#pick-body tr", (trs) => trs.at(-1).querySelector("button").click());
  await waitText(page, "#hotkey-note", new RegExp(`uid ${pickUid}\\b|Holds uid|Not on subnet|Could not reach`));
  expect("choosing a row fills the hotkey and runs the normal on-chain check", new RegExp(`^Validator on subnet 1 · uid ${pickUid}\\b`).test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  await setFieldE(page, "#netuid-in", "2");
  expect("changing the subnet clears the list", (await page.$eval("#pick-wrap", (el) => el.hidden)) && (await text(page, "#pick-btn")) === "List subnet 2's validators");

  // The subnet directory: every subnet from the chain, two named orders, search, and "Use" fills the field.
  await clickEl(page, "#dir-btn");
  await waitText(page, "#dir-rule", /subnets, in subnet-number order|Could not/, 90_000);
  const dirRule = await text(page, "#dir-rule"), total = Number((dirRule.match(/of (\d+) subnets/) || [])[1]);
  const first = await page.$$eval("#dir-body tr", (trs) => trs.slice(0, 2).map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  expect("the directory lists every subnet from the chain, root first, with name, price and pool", total > 100 && first[0][0] === "0" && first[0][2] === "1 (root)" && first[1][0] === "1" && first[1][1].length > 0 && parseFloat(first[1][2]) > 0 && parseFloat(first[1][3].replace(/,/g, "")) > 0, `${total} · ${first.map((r) => r.join(" | ")).join(" / ")}`);
  expect("…and says its order, that names are not endorsements, and when it read them", /in subnet-number order\. "TAO added per day" is the TAO the chain put into that pool in the last block, times 7,200 blocks \(12 seconds each\); it moves from block to block\. Names are what each owner registered on-chain; a name is not an endorsement\. Read \d\d:\d\d UTC\./.test(dirRule), dirRule);
  await setFieldE(page, "#dir-search", "7");
  expect("search by number finds that subnet", (await page.$$eval("#dir-body tr", (trs) => trs.map((tr) => tr.firstChild.textContent))).includes("7"));
  await setFieldE(page, "#dir-search", "");
  await page.select("#dir-sort", "pool");
  const pools = await page.$$eval("#dir-body tr", (trs) => trs.map((tr) => [tr.children[0].textContent, parseFloat(tr.children[3].textContent.replace(/,/g, ""))]));
  expect("sorting by TAO in the pool orders it so, leaves root out, and says so", pools.every((p, i) => i === 0 || pools[i - 1][1] >= p[1]) && !pools.some((p) => p[0] === "0") && /sorted by TAO in each subnet's pool, most first \(root has no pool and is left out\)/.test(await text(page, "#dir-rule")), `${pools.slice(0, 3).map((p) => p.join(":")).join(" ")}`);
  await page.select("#dir-sort", "emission");
  const daily = await page.$$eval("#dir-body tr", (trs) => trs.map((tr) => [tr.children[0].textContent, parseFloat(tr.children[4].textContent.replace(/,/g, ""))]));
  expect("sorting by TAO added per day orders it so, leaves root out, and says so", daily.length > 100 && daily[0][1] > 0 && daily.every((p, i) => i === 0 || daily[i - 1][1] >= p[1]) && !daily.some((p) => p[0] === "0") && /sorted by TAO the chain adds to each subnet's pool per day, most first \(root is left out\)/.test(await text(page, "#dir-rule")), `${daily.slice(0, 3).map((p) => p.join(":")).join(" ")}`);
  await page.select("#dir-sort", "pool");
  const pickNet = pools[0][0];
  await page.$$eval("#dir-body tr", (trs) => trs[0].querySelector("button").click());
  expect("choosing a subnet fills the field and runs the usual check", (await page.$eval("#netuid-in", (el) => el.value)) === pickNet, await page.$eval("#netuid-in", (el) => el.value));
  await waitText(page, "#netuid-note", /registered hotkeys|Could not reach/);

  const who = (await text(page, ".stake-who")).replace(/\s+/g, " ");
  expect("the page says who runs it and what they can take, near the top", /never sent to them/.test(who) && /only charge is a flat SOL fee/.test(who), who);
  await clean(page, problems, "run E");
  await page.close();
}

// ── Run F: the return direction, opened here only because this is a local host ──
// Chain reads are real except the coldkey's account, answered as holding 2 TAO free so the review can
// be quoted (a fresh test wallet holds nothing). Nothing is signed or sent: the run stops at review.
if (want("F")) {
  const secret = ed25519.utils.randomPrivateKey();
  const pubkey = base58.encode(ed25519.getPublicKey(secret));
  const SYSTEM_ACCOUNT = "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9";
  const le = (v, bytes) => { let h = ""; for (let i = 0; i < bytes; i++) { h += Number((BigInt(v) >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0"); } return h; };
  // AccountInfo { nonce, consumers, providers, sufficients: u32; data { free, reserved, frozen: u64; flags: u128 } }
  const account = "0x" + le(0, 4) + le(0, 4) + le(1, 4) + le(0, 4) + le(2_000_000_000n, 8) + le(0, 8) + le(0, 8) + le(1n << 127n, 16);
  let accountReads = 0;
  // Stake positions: the chain's real answer for subnet 1's owner (two positions on subnet 1, read now),
  // served for the test wallet, so the Unstake action and its chained return can be quoted.
  const STAKE_INFO = "StakeInfoRuntimeApi_get_stake_info_for_coldkey";
  const ownerKey = "0x" + Buffer.from(ss58Decode(SUBNET1_OWNER_HOTKEY)).toString("hex");
  const stakeInfo = (await (await fetch(CONFIG.bittensorEvmRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state_call", params: [STAKE_INFO, ownerKey] }) })).json()).result;
  const intercept = (req) => {
    if (req.method() !== "POST" || !req.url().startsWith(CONFIG.bittensorEvmRpc)) return false;
    const body = JSON.parse(req.postData() || "{}");
    if (!Array.isArray(body) && body.method === "state_call" && body.params?.[0] === STAKE_INFO && stakeInfo) {
      req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: stakeInfo }) });
      return true;
    }
    // polkadot reads storage through state_queryStorageAt: [{ block, changes: [[key, value]] }].
    if (Array.isArray(body) || body.method !== "state_queryStorageAt") return false;
    const keys = body.params?.[0] || [];
    if (!keys.length || !keys.every((k) => String(k).startsWith(SYSTEM_ACCOUNT))) return false;
    accountReads++;
    const result = [{ block: "0x" + "00".repeat(32), changes: keys.map((k) => [k, account]) }];
    req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    return true;
  };
  const { page, problems } = await openWith({ pubkey, secret, intercept });
  expect("the return direction opens on a local host", !(await page.$eval('input[name="direction"][value="reverse"]', (el) => el.disabled)));
  const loadedEarly = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("return.js")));
  expect("the forward page does not download the return code", !loadedEarly);
  await page.click("#connect");
  await waitText(page, "#tao-balance", /TAO/);
  await page.click("#derive");
  await waitText(page, "#coldkey-out", /^5/);
  await page.waitForFunction(() => document.querySelector("#derive")?.textContent === "Signed", { timeout: 60_000 });
  await clickEl(page, "#phrase-ack");
  await clickEl(page, 'input[name="direction"][value="reverse"]');
  await waitText(page, "#tao-free", /TAO|unavailable/, 90_000);
  const loaded = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("return.js")).map((e) => new URL(e.name).pathname + new URL(e.name).search));
  expect("choosing the return loads its code once, by content hash", loaded.length === 1 && /^\/stake\/return\.js\?v=[0-9a-f]{8}$/.test(loaded[0]), loaded.join(","));
  expect("it reads the coldkey's free TAO", (await text(page, "#tao-free")) === "2 TAO" && accountReads > 0, `${await text(page, "#tao-free")} · ${accountReads} account reads`);
  await clickEl(page, "#holdings-btn");
  await waitText(page, "#holdings-note", /^Read \d\d:\d\d UTC|Could not/, 90_000);
  const holdings = await page.$$eval("#holdings-body tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(" | ")));
  expect("holdings show the wallet's free TAO and its stake positions, read from the chain", holdings[0] === "Free | — | 2 TAO | Stake Top up Chutes" && holdings.length === 3 && holdings.slice(1).every((h) => /^Staked on subnet 1 \| 5\w+…\w+ \| [\d,.]+ Alpha \| Unstake$/.test(h)) && /2 stake positions\. Subnet stakes are in that subnet's Alpha/.test(await text(page, "#holdings-note")), `${holdings.join(" / ")} · ${await text(page, "#holdings-note")}`);
  // Unstake, then return: offered on an unstake, and priced (sale and bridge fee) before anything is signed.
  await page.$eval("#holdings-body tr:nth-child(3) button", (b) => b.click());
  await waitText(page, "#move-quote", /Sells for about|Could not/, 60_000);
  expect("a position offers Unstake, quoted at today's price with the 2% floor", /^Sells for about [\d.,]+ TAO at today's pool price \([\d.]+ TAO per Alpha\)\. If the price is more than 2% lower when it lands, nothing is unstaked\.$/.test(await text(page, "#move-quote")) && (await text(page, "#move-title")).startsWith("Unstake from subnet 1"), await text(page, "#move-quote"));
  expect("…with the choice to bring the TAO back to Solana, off by default", !(await page.$eval("#move-then-wrap", (el) => el.hidden)) && !(await page.$eval("#move-then", (el) => el.checked)));
  await clickEl(page, "#move-then");
  await waitText(page, "#move-quote", /LayerZero fee|Could not/, 60_000);
  expect("…which, when chosen, adds the live bridge fee and what stays free", /Then that TAO goes to your Solana wallet as canonical TAO, less the LayerZero fee \(about [\d.]+ TAO today\) and a little Bittensor gas; 0\.001 TAO stays free for later fees\./.test(await text(page, "#move-quote")), await text(page, "#move-quote"));
  await clickEl(page, "#move-cancel");
  // Stake moves from the holdings view (not confirmed: nothing is signed or sent).
  expect("free TAO offers Stake and Top up Chutes on a local host", (await page.$$eval("#holdings-body tr:first-child button", (b) => b.map((x) => x.textContent))).join() === "Stake,Top up Chutes");
  await page.$eval("#holdings-body tr:first-child button", (b) => b.click());
  expect("staking asks for a checked subnet and validator from step 3 first", /Choose the subnet and a checked validator in step 3 first/.test(await text(page, "#move-quote")) && (await page.$eval("#move-go", (b) => b.disabled)), await text(page, "#move-quote"));
  await setFieldE(page, "#netuid-in", "1");
  await setFieldE(page, "#hotkey-in", SUBNET1_OWNER_HOTKEY);
  await waitText(page, "#hotkey-note", /Validator on subnet 1|Not on subnet|Could not reach/, 90_000);
  await page.$eval("#holdings-body tr:first-child button", (b) => b.click());
  await waitText(page, "#move-quote", /Buys about|Could not/, 60_000);
  expect("…then quotes the Alpha it buys at today's price, with the 2% ceiling", /^Buys about [\d.,]+ Alpha at today's pool price \([\d.]+ TAO each\)\. If the price is more than 2% higher when it lands, nothing is staked\.$/.test(await text(page, "#move-quote")), await text(page, "#move-quote"));
  expect("…from the free TAO, keeping 0.01 TAO for fees", (await text(page, "#move-title")).startsWith("Stake free TAO on subnet 1 to 5HCFWv") && (await page.$eval("#move-amount", (el) => el.value)) === "1.99", await page.$eval("#move-amount", (el) => el.value));
  await setFieldE(page, "#move-amount", "3");
  expect("…and refuses more than that", /More than the 1\.99 available/.test(await text(page, "#move-quote")) && (await page.$eval("#move-go", (b) => b.disabled)), await text(page, "#move-quote"));
  await clickEl(page, "#move-cancel");
  // Top up Chutes (not confirmed: nothing is signed or sent).
  await page.$eval("#holdings-body tr:first-child button:nth-of-type(2)", (b) => b.click());
  expect("Top up Chutes opens its own panel, closed until quoted and acknowledged", !(await page.$eval("#pay-panel", (el) => el.hidden)) && (await page.$eval("#move-panel", (el) => el.hidden)) && (await page.$eval("#pay-go", (b) => b.disabled)));
  await setFieldE(page, "#pay-to", await text(page, "#coldkey-out"));
  await waitText(page, "#pay-quote", /own address/, 10_000);
  expect("…refuses the wallet's own address", /own address/.test(await text(page, "#pay-quote")), await text(page, "#pay-quote"));
  await setFieldE(page, "#pay-to", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
  await setFieldE(page, "#pay-amount", "0.005");
  await waitText(page, "#pay-quote", /at least/, 10_000);
  expect("…refuses less than Chutes' 0.01 TAO dust floor", /Send at least 0\.01 TAO: Chutes ignores smaller payments/.test(await text(page, "#pay-quote")), await text(page, "#pay-quote"));
  await setFieldE(page, "#pay-amount", "3");
  await waitText(page, "#pay-quote", /More than/, 10_000);
  expect("…and more than the free TAO, keeping 0.01 TAO for fees", /More than the 1\.99 TAO available/.test(await text(page, "#pay-quote")) && (await page.$eval("#pay-go", (b) => b.disabled)), await text(page, "#pay-quote"));
  await setFieldE(page, "#pay-amount", "0.5");
  await waitText(page, "#pay-quote", /^Sends|Could not/, 60_000);
  expect("…quotes the transfer and its network fee from the chain", /^Sends 0\.5 TAO to 5Grwva…\w+\. Bittensor network fee about [\d.]+ TAO; [\d.]+ TAO stays free here\./.test(await text(page, "#pay-quote")) && /public "via soltao" tag/.test(await text(page, "#pay-quote")), await text(page, "#pay-quote"));
  expect("…and stays closed until the address is acknowledged", await page.$eval("#pay-go", (b) => b.disabled));
  await clickEl(page, "#pay-ack");
  expect("…then opens", !(await page.$eval("#pay-go", (b) => b.disabled)));
  await clickEl(page, "#pay-cancel");
  await setFieldE(page, "#amount", "5");
  await waitText(page, "#amount-note", /More than/);
  expect("an amount above the free TAO is refused", /More than the 2 TAO free in your Bittensor wallet/.test(await text(page, "#amount-note")), await text(page, "#amount-note"));
  await setFieldE(page, "#amount", "0.5");
  await waitText(page, "#r-receive", /TAO|—/, 90_000);
  await waitText(page, "#r-cost", /TAO/, 90_000);
  expect("the review states what arrives on Solana", /^0\.5 canonical TAO$/.test(await text(page, "#r-receive")), await text(page, "#r-receive"));
  const lz = parseFloat(await text(page, "#r-lzfee")), cost = parseFloat(await text(page, "#r-cost"));
  expect("…the LayerZero fee, quoted live in TAO", lz > 0 && lz < 0.05, `${lz} TAO`);
  expect("…and what leaves the Bittensor wallet: the amount plus fees and a gas reserve", cost > 0.5 && cost < 0.6, `${cost} TAO`);
  expect("…to the connected Solana wallet", (await text(page, "#r-dest")).startsWith(pubkey));
  expect("signing is open for the return once quoted", !(await page.$eval("#sign", (b) => b.disabled)), await text(page, "#sign-note"));
  await clean(page, problems, "run F");
  await page.close();
}

await browser.close();
plain.server.close(); live.server.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
