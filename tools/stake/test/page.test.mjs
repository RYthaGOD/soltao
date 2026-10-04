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
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { derivationMessage, walletFromSignature } from "../src/derive.js";
import { CONFIG, bittensorRpcs } from "../src/config.js";
import { sealRoute } from "../src/pending.js";
import { createClients, getTaoBalance, getSoltaoBalance } from "../src/solana.js";
import { selector } from "../src/bittensor.js";
import { ss58Decode } from "../src/derive.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
// Real TAO + SOL holders, read-only use. Run C types 0.1 TAO, so the first one that still holds that, some SOL, and
// no $SOLTAO discount is used (E7wd… fell to 0.088 TAO by 4 Oct 2026). SIM_HOLDER pins one; test/solana.test.mjs
// keeps the same list.
const HOLDER = await (async () => {
  const list = process.env.SIM_HOLDER ? [process.env.SIM_HOLDER] : [
    "D1pmdPxohdDrk45f3gcwfq2EidAPNJkwvq32rBRzKPZk",
    "FkaLnX17cXZGyeu3kZGdHCNdFMJJzBrPPYVvd18B3MZp",
    "4muvDhac3U8CqtckUiL7U4EJDucnL1k5AGAxdWh2QV7F",
    "E7wdV5qCYL1fZJf6YfvHEyheAeow67Mf7BTpByX89mNQ",
  ];
  const { connection } = createClients();
  for (const h of list) {
    const [tao, sol, soltao] = await Promise.all([getTaoBalance(connection, h), connection.getBalance(new PublicKey(h)), getSoltaoBalance(connection, h)]);
    if (tao >= 100_000_000n && sol >= 50_000_000 && soltao < 10_000_000n * 1_000_000n) return h;
  }
  return list.at(-1);
})();
const VALIDATOR = "5CoZxgtfhcJKX2HmkwnsN18KbaT9aih9eF3b6qVPTgAUbifj"; // a registered delegate (test data, not a pick)
// Test data, not picks. Opentensor Foundation's hotkey is a delegate that held no uid on subnet 1 on
// 24 Sep 2026; subnet 1's owner hotkey held uid 248 there with a validator permit.
const FOUNDATION_HOTKEY = "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3";
const SUBNET1_OWNER_HOTKEY = "5HCFWvRqzSHWRPecN7q8J6c7aKQnrCZTMHstPv39xL1wgDHh";
// Run C checks the fee goes to the configured wallet, or to a stand-in if none is configured yet.
const FEE_WALLET = CONFIG.fee.wallet ?? "11111111111111111111111111111112";
const btRpc = (url) => bittensorRpcs().some((u) => url.startsWith(u));

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
  expect("the plain page has no subnet card; only a subnet link opens one", await hidden(page, "#subnet-card"));
  // Wallet providers share this page's globals; a stand-in `process` or `Buffer` here can break them.
  const globals = await page.evaluate(() => ({ process: typeof window.process, Buffer: typeof window.Buffer }));
  expect("the page adds no Node globals (process, Buffer) a wallet could trip over", globals.process === "undefined" && globals.Buffer === "undefined", JSON.stringify(globals));
  expect("steps 2–5 start locked", (await attr(page, "#step-coldkey", "data-state")) === "locked" && (await attr(page, "#step-review", "data-state")) === "locked");
  await page.click("#connect");
  await waitText(page, "#tao-balance", /TAO/);
  expect("connect shows the wallet and a TAO balance", (await text(page, "#tao-balance")) === "0 TAO", await text(page, "#tao-balance"));
  const swap = await page.$eval("#connect-note a", (a) => a.href).catch(() => "");
  expect("a wallet with no TAO is pointed at a SOL→canonical TAO swap, by mint", swap === `https://jup.ag/swap/So11111111111111111111111111111111111111112-${CONFIG.taoMint}` && /Check again/.test(await text(page, "#connect-note")), swap);
  expect("…and told how much it needs to stake, before buying", /To stake, you need at least 0\.0\d+ TAO/.test(await text(page, "#connect-note")), await text(page, "#connect-note"));

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
  const words = await page.$$eval("#phrase li", (lis) => lis.map((li) => li.textContent).join(" "));
  expect("the recovery phrase is shown as soon as the wallet is created", words === expected.mnemonic);
  expect("the acknowledgement is that those words were saved", (await text(page, "#phrase-box")).includes("I saved these 12 words.") && !(await text(page, "#phrase-box")).includes("Solana wallet only"));
  await page.click("#phrase-toggle");
  expect("hiding the phrase removes it from the DOM", (await page.$$("#phrase li")).length === 0);
  await page.click("#phrase-toggle");
  expect("showing it again puts the same 12 words back", (await page.$$eval("#phrase li", (lis) => lis.map((li) => li.textContent).join(" "))) === expected.mnemonic);
  await clickEl(page, "#phrase-ack");
  expect("acknowledging unlocks step 3", (await attr(page, "#step-plan", "data-state")) === "active");

  await clickEl(page, 'input[name="ck-mode"][value="paste"]');
  expect("paste mode hides the derived phrase", await hidden(page, "#phrase-box"));
  expect("paste mode says this address cannot be brought back to Solana", /cannot be brought back to Solana/.test(await page.$eval('input[name="ck-mode"][value="paste"]', (el) => el.closest("label").textContent)));
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
  expect("reads a real holder's TAO balance", /^[\d,]+(\.\d+)? TAO$/.test(await text(page, "#tao-balance")), await text(page, "#tao-balance"));

  await page.click("#derive");
  await waitText(page, "#coldkey-out", /^5/);
  expect("a signature that does not verify as raw ed25519 gets the save-the-phrase warning", (await attr(page, "#derive-note", "data-tone")) === "warn");
  await page.waitForFunction(() => document.querySelector("#derive")?.textContent === "Signed", { timeout: 60_000 });
  expect("an empty transit account shows no unfinished route", await hidden(page, "#resume"));
  await clickEl(page, "#phrase-ack");
  await waitText(page, "#amount-hint", /Staking needs/, 30_000);
  expect("step 3 states the staking minimum before an amount is typed", /^Staking needs at least 0\.0\d+ TAO( \(about \$[\d.,]+\))? at today's gas price\. Less can only be delivered unstaked\.$/.test(await text(page, "#amount-hint")), await text(page, "#amount-hint"));

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
  {
    const share = await text(page, "#r-share"), pct = parseFloat(share.replace(/^about /, "")) || 0;
    const warned = (await attr(page, "#share-note", "data-tone")) === "warn" && /mostly flat/.test(await text(page, "#share-note"));
    expect("the review states fees as a share of the amount, and warns from 10%", /^(about [\d.]+%|under 1%)$/.test(share) && warned === pct >= 10, `${share} · ${await text(page, "#share-note") || "no warning"}`);
  }
  const feeText = await text(page, "#r-fee"), soltaoFee = parseFloat(feeText);
  expect("soltao's fee is 0.25% of the TAO sent in SOL, at least 0.0035 SOL, and says so, with the price it used", soltaoFee >= 0.0035 && /^[\d.]+ SOL( → BgGF…72Na)? \(0\.25%, at least 0\.0035 SOL; 1 TAO = [\d.]+ SOL at the Orca TAO\/SOL pool\)$/.test(feeText), feeText);
  expect("total adds the priority fee and soltao's fee", Math.abs(total - lz - prio - soltaoFee) < 2e-6, `${total} SOL`);
  expect("review names the plan and the stake", /^Stake about 0\.0\d+ TAO on root/.test(await text(page, "#r-plan")), await text(page, "#r-plan"));
  expect("review names how to get the stake back, and that both steps have moved real funds", /^Unstake from Your Bittensor holdings in step 2, then Back to Solana\. Both have moved real funds through this page\. The return quotes a live bridge fee then, plus 0\.25%\.$/.test(await text(page, "#r-later")), await text(page, "#r-later"));
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
  await waitText(page, "#netuid-note", /registered hotkeys|Could not reach/, 120_000);
  await setField("#hotkey-in", FOUNDATION_HOTKEY);
  await waitText(page, "#hotkey-note", /Not on subnet 1|Validator on subnet 1/, 120_000);
  expect("a delegate with no slot on the chosen subnet is refused", /^Not on subnet 1: .* It validates elsewhere/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  expect("…and the review stays locked", (await text(page, "#r-plan")) === "—" && (await page.$eval("#sign", (b) => b.disabled)), await text(page, "#r-plan"));
  await setField("#hotkey-in", SUBNET1_OWNER_HOTKEY);
  await waitText(page, "#hotkey-note", /Validator on subnet 1|Not on subnet 1|no validator permit/);
  expect("a hotkey validating on the subnet passes, with its uid", /^Validator on subnet 1 · uid \d+/.test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  await waitText(page, "#r-plan", /subnet 1/);
  expect("review states the TAO going in, the subnet, and the price limit", /^Stake about 0\.0\d+ TAO on subnet 1 to .*bought as its Alpha at the pool price\. If that price is more than 2% worse/.test(await text(page, "#r-plan")), await text(page, "#r-plan"));
  await waitText(page, "#r-plan", /Today that buys about/, 60_000).catch(() => {});
  expect("…and what that buys today, from the chain's own swap simulation", /Today that buys about [\d.,]+ Alpha: a pool fee of [\d.]+ TAO and [\d.]+% price impact, per the chain's own simulation\./.test(await text(page, "#r-plan")), await text(page, "#r-plan"));
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
  expect("'just deliver' still names how to get it back", /^Back to Solana in the toggle above\. The return quotes a live bridge fee then, plus 0\.25%\.$/.test(await text(page, "#r-later")), await text(page, "#r-later"));
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
  expect("'just deliver' names how to get it back", /^Back to Solana in the toggle above\. The return quotes a live bridge fee then, plus 0\.25%\.$/.test(await text(page, "#r-later")), await text(page, "#r-later"));
  expect("sign stays disabled until the permanent destination is acknowledged", await page.$eval("#sign", (button) => button.disabled));
  await clickEl(page, "#review-ack-check");
  await page.waitForFunction(() => !document.querySelector("#sign").disabled, { timeout: 30_000 });
  expect("sign is enabled for a funded wallet once live", true);

  // A tiny delivery: the flat fees are most of it, so signing waits for an explicit acknowledgement.
  await page.$eval("#amount", (el) => { el.value = ""; });
  await page.type("#amount", "0.01");
  await page.waitForFunction(() => !document.querySelector("#share-ack-box").hidden || /price feed unavailable/.test(document.querySelector("#r-usd").textContent), { timeout: 60_000 });
  const tiny = { share: await text(page, "#r-share"), note: await text(page, "#share-note"), tone: await attr(page, "#share-note", "data-tone"), sign: await page.$eval("#sign", (b) => b.disabled) };
  expect("fees over 25% of the amount are stated in money, with the amount where they fall under 10%, and signing stays shut", !(await hidden(page, "#share-ack-box")) && tiny.tone === "bad" && /^Fees would take about \d+% of this amount: about \$[\d.,]+ in fees to move \$[\d.,]+\. From about [\d.]+ TAO, the same fees would be under 10%\.$/.test(tiny.note) && tiny.sign, `${tiny.share} · ${tiny.note}`);
  await clickEl(page, "#share-ack");
  await page.waitForFunction(() => !document.querySelector("#sign").disabled, { timeout: 30_000 }).catch(() => {});
  expect("…and opens once those fees are accepted", !(await page.$eval("#sign", (b) => b.disabled)));
  await page.$eval("#amount", (el) => { el.value = ""; });
  await page.type("#amount", "0.1");
  await page.waitForFunction(() => document.querySelector("#share-ack-box").hidden && !document.querySelector("#sign").disabled, { timeout: 60_000 }).catch(() => {});
  expect("a larger amount needs no such acknowledgement", (await hidden(page, "#share-ack-box")) && !(await page.$eval("#sign", (b) => b.disabled)), await text(page, "#r-share"));

  const reviewFee = await text(page, "#r-fee");
  await clickEl(page, "#sign");
  await page.waitForFunction(() => window.__sent || /failed|Could not/i.test(document.querySelector("#sign-note")?.textContent || ""), { timeout: 90_000 });
  const sent = await page.evaluate(() => window.__sent);
  expect("the page simulates, then hands the wallet a transaction", Boolean(sent), await text(page, "#sign-note"));
  if (sent) {
    const tx = VersionedTransaction.deserialize(Uint8Array.from(sent));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const budget = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === "ComputeBudget111111111111111111111111111111").map((ix) => Buffer.from(ix.data)[0]);
    expect(`it carries the unit limit, the priority fee, the OFT send and the fee to ${FEE_WALLET}`, keys.includes(CONFIG.taoOftProgram) && keys.includes(FEE_WALLET) && tx.message.compiledInstructions.length === 4 && budget.includes(2) && budget.includes(3), `${tx.serialize().length} bytes`);
    // The fee signed is exactly the one the review showed: 0.25% of the 0.1 TAO in SOL, here the 0.0035 SOL floor.
    const transfer = tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === "11111111111111111111111111111111");
    const signedFee = transfer ? Buffer.from(transfer.data).readBigUInt64LE(4) : null;
    const shownFee = BigInt(Math.round(parseFloat(reviewFee) * 1e9));
    expect("…and the fee it signs is exactly the one the review showed", signedFee !== null && signedFee === shownFee && signedFee >= CONFIG.fee.minLamports, `${signedFee} vs shown ${shownFee}`);
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
    if (req.method() !== "POST" || !btRpc(req.url())) return false;
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
  // The link makes this subnet 1's page: its on-chain identity and pool on top, labelled as the owner's.
  await waitText(page, "#subnet-note", /registered on Bittensor|Could not read|has no subnet/, 90_000);
  const card = { hidden: await page.$eval("#subnet-card", (el) => el.hidden), n: await text(page, "#subnet-card-n"), h: await text(page, "#subnet-card-h"), price: await text(page, "#subnet-price"), pool: await text(page, "#subnet-pool"), validator: await text(page, "#subnet-validator"), note: await text(page, "#subnet-note"), title: await page.title() };
  expect("a subnet link opens that subnet's page, with its registered name, pool and the linked validator", !card.hidden && card.n === "1" && card.h.length > 0 && /^[\d,.]+ TAO$/.test(card.price) && /^[\d,]+ TAO$/.test(card.pool) && card.validator.startsWith(SUBNET1_OWNER_HOTKEY.slice(0, 6)) && /soltao has not checked them and does not endorse this subnet/.test(card.note) && /^Stake on .+ from your Solana wallet — soltao$/.test(card.title), JSON.stringify(card));
  const cardLinks = await page.$$eval("#subnet-links a", (as) => as.map((a) => [a.href, a.rel, a.target]));
  expect("…with the owner's links, https only, opening elsewhere", cardLinks.every(([href, rel, target]) => href.startsWith("https://") && /noopener/.test(rel) && target === "_blank"), JSON.stringify(cardLinks));
  // The picker: lists subnet 1's permit holders, states its sort rule, and choosing fills and checks.
  expect("the picker offers this subnet's validators", (await text(page, "#pick-btn")) === "List subnet 1's validators", await text(page, "#pick-btn"));
  await clickEl(page, "#pick-btn");
  await waitText(page, "#pick-rule", /sorted by|No hotkey|Could not read/, 90_000);
  const rows = await page.$$eval("#pick-body tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  const shares = rows.map((r) => parseFloat(r[3]));
  expect("it lists permit holders with uid, take and dividend share, and states its sort rule", rows.length > 0 && /sorted by share of its validator dividends at the last epoch/.test(await text(page, "#pick-rule")) && /not a recommendation/.test(await text(page, "#pick-rule")), `${rows.length} rows · ${rows[0]?.join(" | ")}`);
  expect("…in exactly that order", shares.every((x, i) => i === 0 || shares[i - 1] >= x), shares.join(","));
  expect("…with what each paid its stakers over 30 days, and how that figure is made", rows.every((r) => /^([+−]?\d+\.\d%|—)$/.test(r[4])) && rows.some((r) => r[4] !== "—") && /"Paid stakers" is how much one share of each validator's stake pool grew, in the subnet's Alpha/.test(await text(page, "#pick-rule")), rows.map((r) => r[4]).join(","));
  expect("the validator already chosen is marked", (await page.$$eval('#pick-body tr[aria-current="true"]', (x) => x.length)) === 1);
  const pickUid = rows.at(-1)[0];
  await page.$$eval("#pick-body tr", (trs) => trs.at(-1).querySelector("button").click());
  await waitText(page, "#hotkey-note", new RegExp(`uid ${pickUid}\\b|Holds uid|Not on subnet|Could not reach`));
  expect("choosing a row fills the hotkey and runs the normal on-chain check", new RegExp(`^Validator on subnet 1 · uid ${pickUid}\\b`).test(await text(page, "#hotkey-note")), await text(page, "#hotkey-note"));
  await setFieldE(page, "#netuid-in", "2");
  expect("changing the subnet clears the list", (await page.$eval("#pick-wrap", (el) => el.hidden)) && (await text(page, "#pick-btn")) === "List subnet 2's validators");

  // The route is on the page. The directory opens itself: every subnet from the chain, named orders, search, and a tap fills the field.
  expect("the route sits on the page, outside How it works", await page.$eval("ol.stake-hops.dir-fwd", (el) => !el.hidden && !el.closest("details") && el.querySelectorAll("li").length === 4));
  await clickEl(page, "#dir-btn");
  await waitText(page, "#dir-rule", /subnets, in subnet-number order|Could not/, 90_000);
  const dirRule = await text(page, "#dir-rule"), total = Number((dirRule.match(/of (\d+) subnets/) || [])[1]);
  const dirRows = () => page.$$eval("#dir-body .dir-row", (rows) => rows.map((row) => ({
    id: row.querySelector(".dir-id").textContent,
    name: row.querySelector(".dir-name").textContent,
    price: row.querySelector(".dir-price .dir-v").textContent,
    pool: row.querySelector(".dir-pool .dir-v").textContent,
    day: row.querySelector(".dir-day .dir-v").textContent,
    ch7: row.querySelector(".dir-ch7").textContent.trim(),
    ch30: row.querySelector(".dir-ch30").textContent.trim(),
    spark: Boolean(row.querySelector(".dir-ch30 svg.spark")),
  })));
  const first = await dirRows();
  expect("the directory lists every subnet from the chain, root first, with name, price and pool", total > 100 && first[0].id === "0" && first[0].price === "1 (root)" && first[1].id === "1" && first[1].name.length > 0 && parseFloat(first[1].price) > 0 && parseFloat(first[1].pool.replace(/,/g, "")) > 0, `${total} · ${first.slice(0, 2).map((r) => [r.id, r.name, r.price, r.pool].join(" | ")).join(" / ")}`);
  expect("Show subnets stays on the page after a good read, so the list can be read again", await page.$eval("#dir-btn", (el) => !el.hidden && !el.disabled && el.textContent === "Read again"));
  expect("…and says its order, that names are not endorsements, and when it read them", /in subnet-number order\. "TAO added per day" is the TAO the chain put into that pool in the last block, times 7,200 blocks \(12 seconds each\), after the chain's emission cut; it moves from block to block\. The chain's emission midpoint is rank \d+ by moving price: that subnet keeps half of what its price alone would earn, those above it keep more, and those below keep less, down to a drip\. The 7 and 30 day changes compare today's price with soltao's daily readings to \d+ \w{3} \d{4}; a past move says nothing about the next one\. Names are what each owner registered on-chain; a name is not an endorsement\. Read \d\d:\d\d UTC\./.test(dirRule), dirRule);
  await setFieldE(page, "#dir-search", "7");
  expect("search by number finds that subnet", (await dirRows()).some((r) => r.id === "7"));
  await setFieldE(page, "#dir-search", "");
  await page.select("#dir-sort", "pool");
  const pools = (await dirRows()).map((r) => [r.id, parseFloat(r.pool.replace(/,/g, ""))]);
  expect("sorting by TAO in the pool orders it so, leaves root out, and says so", pools.every((p, i) => i === 0 || pools[i - 1][1] >= p[1]) && !pools.some((p) => p[0] === "0") && /sorted by TAO in each subnet's pool, most first \(root has no pool and is left out\)/.test(await text(page, "#dir-rule")), `${pools.slice(0, 3).map((p) => p.join(":")).join(" ")}`);
  await page.select("#dir-sort", "emission");
  const daily = (await dirRows()).map((r) => [r.id, parseFloat(r.day.replace(/,/g, ""))]);
  expect("sorting by TAO added per day orders it so, leaves root out, and says so", daily.length > 100 && daily[0][1] > 0 && daily.every((p, i) => i === 0 || daily[i - 1][1] >= p[1]) && !daily.some((p) => p[0] === "0") && /sorted by TAO the chain adds to each subnet's pool per day, most first \(root is left out\)/.test(await text(page, "#dir-rule")), `${daily.slice(0, 3).map((p) => p.join(":")).join(" ")}`);
  // 7 and 30 day changes from soltao's daily history, with a 30-day sparkline.
  const pct = (s) => { const m = s.match(/[+−-]?\d+\.\d%/); return m ? Number(m[0].replace("−", "-").replace(/[+%]/g, "")) : null; };
  await page.select("#dir-sort", "change7");
  const moves = await dirRows();
  const ch = moves.map((m) => pct(m.ch7)).filter((v) => v !== null);
  expect("each subnet shows its 7 and 30 day price change, with a 30-day sparkline", ch.length > 100 && moves.filter((m) => m.spark).length > 100 && moves.slice(0, 3).every((m) => /^[+−]?\d+\.\d%$/.test(m.ch7) && /[+−]?\d+\.\d%$/.test(m.ch30)), moves.slice(0, 3).map((m) => [m.id, m.ch7, m.ch30].join(":")).join(" "));
  expect("sorting by 7-day change orders it so, leaves root out, and says a past move predicts nothing", ch.every((v, i) => i === 0 || ch[i - 1] >= v) && !moves.some((m) => m.id === "0") && /most risen first/.test(await text(page, "#dir-rule")) && /a past move says nothing about the next one/.test(await text(page, "#dir-rule")), ch.slice(0, 3).join(", "));
  await page.select("#dir-sort", "pool");
  const pickNet = pools[0][0];
  await page.$$eval("#dir-body .dir-row", (rows) => rows[0].click());
  expect("choosing a subnet fills the field and runs the usual check", (await page.$eval("#netuid-in", (el) => el.value)) === pickNet, await page.$eval("#netuid-in", (el) => el.value));
  const dirLink = await page.$eval("#dir-share a", (a) => a.getAttribute("href")).catch(() => null);
  expect("…and opens that subnet's chart with a link to its page", dirLink === `/stake/?netuid=${pickNet}` && (await page.$eval("#dir-detail", (el) => el.hidden)) === false, dirLink);
  await waitText(page, "#netuid-note", /registered hotkeys|Could not reach/);

  const who = (await text(page, ".stake-who")).replace(/\s+/g, " ");
  expect("the page says who runs it and what they can take, near the top", /never sent to them/.test(who) && /only charge is\s+0\.25% of what you move, shown before you sign/.test(who), who);
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
  // Root rewards waiting: one validator owes 0.003 TAO (over the chain's 0.0005 TAO claim minimum).
  // Vec<(AccountId32, owed shares u64, payout u64)>, SCALE: compact length 1, then the tuple.
  const BASKET = "BetaBasketRuntimeApi_get_root_basket_positions";
  const basket = "0x04" + ownerKey.slice(2) + le(1_000_000n, 8) + le(3_000_000n, 8);
  const intercept = (req) => {
    if (req.method() !== "POST" || !btRpc(req.url())) return false;
    const body = JSON.parse(req.postData() || "{}");
    if (!Array.isArray(body) && body.method === "state_call" && body.params?.[0] === STAKE_INFO && stakeInfo) {
      req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: stakeInfo }) });
      return true;
    }
    if (!Array.isArray(body) && body.method === "state_call" && body.params?.[0] === BASKET) {
      req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: basket }) });
      return true;
    }
    // polkadot reads storage through state_queryStorageAt: [{ block, changes: [[key, value]] }].
    if (Array.isArray(body) || body.method !== "state_queryStorageAt") return false;
    const keys = body.params?.[0] || [];
    // polkadot can batch reads made in the same tick (the holdings read the root claim minimum beside the
    // balance), so answer any batch holding an account key, and read its other keys from the live chain.
    const isAccount = (k) => String(k).startsWith(SYSTEM_ACCOUNT);
    if (!keys.some(isAccount)) return false;
    accountReads++;
    const others = keys.filter((k) => !isAccount(k));
    if (others.length) {
      fetch(CONFIG.bittensorEvmRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state_queryStorageAt", params: [others, ...(body.params || []).slice(1)] }) })
        .then((r) => r.json()).catch(() => null)
        .then((live) => {
          const got = new Map(live?.result?.[0]?.changes ?? []);
          const result = [{ block: live?.result?.[0]?.block ?? "0x" + "00".repeat(32), changes: keys.map((k) => [k, isAccount(k) ? account : got.get(k) ?? null]) }];
          req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
        });
      return true;
    }
    const result = [{ block: "0x" + "00".repeat(32), changes: keys.map((k) => [k, account]) }];
    req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
    return true;
  };
  const { page, problems } = await openWith({ pubkey, secret, intercept });
  expect("the return direction opens on a local host", !(await page.$eval('input[name="direction"][value="reverse"]', (el) => el.disabled)));
  const loadedEarly = await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("return.js")));
  expect("the open subnet list loads the Bittensor code", loadedEarly);
  await page.click("#connect");
  await waitText(page, "#tao-balance", /TAO/);
  await clickEl(page, 'input[name="direction"][value="reverse"]');
  expect("before the signature, the Bittensor rows say to sign instead of spinning", (await text(page, "#tao-staked")) === "sign in step 2" && (await text(page, "#tao-free")) === "sign in step 2");
  await clickEl(page, 'input[name="direction"][value="forward"]');
  await page.click("#derive");
  await waitText(page, "#coldkey-out", /^5/);
  await page.waitForFunction(() => document.querySelector("#derive")?.textContent === "Signed", { timeout: 60_000 });
  await clickEl(page, "#phrase-ack");
  await clickEl(page, 'input[name="direction"][value="reverse"]');
  await waitText(page, "#tao-free", /TAO|unavailable/, 90_000);
  const loaded = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("return.js")).map((e) => new URL(e.name).pathname + new URL(e.name).search));
  expect("choosing the return loads its code once, by content hash", loaded.length === 1 && /^\/stake\/return\.js\?v=[0-9a-f]{8}$/.test(loaded[0]), loaded.join(","));
  expect("it reads the coldkey's free TAO", (await text(page, "#tao-free")) === "2 TAO" && (await text(page, "#tao-staked")) === "see step 2 to unstake" && accountReads > 0, `${await text(page, "#tao-free")} · ${await text(page, "#tao-staked")} · ${accountReads} account reads`);
  await clickEl(page, "#holdings-btn");
  await waitText(page, "#holdings-note", /^Read \d\d:\d\d UTC|Could not/, 90_000);
  const holdings = await page.$$eval("#holdings-body tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim()).join(" | ")));
  expect("holdings show free TAO and each stake position with its worth in TAO, read from the chain", holdings[0] === "Free | — | 2 TAO | 2 TAO | Stake Top up Chutes" && holdings.length === 4 && holdings.slice(1, 3).every((h) => /^Staked on subnet 1 \| 5\w+…\w+(paid stakers [+−]?\d+\.\d% in 30 days; the best here [+−]?\d+\.\d%)? \| [\d,.]+ Alpha \| ≈ [\d,.]+ TAO \| Unstake Move Profile$/.test(h)) && /2 stake positions\. Subnet stakes are in that subnet's Alpha and collect their rewards in the stake itself; root stakes are in TAO\./.test(await text(page, "#holdings-note")), `${holdings.join(" / ")} · ${await text(page, "#holdings-note")}`);
  expect("holdings disclose the stake route and Unstake have carried real funds, and that Move/Claim/Stake from this list have not", /has carried real funds/.test(await text(page, "#holdings-limits")) && /So has Unstake from this list/.test(await text(page, "#holdings-limits")) && /Move, Claim, and staking more from this list/.test(await text(page, "#holdings-limits")) && /Move and Claim have not yet moved real funds through this page/.test(await text(page, "#holdings-prompt")) && /Unstake here has carried real funds\. Move, Stake and Claim have not yet\./.test(await text(page, "#holdings-note")));
  expect("root rewards waiting with a validator are listed with a Claim, and counted in the total", /^Root rewards \| 5\w+…\w+ \| —waiting to be claimed \| ≈ 0\.003 TAO \| Claim$/.test(holdings[3] || "") && /0\.003 TAO is waiting in the validator's basket of subnet tokens, and "Claim" sells that slice and adds the TAO to your root stake\. Each claim pays a Bittensor fee \(about 0\.008 TAO on 25 Sep 2026\), so it only pays off once more than that has built up\.(?: Subnet \d+ is past the emission midpoint \(moving-price rank \d+\)\.)*(?: The chain pays those less than their price alone would earn, down to a drip\.)? Worth about [\d,.]+ TAO in all.*counting rewards still to claim/.test(await text(page, "#holdings-note")), `${holdings[3]} · ${await text(page, "#holdings-note")}`);
  await page.$eval("#holdings-body tr:nth-child(4) button", (b) => b.click());
  await waitText(page, "#move-quote", /^Claims about|Could not|The Bittensor fee/, 60_000);
  // The real claim fee (read live, about 0.008 TAO on 25 Sep) is more than the 0.003 TAO served here.
  expect("Claim is priced before anything is signed, has no amount to enter, and warns when its fee outweighs the rewards", /^Claims about 0\.003 TAO by selling your slice of this validator's basket, and adds the TAO to your root stake with this validator\. Bittensor reserves a network fee of about [\d.]+ TAO from free TAO and charges what the claim actually used, which can be less\..* The fees are more than the rewards waiting, so claiming now can cost more than it pays/.test(await text(page, "#move-quote")) && (await text(page, "#move-title")).startsWith("Claim root rewards from 5") && (await page.$eval("#move-amount-wrap", (el) => el.hidden)) && !(await page.$eval("#move-go", (b) => b.disabled)), await text(page, "#move-quote"));
  await clickEl(page, "#move-cancel");
  // The next read compares with this one: make the stored look 0.001 Alpha smaller, as if rewards arrived since.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith("soltao.stake.lastlook."))) {
      const look = JSON.parse(localStorage.getItem(k));
      for (const p of Object.keys(look.pos)) look.pos[p] = String(BigInt(look.pos[p]) - 1_000_000n);
      localStorage.setItem(k, JSON.stringify(look));
    }
  });
  await clickEl(page, "#holdings-btn");
  await waitText(page, "#holdings-note", /^Read \d\d:\d\d UTC.*since you last looked|Could not/, 90_000);
  const changes = await page.$$eval("#holdings-body .holdings-change", (s) => s.map((x) => x.textContent).filter((t) => / since /.test(t)));
  expect("a later read shows what each position gained since the last look, and that it may not all be rewards", changes.length === 2 && changes.every((c) => /^\+0\.001 Alpha since \d\d-\d\d \d\d:\d\d UTC$/.test(c)) && /include rewards and anything added or taken out elsewhere/.test(await text(page, "#holdings-note")), changes.join(" / "));
  // Unstake, then return: offered on an unstake, and priced (sale and bridge fee) before anything is signed.
  await page.$eval("#holdings-body tr:nth-child(3) button", (b) => b.click());
  await waitText(page, "#move-quote", /Sells for about|Could not/, 60_000);
  expect("a position offers Unstake, quoted from the chain's own swap simulation, with the 2% floor", /^Sells for about [\d.,]+ TAO: a pool fee of [\d.]+ Alpha and [\d.]+% price impact, per the chain's own simulation\. If the price is more than 2% lower when it lands, nothing is unstaked\. soltao's fee: [\d.]+ TAO \(0\.25%, at least 0\.001 TAO\), in the same transaction, out of what it frees; if the chain refuses the unstake, no fee is paid\.$/.test(await text(page, "#move-quote")) && (await text(page, "#move-title")).startsWith("Unstake from subnet 1"), await text(page, "#move-quote"));
  expect("…with the choice to bring the TAO back to Solana, off by default", !(await page.$eval("#move-then-wrap", (el) => el.hidden)) && !(await page.$eval("#move-then", (el) => el.checked)));
  await clickEl(page, "#move-then");
  await waitText(page, "#move-quote", /LayerZero fee|Could not/, 60_000);
  expect("…which, when chosen, adds the live bridge fee and what stays free", /Then that TAO goes to your Solana wallet as canonical TAO, less the LayerZero fee \(about [\d.]+ TAO today\), soltao's fee on the return and a little Bittensor gas; 0\.001 TAO stays free for later fees\./.test(await text(page, "#move-quote")), await text(page, "#move-quote"));
  await clickEl(page, "#move-cancel");
  // Stake moves from the holdings view (not confirmed: nothing is signed or sent).
  expect("free TAO offers Stake and Top up Chutes on a local host", (await page.$$eval("#holdings-body tr:first-child button", (b) => b.map((x) => x.textContent))).join() === "Stake,Top up Chutes");
  await page.$eval("#holdings-body tr:first-child button", (b) => b.click());
  await waitText(page, "#move-quote", /Choose the subnet and a checked validator in step 3 first|Could not/, 30_000);
  expect("staking asks for a checked subnet and validator from step 3 first", /Choose the subnet and a checked validator in step 3 first/.test(await text(page, "#move-quote")) && (await page.$eval("#move-go", (b) => b.disabled)), await text(page, "#move-quote"));
  await setFieldE(page, "#netuid-in", "1");
  await setFieldE(page, "#hotkey-in", SUBNET1_OWNER_HOTKEY);
  await waitText(page, "#hotkey-note", /Validator on subnet 1|Not on subnet|Could not reach/, 90_000);
  await page.$eval("#holdings-body tr:first-child button", (b) => b.click());
  await waitText(page, "#move-quote", /Buys about|Could not/, 60_000);
  expect("…then quotes the Alpha it buys from the chain's own swap simulation, with the 2% ceiling", /^Buys about [\d.,]+ Alpha: a pool fee of [\d.]+ TAO and [\d.]+% price impact, per the chain's own simulation\. If the price is more than 2% higher when it lands, nothing is staked\. soltao's fee: [\d.]+ TAO \(0\.25%, at least 0\.001 TAO\), in the same transaction; if the chain refuses the stake, no fee is paid\.$/.test(await text(page, "#move-quote")), await text(page, "#move-quote"));
  expect("…from the free TAO, keeping 0.01 TAO for fees and room for soltao's 0.25% (1.99 less 0.004975)", (await text(page, "#move-title")).startsWith("Stake free TAO on subnet 1 to 5HCFWv") && (await page.$eval("#move-amount", (el) => el.value)) === "1.985025", await page.$eval("#move-amount", (el) => el.value));
  await setFieldE(page, "#move-amount", "3");
  expect("…and refuses more than that", /More than the 1\.99 available/.test(await text(page, "#move-quote")) && (await page.$eval("#move-go", (b) => b.disabled)), await text(page, "#move-quote"));
  await setFieldE(page, "#move-amount", "0.01");
  await waitText(page, "#move-quote", /Staking needs at least|Buys about|Stakes/, 30_000);
  expect("…and less than the staking minimum", /^Staking needs at least 0\.02 TAO\.$/.test(await text(page, "#move-quote")) && (await page.$eval("#move-go", (b) => b.disabled)), await text(page, "#move-quote"));
  await clickEl(page, "#move-cancel");
  // Move a position to step 3's choice (not confirmed: nothing is signed or sent). Subnet 1 is in step 3
  // now, so a subnet 1 position either switches validator (no swap) or is already there. The whole
  // position is worth about 1,800 TAO, so soltao's 0.25% fee (about 4.5 TAO, from free TAO) is more than
  // the 2 TAO this wallet has free: refused before signing, with the way out.
  await page.$eval("#holdings-body tr:nth-child(2) button:nth-of-type(2)", (b) => b.click());
  await waitText(page, "#move-quote", /paid from free TAO|same subnet and validator|Could not/, 30_000);
  expect("Move refuses, before signing, a move whose soltao fee is more than the free TAO (or says the stake is already there)", /soltao's fee on this move is [\d.]+ TAO, paid from free TAO, and this wallet has 2 TAO free\. Unstake a little first, or move less\.|Step 3 names this same subnet and validator/.test(await text(page, "#move-quote")), await text(page, "#move-quote"));
  if (!/same subnet and validator/.test(await text(page, "#move-quote"))) {
    await setFieldE(page, "#move-amount", "100");
    await waitText(page, "#move-quote", /Nothing is sold|Could not/, 30_000);
    expect("…and a smaller move within a subnet swaps nothing, and states soltao's fee", /Nothing is sold or bought, so there is no price risk; only a small Bittensor network fee\. soltao's fee: 0\.00\d+ TAO \(0\.25%, at least 0\.001 TAO\), from your free TAO in the same transaction; if the chain refuses the move, no fee is paid\.$/.test(await text(page, "#move-quote")), await text(page, "#move-quote"));
  }
  await clickEl(page, "#move-cancel");
  await setFieldE(page, "#netuid-in", "0");
  await setFieldE(page, "#hotkey-in", VALIDATOR);
  await waitText(page, "#hotkey-note", /Registered validator|Could not reach/, 90_000);
  await page.$eval("#holdings-body tr:nth-child(2) button:nth-of-type(2)", (b) => b.click());
  await waitText(page, "#move-quote", /paid from free TAO|then stakes that TAO on root|Could not/, 60_000);
  // 100,000 Alpha (about 660 TAO): a fee of about 1.7 TAO fits the free TAO, and its price impact is large.
  await setFieldE(page, "#move-amount", "100000");
  await waitText(page, "#move-quote", /^Sells 100,000|Could not/, 60_000);
  expect("Move to root is one transaction: it sells the Alpha (quoted by the chain's simulation) and stakes the TAO, within 2%, and states soltao's fee", /^Sells 100,000 Alpha on subnet 1 for about [\d.,]+ TAO \(a pool fee of [\d.]+ Alpha and [\d.]+% price impact, per the chain's own simulation\), then stakes that TAO on root, all in one Bittensor transaction to validator 5CoZxg…AUbifj\. If the two prices move more than 2% against you before it lands, nothing moves\. soltao's fee: [\d.]+ TAO \(0\.25%, at least 0\.001 TAO\), from your free TAO in the same transaction; if the chain refuses the move, no fee is paid\.( At this size the price impact is large enough that the chain may refuse it at the limit, and only the network fee would be spent\. A smaller amount is more likely to go through\.)?$/.test(await text(page, "#move-quote")) && /^Move from subnet 1 \(5\w+…\w+\) to root \(5CoZxg…AUbifj\)$/.test(await text(page, "#move-title")), `${await text(page, "#move-title")} · ${await text(page, "#move-quote")}`);
  const impact = Number((await text(page, "#move-quote")).match(/([\d.]+)% price impact/)?.[1] ?? 0);
  expect("…and from 1% price impact it warns that the chain may refuse it at the limit", (impact >= 1) === /may refuse it at the limit/.test(await text(page, "#move-quote")) && (impact < 1 || (await attr(page, "#move-quote", "data-tone")) === "warn"), `${impact}%`);
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
  expect("…quotes the transfer and its network fee from the chain", /^Sends 0\.5 TAO to 5Grwva…\w+\. Bittensor network fee about [\d.]+ TAO; soltao's fee 0\.00125 TAO \(0\.25%, at least 0\.001 TAO\), in the same transaction; [\d.]+ TAO stays free here\./.test(await text(page, "#pay-quote")) && /public "via soltao" tag/.test(await text(page, "#pay-quote")), await text(page, "#pay-quote"));
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
  expect("…and that this fresh wallet has no TAO token account yet", /^None yet\. The bridge is built to pay the rent to open one; that path has not been observed on a live return\.$/.test(await text(page, "#r-ata")), await text(page, "#r-ata"));
  expect("…and soltao's fee on the return, 0.25% of it in TAO, to soltao's Bittensor wallet", /^0\.00125 TAO → 5Cvj…QG94 \(0\.25%, at least 0\.001 TAO\)$/.test(await text(page, "#r-rfee")), await text(page, "#r-rfee"));
  expect("the return review states its fees as a share of the amount", /^(about [\d.]+%|under 1%)$/.test(await text(page, "#r-share")), await text(page, "#r-share"));
  const lz = parseFloat(await text(page, "#r-lzfee")), cost = parseFloat(await text(page, "#r-cost"));
  expect("…the LayerZero fee, quoted live in TAO", lz > 0 && lz < 0.05, `${lz} TAO`);
  expect("…and what leaves the Bittensor wallet: the amount plus fees and a gas reserve", cost > 0.5 && cost < 0.6, `${cost} TAO`);
  expect("…to the connected Solana wallet", (await text(page, "#r-dest")).startsWith(pubkey));
  expect("signing is open for the return once quoted", !(await page.$eval("#sign", (b) => b.disabled)), await text(page, "#sign-note"));
  await clean(page, problems, "run F");
  await page.close();
}

// ── Run H: a subnet's profile: what it does, its price chart, the numbers and the risks ──
if (want("H")) {
  const { page, problems } = await openWith({ pubkey: HOLDER, secret: ed25519.utils.randomPrivateKey(), base: `${plain.base}?netuid=64` });
  await page.waitForSelector("#subnet-card-profile .chart svg", { timeout: 90_000 });
  const card = await page.$eval("#subnet-card-profile", (el) => el.textContent);
  expect("a subnet page shows soltao's summary of what it does, with its source", /Serverless AI compute/.test(card) && /In soltao's words, from chutes\.ai, read 28 Sep 2026/.test(card), card.slice(0, 200));
  expect("…a price chart with 7, 30 and 90 day ranges, 30 by default", (await page.$$eval("#subnet-card-profile .range button", (bs) => bs.map((b) => `${b.textContent}:${b.getAttribute("aria-pressed")}`).join())) === "7 days:false,30 days:true,90 days:false");
  expect("…the chart says what it plots, for screen readers", /Alpha price in TAO, last 30 days/.test(await page.$eval("#subnet-card-profile .chart svg", (s) => s.getAttribute("aria-label"))));
  expect("…the changes, what traded, all its Alpha at today's price, registration and deregistration", ["Price change: 7, 30 and 90 days", "TAO traded in its pool, last full day", "All its Alpha at today's price", "Registered", "Deregistration"].every((t) => card.includes(t)), card);
  expect("…and the risks before buying", /Before you buy: Alpha's price moves against TAO/.test(card) && /deregistered/.test(card));
  expect("…and what its validators paid their stakers over 30 days: the middle one and the best", /What its validators paid stakers, \d+ \w{3} to \d+ \w{3}[+−]?\d+\.\d% for the middle one of \d+ with stake, [+−]?\d+\.\d% for the best/.test(card), (card.match(/What its validators paid[^.]*\./) || [""])[0]);
  await page.waitForFunction(() => /Alpha: a fee of [\d.]+ TAO, and price impact of [\d.]+%/.test(document.querySelector("#subnet-card-profile").textContent) || /could not ask the chain/.test(document.querySelector("#subnet-card-profile").textContent), { timeout: 60_000 });
  const buy = await page.$eval("#subnet-card-profile", (el) => (el.textContent.match(/Buying 10 TAO of it now(about [\d.,]+ Alpha: a fee of [\d.]+ TAO, and price impact of [\d.]+%)/) || ["", ""])[1]);
  expect("an example 10 TAO buy is quoted from the chain's own swap simulation, fee and price impact included", Boolean(buy), buy);
  await page.click("#subnet-card-profile .range button[data-days='7']");
  expect("choosing 7 days redraws the chart for 7 days", /last 7 days/.test(await page.$eval("#subnet-card-profile .chart svg", (s) => s.getAttribute("aria-label"))));
  await page.$eval("#subnet-card-profile .chart svg", (s) => s.focus()); // an SVG element: puppeteer's focus() wants HTML
  await page.keyboard.press("ArrowLeft");
  const tip = await page.$eval("#subnet-card-profile .chart-tip", (t) => ({ hidden: t.hidden, text: t.textContent }));
  expect("the arrow keys move a readout along the chart, value first", !tip.hidden && /^[\d.]+ TAO/.test(tip.text), JSON.stringify(tip));
  const rows = await page.$$eval("#subnet-card-profile table tbody tr", (trs) => trs.length);
  expect("the same prices are in a table, for anyone who can't use the chart", rows >= 2, String(rows));
  for (const width of [320, 768]) {
    await page.setViewport({ width, height: 900 });
    await new Promise((r) => setTimeout(r, 300));
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(`the profile fits at ${width}px`, over <= 0, `${over}px`);
  }

  // Choosing a subnet in step 3 puts the same profile beside the choice.
  await page.click("#connect");
  await page.click("#derive");
  await page.waitForFunction(() => document.querySelector("#derive")?.textContent === "Signed", { timeout: 60_000 });
  await clickEl(page, "#phrase-ack");
  await page.$eval("#netuid-in", (el) => { el.value = ""; });
  await page.type("#netuid-in", "51");
  await page.waitForSelector("#plan-profile .chart svg", { timeout: 90_000 });
  expect("choosing a subnet in step 3 opens its profile there", !(await hidden(page, "#plan-profile-box")) && (await text(page, "#plan-profile-h")) === "About subnet 51" && /GPU rental marketplace/.test(await text(page, "#plan-profile")));
  await page.$eval("#netuid-in", (el) => { el.value = ""; });
  await page.type("#netuid-in", "0");
  await page.waitForFunction(() => document.querySelector("#plan-profile-box").hidden, { timeout: 10_000 }).catch(() => {});
  expect("root has no profile: choosing it closes the box", await hidden(page, "#plan-profile-box"));
  await clean(page, problems, "run H");
  await page.close();
}

await browser.close();
plain.server.close(); live.server.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
