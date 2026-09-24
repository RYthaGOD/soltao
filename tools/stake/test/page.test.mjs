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
{
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
{
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
  const prio = parseFloat(await text(page, "#r-prio"));
  expect("a Solana priority fee is quoted and shown", prio > 0 && prio <= Number(CONFIG.priorityFee.maxMicroLamports * BigInt(CONFIG.computeUnits)) / 1e15 + 1e-9, `${prio} SOL`);
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
{
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

// ── Run E: a shared link names the subnet and validator ──
{
  const secret = ed25519.utils.randomPrivateKey();
  const pubkey = base58.encode(ed25519.getPublicKey(secret));
  const { page, problems } = await openWith({ pubkey, secret, base: `${plain.base}?netuid=1&hotkey=${SUBNET1_OWNER_HOTKEY}` });
  await waitText(page, "#hotkey-note", /Validator on subnet 1|Not on subnet|Could not reach/);
  expect("a shared link fills the subnet and validator and checks them on-chain", (await page.$eval("#netuid-in", (el) => el.value)) === "1" && /^Validator on subnet 1 · uid \d+/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  const share = await page.$eval("#hotkey-note a", (a) => a.getAttribute("href")).catch(() => null);
  expect("a checked validator offers a link back to the same choice", share === `/stake/?netuid=1&hotkey=${SUBNET1_OWNER_HOTKEY}`, share);
  const who = (await text(page, ".stake-who")).replace(/\s+/g, " ");
  expect("the page says who runs it and what they can take, near the top", /never sent to them/.test(who) && /only charge is a flat SOL fee/.test(who), who);
  await clean(page, problems, "run E");
  await page.close();
}

await browser.close();
plain.server.close(); live.server.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
