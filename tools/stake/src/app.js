// /stake/ page controller. Everything runs in the browser. The only things sent anywhere are RPC
// reads, the user's own Solana transaction once they sign it, and the Bittensor transactions their
// transit key signs to finish the route. The one thing stored is an unfinished route's settings
// (no keys), in this browser, so the route can be finished after the page closes.

import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { CONFIG } from "./config.js";
import { derivationMessage, signInFields, walletFromSignature, ss58Decode, ss58Encode, toHex } from "./derive.js";
import { createClients, getTaoBalance, quoteNativeFee, buildRouteTransaction, removeDust } from "./solana.js";
import { findOnSubnet, getDelegate, getFreeBalance, getUidCount } from "./bittensor.js";
import { getGasPrice } from "./evm.js";
import { finishRoute, transitState, minStakeAmount, stakeGasReserve, sweepFloor } from "./route.js";

const $ = (id) => document.getElementById(id);
const clients = createClients();
const RAO = 1_000_000_000n; // wei per rao, and rao per TAO
const LIVE = Boolean(CONFIG.fee.wallet && CONFIG.fee.lamports);

const state = {
  provider: null, user: null, taoLd: 0n, lamports: 0n,
  signed: null, mode: "derive",
  coldkey: null, coldkeyAddress: null, mustAck: false,
  plan: "stake", netuid: 0n, netuidValid: true, netuidChecking: false, hotkey: null, amountLd: 0n, reserveRao: CONFIG.defaultReserveRao,
  gasPrice: null, nativeFee: null, quoteSeq: 0,
  running: false, unfinished: null, transitRead: false, direction: "forward",
};

// ── formatting ──────────────────────────────────────────────────────────────
function fmtUnits(value, decimals, maxFrac = 6) {
  const neg = value < 0n; let v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base; let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
const tao = (rao) => `${fmtUnits(rao, 9)} TAO`;
const bittensorStakeAsset = (netuid) => (BigInt(netuid) === 0n ? "TAO" : "Alpha");
const stakeAmount = (amount, netuid) => `${fmtUnits(amount, 9)} ${bittensorStakeAsset(netuid)}`;
const sol = (lamports) => `${fmtUnits(BigInt(lamports), 9)} SOL`;
const short = (s, n = 4) => (s.length > n * 2 + 3 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const fromHex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/.{2}/g), (x) => parseInt(x, 16));

/** "1.25" → 1250000000n (9 decimals). Returns null for anything that is not a plain decimal. */
function parseTao(input) {
  const s = String(input).trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return null;
  const [w, f = ""] = s.split(".");
  if (f.length > 9) return null;
  return BigInt(w || "0") * RAO + BigInt((f + "000000000").slice(0, 9));
}

function note(id, text, tone) {
  const el = $(id); el.textContent = text || ""; if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}
function noteHtml(id, nodes, tone) {
  const el = $(id); el.replaceChildren(...nodes); if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}
const link = (href, text) => Object.assign(document.createElement("a"), { href, textContent: text, rel: "noopener", target: "_blank" });
const text = (s) => document.createTextNode(s);

function setStep(id, s) { $(id).dataset.state = s; }
const isRejection = (e) => e?.code === 4001 || /reject|cancel|denied|declined/i.test(e?.message || "");

// ── an unfinished route, remembered in this browser only ────────────────────
// Settings only: plan, validator, destination, amount, the Solana signature. Never a key.
const pendingKey = (transit) => `soltao.stake.pending.${transit}`;
function loadPending(transit) {
  try {
    const v = JSON.parse(localStorage.getItem(pendingKey(transit)) || "null");
    return v && typeof v.coldkey === "string" && /^\d+$/.test(v.amountLd) && /^\d+$/.test(v.reserveRao) ? v : null;
  } catch { return null; }
}
function savePending(transit, route) { try { localStorage.setItem(pendingKey(transit), JSON.stringify(route)); } catch { /* storage off: the route still finishes while the page is open */ } }
function clearPending(transit) { try { localStorage.removeItem(pendingKey(transit)); } catch { /* nothing stored */ } }

// ── step 1: wallet ──────────────────────────────────────────────────────────
function findProvider() {
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  if (window.solflare?.isSolflare) return window.solflare;
  if (window.solana?.connect) return window.solana;
  return null;
}

async function connect() {
  const provider = findProvider();
  if (!provider) {
    noteHtml("connect-note", [text("No Solana wallet found. "), link("https://phantom.com/download", "Install Phantom ↗")], "warn");
    return;
  }
  $("connect").disabled = true; note("connect-note", "connecting…");
  try {
    const res = await provider.connect();
    const pk = res?.publicKey ?? provider.publicKey;
    if (!pk) throw new Error("wallet returned no public key");
    state.provider = provider; state.user = new PublicKey(pk.toString()).toBase58();
    // Every key on this page comes from this wallet's signature; another account means start over.
    provider.on?.("accountChanged", () => { if (!state.running) location.reload(); });
    $("connect").textContent = "Connected"; note("connect-note", "");
    $("wallet-pill").hidden = false; $("wallet-pill").textContent = short(state.user);
    $("balances").hidden = false; $("sol-address").textContent = short(state.user, 6);
    setStep("step-connect", "done");
    gate();
    await refreshBalances();
  } catch (e) {
    $("connect").disabled = false;
    if (isRejection(e)) { note("connect-note", ""); return; }
    console.error("wallet connect failed", e);
    note("connect-note", `Could not connect: ${e.message || e}${e?.code ? ` (code ${e.code})` : ""}. Unlock your wallet and try again; if it repeats, the browser console (F12) shows the detail.`, "bad");
  }
}

async function refreshBalances() {
  const [taoBal, lamports] = await Promise.all([
    getTaoBalance(clients.connection, state.user).catch(() => null),
    clients.connection.getBalance(new PublicKey(state.user)).then(BigInt).catch(() => null),
  ]);
  state.taoLd = taoBal ?? 0n; state.lamports = lamports ?? 0n;
  $("tao-balance").textContent = taoBal === null ? "unavailable" : tao(taoBal);
  $("sol-balance").textContent = lamports === null ? "unavailable" : sol(lamports);
  if (taoBal === null) note("connect-note", "Could not read your TAO balance from Solana. Try again in a moment.", "bad");
  else if (taoBal === 0n && state.direction === "forward") note("connect-note", "This wallet holds no canonical Solana TAO in its main token account.", "warn");
  gate();
}

// ── temporary debug aid: isolate which SIWS field trips Phantom's internal signIn() error ───
// Remove once the -32603 "Unexpected error" investigation (see HANDOVER.md) is resolved.
function wireDebug() {
  if (!new URLSearchParams(location.search).has("debug")) return;
  $("debug-row").hidden = false;
  $("debug-signin").addEventListener("click", async () => {
    if (!state.provider) { note("debug-note", "connect a wallet first", "bad"); return; }
    note("debug-note", "check your wallet…");
    const iso = new Date().toISOString();
    const attempts = [
      ["empty object", {}],
      ["only domain", { domain: location.host }],
      ["phantom doc exact (no address/uri)", { domain: location.host, statement: "test", version: "1", nonce: "oBbLoEldZs", chainId: "mainnet", issuedAt: iso }],
      ["phantom doc + origin uri", { domain: location.host, statement: "test", uri: location.origin, version: "1", nonce: "oBbLoEldZs", chainId: "mainnet", issuedAt: iso }],
      ["phantom doc + address", { domain: location.host, address: state.user, statement: "test", version: "1", nonce: "oBbLoEldZs", chainId: "mainnet", issuedAt: iso }],
      ["full production + nonce + origin", { ...signInFields(state.user), nonce: "1234567890", uri: location.origin }],
    ];
    const results = [];
    for (const [label, input] of attempts) {
      try {
        await state.provider.signIn(input);
        results.push(`${label}: OK`);
      } catch (e) {
        results.push(`${label}: FAIL ${e?.message || e} (code ${e?.code})`);
      }
    }
    note("debug-note", results.join("  |  "));
    console.log("debug sign-in sweep:\n" + results.join("\n"));
  });
}

// ── step 2: the Bittensor wallet and the transit account ────────────────────
async function sign() {
  if (state.signed) return checkTransit(); // already signed: this is the retry after a failed read
  // Prefer the wallet's own Sign In With Solana call: it builds and signs the message itself, so
  // there is no risk of a wallet's own heuristic reprocessing of a plain signMessage() call.
  const canSignIn = typeof state.provider?.signIn === "function";
  if (!canSignIn && !state.provider?.signMessage) { note("derive-note", "This wallet cannot sign messages, and the route needs one signature to create your keys.", "bad"); return; }
  
  const opts = { domain: "soltao.xyz", uri: "https://soltao.xyz/stake/" };
  const expected = new TextEncoder().encode(derivationMessage(state.user, opts));
  $("derive").disabled = true; note("derive-note", "check your wallet…");
  try {
    let signature, signed;
    if (canSignIn) {
      const out = [].concat(await state.provider.signIn(signInFields(state.user, opts)))[0];
      if (!out?.signature || !out?.signedMessage) throw new Error("wallet returned an unexpected sign-in result");
      const acct = out.account?.address || (out.account?.publicKey && new PublicKey(out.account.publicKey).toBase58());
      if (acct && acct !== state.user) throw new Error("signed in as a different wallet than the one connected");
      signature = new Uint8Array(out.signature);
      signed = new Uint8Array(out.signedMessage);
    } else {
      const res = await state.provider.signMessage(expected, "utf8");
      signature = new Uint8Array(res?.signature ?? res);
      signed = expected;
    }
    if (signature.length !== 64) throw new Error("wallet returned an unexpected signature");
    // Same bytes any standards-following wallet would sign for these fields: any wallet holding this
    // key recreates the same keys. If it built something else, only this exact wallet setup can.
    const matches = signed.length === expected.length && signed.every((b, i) => b === expected[i]);
    const raw = matches && ed25519.verify(signature, signed, new PublicKey(state.user).toBytes());
    state.signed = { wallet: walletFromSignature(signature, state.user), raw };
    $("derive").textContent = "Signed";
    note("derive-note", raw ? "Done. Same wallet, same signature, same keys." : "Done, but your wallet signed in a non-standard format. Only this exact wallet setup can recreate these keys: save the phrase.", raw ? "ok" : "warn");
    $("transit-out").textContent = state.signed.wallet.transitAddress;
    applyMode();
    await checkTransit();
  } catch (e) {
    $("derive").disabled = false;
    if (isRejection(e)) { note("derive-note", ""); return; }
    console.error("sign-in failed", e, e && Object.fromEntries(Object.entries(e)));
    const detail = [e?.name, e?.message || String(e), e?.code !== undefined && `code ${e.code}`, e?.data !== undefined && `data ${JSON.stringify(e.data)}`].filter(Boolean).join(" · ");
    note("derive-note", `Could not create them: ${detail}. The browser console (F12) has the full error.`, "bad");
  }
}

function setColdkey(publicKey, { mustAck = false } = {}) {
  state.coldkey = publicKey; state.coldkeyAddress = publicKey ? ss58Encode(publicKey) : null; state.mustAck = mustAck;
  $("ck-result").hidden = !publicKey || !state.signed;
  if (publicKey) {
    $("coldkey-out").textContent = state.coldkeyAddress;
    $("coldkey-explorer").href = `https://taostats.io/account/${state.coldkeyAddress}`;
  }
  $("phrase-box").hidden = !(publicKey && state.mode === "derive" && state.signed);
  gate();
}

function applyMode() {
  state.mode = document.querySelector('input[name="ck-mode"]:checked').value;
  $("ck-paste").hidden = state.mode !== "paste";
  if (state.mode === "derive") {
    const had = state.coldkeyAddress;
    setColdkey(state.signed?.wallet.publicKey ?? null, { mustAck: Boolean(state.signed) });
    if (had !== state.coldkeyAddress) resetPhrase();
  } else onPaste();
}

function onPaste() {
  if (state.mode !== "paste") return;
  const v = $("coldkey-in").value.trim();
  if (!v) { $("coldkey-in").removeAttribute("aria-invalid"); note("coldkey-note", ""); return setColdkey(null); }
  try {
    const pk = ss58Decode(v);
    $("coldkey-in").setAttribute("aria-invalid", "false"); note("coldkey-note", "Valid Bittensor address.", "ok");
    setColdkey(pk);
  } catch (e) {
    $("coldkey-in").setAttribute("aria-invalid", "true"); note("coldkey-note", e.message, "bad"); setColdkey(null);
  }
}

function resetPhrase() {
  $("phrase").hidden = true; $("phrase").replaceChildren();
  $("phrase-toggle").setAttribute("aria-expanded", "false"); $("phrase-toggle").textContent = "show recovery phrase";
  $("phrase-ack").checked = false;
}

function togglePhrase() {
  const open = $("phrase").hidden;
  if (open) $("phrase").replaceChildren(...state.signed.wallet.mnemonic.split(" ").map((w) => Object.assign(document.createElement("li"), { textContent: w })));
  else $("phrase").replaceChildren();
  $("phrase").hidden = !open; $("phrase-toggle").setAttribute("aria-expanded", String(open));
  $("phrase-toggle").textContent = open ? "hide recovery phrase" : "show recovery phrase";
}

// ── an unfinished route on the transit account ──────────────────────────────
async function checkTransit() {
  const w = state.signed?.wallet;
  if (!w) return;
  const pending = loadPending(w.transitAddress);
  state.transitRead = false;
  try {
    const [t, price] = await Promise.all([
      transitState(w.transitKey, pending?.hotkey ? fromHex(pending.hotkey) : null, pending?.netuid ?? "0"),
      getGasPrice(),
    ]);
    state.gasPrice = price;
    const holds = t.wtao > 0n || t.native > sweepFloor(price) || t.stake > 0n;
    state.unfinished = holds || pending ? { ...t, holds, pending } : null;
    state.transitRead = true;
    $("derive").disabled = true; $("derive").textContent = "Signed";
  } catch (e) {
    // Without this read the page cannot tell whether an earlier route is waiting, so it will not send.
    state.unfinished = null;
    note("derive-note", `Could not read your transit account on Bittensor: ${e.message}`, "bad");
    $("derive").disabled = false; $("derive").textContent = "Retry";
  }
  renderUnfinished();
  gate();
}

function renderUnfinished() {
  const u = state.unfinished;
  $("resume").hidden = !u || state.running;
  if (!u) return;
  const p = u.pending;
  const dest = p?.coldkey ?? state.coldkeyAddress;
  const netuid = BigInt(p?.netuid ?? 0);
  const parts = [u.wtao > 0n && `${tao(u.wtao / RAO)} still bridged (wTAO)`, u.native > sweepFloor(state.gasPrice) && `${tao(u.native / RAO)}`, u.stake > 0n && `${stakeAmount(u.stake, netuid)} staked but not yet handed over`].filter(Boolean);
  const plan = p?.plan === "stake" && p.hotkey ? `stake it to ${short(ss58Encode(fromHex(p.hotkey)), 6)} and send the rest` : "send it as free TAO";
  if (u.holds) {
    $("resume-text").textContent = `Your transit account holds ${parts.join(", ")} from a route that did not finish. Finishing will ${plan} to ${dest ? short(dest, 6) : "the Bittensor wallet above"}.`;
    $("resume-go").textContent = "Finish it";
  } else {
    const ago = Math.max(1, Math.round((Date.now() - (p.at || Date.now())) / 60_000));
    $("resume-text").textContent = `A route sent from this browser ${ago} min ago has not reached your transit account yet. Keep this page open and it finishes when the bridge delivers: it will ${plan} to ${short(dest, 6)}.`;
    $("resume-go").textContent = "Wait for it";
  }
  $("resume-forget").hidden = u.holds;
  $("resume-go").disabled = !dest || state.running;
  $("resume-links").replaceChildren(...(p?.sig ? [link(`https://layerzeroscan.com/tx/${p.sig}`, "LayerZero Scan ↗")] : []));
}

async function resume() {
  const u = state.unfinished; if (!u || state.running) return;
  const p = u.pending;
  const route = p ?? { plan: "deliver", hotkey: null, coldkey: state.coldkeyAddress, netuid: "0", reserveRao: "0", amountLd: null };
  if (!route.coldkey) return;
  await runRoute(route, { expectLd: u.holds ? null : BigInt(p.amountLd) });
}

function forget() {
  if (state.signed) clearPending(state.signed.wallet.transitAddress);
  state.unfinished = null; renderUnfinished(); gate();
}

// ── step 3: amount and plan ─────────────────────────────────────────────────
let netuidSeq = 0;
async function onNetuid() {
  const v = $("netuid-in").value.trim(); const seq = ++netuidSeq;
  state.netuid = 0n; state.netuidValid = true; state.netuidChecking = false;
  const recheckHotkey = () => { if ($("hotkey-in").value.trim()) onHotkey(); };
  if (!v) {
    $("netuid-in").removeAttribute("aria-invalid");
    note("netuid-note", "Default is 0 (Root network). Other subnets will mint Alpha tokens.");
    recheckHotkey();
    return gate();
  }
  if (!/^\d+$/.test(v) || BigInt(v) > 65535n) {
    state.netuidValid = false;
    $("netuid-in").setAttribute("aria-invalid", "true");
    note("netuid-note", "Subnet ID must be a whole number.", "bad");
    return gate();
  }
  state.netuid = BigInt(v);
  if (state.netuid === 0n) {
    $("netuid-in").setAttribute("aria-invalid", "false");
    note("netuid-note", "Root network.", "ok");
    recheckHotkey();
    return gate();
  }
  // A subnet that does not exist would only be refused at the stake step, after the bridge.
  state.netuidValid = false; state.netuidChecking = true;
  note("netuid-note", `checking subnet ${state.netuid} on Bittensor…`);
  recheckHotkey();
  gate();
  try {
    const uids = await getUidCount(state.netuid);
    if (seq !== netuidSeq) return;
    state.netuidChecking = false;
    if (uids === 0) {
      $("netuid-in").setAttribute("aria-invalid", "true");
      note("netuid-note", `Subnet ${state.netuid} is not registered on Bittensor.`, "bad");
    } else {
      state.netuidValid = true;
      $("netuid-in").setAttribute("aria-invalid", "false");
      note("netuid-note", `Subnet ${state.netuid} · ${uids} registered hotkeys. Staking here mints its Alpha.`, "ok");
    }
  } catch (e) {
    if (seq === netuidSeq) { state.netuidChecking = false; note("netuid-note", `Could not reach Bittensor to check it: ${e.message}`, "bad"); }
  }
  gate();
}

let hotkeySeq = 0;
async function onHotkey() {
  const v = $("hotkey-in").value.trim(); const seq = ++hotkeySeq;
  state.hotkey = null;
  if (!v) { $("hotkey-in").removeAttribute("aria-invalid"); noteHtml("hotkey-note", [text("Pick one yourself; this page does not choose for you. Validators and their take are listed on "), link("https://taostats.io/validators", "taostats ↗"), text(".")]); return gate(); }
  let pk;
  try { pk = ss58Decode(v); } catch (e) { $("hotkey-in").setAttribute("aria-invalid", "true"); note("hotkey-note", e.message, "bad"); return gate(); }
  if (state.coldkey && toHex(pk) === toHex(state.coldkey)) { $("hotkey-in").setAttribute("aria-invalid", "true"); note("hotkey-note", "That is your coldkey. Paste the validator's hotkey.", "bad"); return gate(); }
  const netuid = state.netuid;
  const bad = (msg) => { $("hotkey-in").setAttribute("aria-invalid", "true"); note("hotkey-note", msg, "bad"); };
  note("hotkey-note", netuid === 0n ? "checking on Bittensor…" : `checking subnet ${netuid}'s validators on Bittensor…`);
  gate();
  try {
    if (netuid === 0n) {
      const d = await getDelegate(pk);
      if (seq !== hotkeySeq) return;
      if (!d.exists) { bad("Not a registered validator (delegate) hotkey. Check it on taostats."); return gate(); }
      state.hotkey = pk; $("hotkey-in").setAttribute("aria-invalid", "false");
      note("hotkey-note", `Registered validator · take ${d.takePct.toFixed(2)}% of rewards`, "ok");
      return gate();
    }
    // getDelegate() takes no netuid: a delegate on one subnet can hold no slot on this one, and a
    // stake there earns nothing. So a subnet stake is checked against the subnet's own metagraph.
    const [d, at] = await Promise.all([getDelegate(pk), findOnSubnet(pk, netuid)]);
    if (seq !== hotkeySeq) return;
    if (at.uidCount === 0) { bad(`Subnet ${netuid} is not registered on Bittensor.`); return gate(); }
    if (at.uid === null) {
      bad(`Not on subnet ${netuid}: this hotkey holds none of its ${at.uidCount} slots, so a stake there would earn nothing.${d.exists ? " It validates elsewhere; paste a hotkey that validates on this subnet." : ""}`);
      return gate();
    }
    if (!at.validatorPermit) {
      bad(`Holds uid ${at.uid} on subnet ${netuid} but no validator permit right now, so it earns no validator dividends there.`);
      return gate();
    }
    state.hotkey = pk; $("hotkey-in").setAttribute("aria-invalid", "false");
    const take = d.exists ? ` · take ${d.takePct.toFixed(2)}% of rewards` : "";
    note("hotkey-note", `Validator on subnet ${netuid} · uid ${at.uid}${take} · ${(at.dividendShare * 100).toFixed(2)}% of the subnet's validator dividends last epoch`, "ok");
  } catch (e) {
    if (seq === hotkeySeq) note("hotkey-note", `Could not reach Bittensor to check it: ${e.message}`, "bad");
  }
  gate();
}

function readAmounts() {
  const amt = parseTao($("amount").value);
  const reserve = parseTao($("reserve").value || "0");
  state.amountLd = amt === null ? 0n : removeDust(amt);
  state.reserveRao = reserve ?? -1n;
  if ($("amount").value && amt === null) return "Enter an amount like 1.25";
  if (!state.amountLd) return "";
  
  if (state.direction !== "forward") return "Bridge back is being rebuilt with full unstake and return checks.";
  if (state.amountLd > state.taoLd) return `More than your ${tao(state.taoLd)}`;
  if (state.plan === "stake") {
    if (state.netuidChecking) return "Checking the subnet on Bittensor…";
    if (!state.netuidValid) return "Enter a valid subnet ID.";
    if (state.reserveRao < 0n) return "Enter the reserve like 0.01";
    if (state.gasPrice === null) return "Reading Bittensor's gas price…";
    const min = minStakeAmount({ reserveRao: state.reserveRao, gasPriceWei: state.gasPrice });
    if (state.amountLd < min) return `Staking needs at least ${tao(min)} at today's gas price (${tao(CONFIG.minStakeRao)} minimum stake, your reserve, and gas held back), or choose "Just deliver it"`;
  }
  
  return "";
}

/** Rough Bittensor cost of the route, in rao: gas actually used at today's price. */
function bittensorGas() {
  if (state.gasPrice === null) return null;
  const g = CONFIG.gasUsed;
  const used = state.plan === "stake" ? g.unwrap + g.addStake + g.transferStake + g.sweep : g.unwrap + g.sweep;
  return (used * state.gasPrice) / RAO;
}

// ── gating and quote ────────────────────────────────────────────────────────
function gate() {
  renderUnfinished();
  const connected = Boolean(state.user);
  const keysReady = Boolean(state.signed) && state.transitRead && Boolean(state.coldkey) && (!state.mustAck || $("phrase-ack").checked);
  setStep("step-coldkey", !connected ? "locked" : keysReady ? "done" : "active");
  // While a route runs, leave steps 3 and 4 showing what was sent.
  if (state.running) { setStep("step-plan", "locked"); $("sign").disabled = true; return; }
  $("stake-opts").hidden = state.plan !== "stake";

  const amountErr = keysReady ? readAmounts() : "";
  const blocked = keysReady && Boolean(state.unfinished);
  setStep("step-plan", keysReady && !blocked ? "active" : "locked");
  note("amount-note", blocked ? "Finish the route in step 2 first." : amountErr, amountErr || blocked ? "bad" : null);
  const acked = $("review-ack-check").checked;
  const forwardReady = state.plan === "deliver" || Boolean(state.hotkey);
  const reviewReady = state.direction === "forward" && keysReady && !blocked && state.amountLd > 0n && !amountErr && forwardReady;
  const planReady = reviewReady && acked;
  if (planReady) setStep("step-plan", "done");
  setStep("step-review", reviewReady ? "active" : "locked");
  renderReview(reviewReady);
  if (reviewReady) requestQuote(); else { state.nativeFee = null; $("sign").disabled = true; }
}

function renderReview(ready) {
  const set = (id, v) => ($(id).textContent = ready ? v() : "—");
  $("r-huge-dest").textContent = ready ? state.coldkeyAddress : "—";
  set("r-send", () => tao(state.amountLd));
  set("r-dest", () => state.coldkeyAddress);
  set("r-via", () => state.signed.wallet.transitAddress);
  set("r-plan", () => {
    if (state.plan !== "stake") return `Deliver ${tao(state.amountLd)}, plus what the gas drop has left, as free TAO`;
    const drop = CONFIG.gasDropWei / RAO, unwrap = (CONFIG.gasUsed.unwrap * state.gasPrice) / RAO;
    const stake = state.amountLd + drop - unwrap - state.reserveRao - stakeGasReserve(state.gasPrice) / RAO;
    const net = state.netuid === 0n ? "root" : `subnet ${state.netuid}`;
    return `Stake about ${stakeAmount(stake, state.netuid)} on ${net} to ${short(ss58Encode(state.hotkey), 6)}. Your ${tao(state.reserveRao)} reserve and the unused gas money arrive as free TAO`;
  });
  set("r-gas", () => { const g = bittensorGas(); return g === null ? "—" : `about ${tao(g)}`; });
  // Name the counterparty, not just the amount: the fee is a plain transfer to this address.
  $("r-fee").textContent = CONFIG.fee.lamports ? `${sol(CONFIG.fee.lamports)}${CONFIG.fee.wallet ? ` → ${short(CONFIG.fee.wallet, 4)}` : ""}` : "none";
  if (!ready) { $("r-lzfee").textContent = "—"; $("r-total").textContent = "—"; }
}

let quoteTimer;
function requestQuote() {
  clearTimeout(quoteTimer);
  $("r-lzfee").replaceChildren(Object.assign(document.createElement("span"), { className: "skel" }));
  $("sign").disabled = true;
  quoteTimer = setTimeout(async () => {
    const seq = ++state.quoteSeq;
    try {
      const fee = await quoteNativeFee(clients, { user: state.user, transit: state.signed.wallet.transitAddress, amountLd: state.amountLd });
      if (seq !== state.quoteSeq) return;
      state.nativeFee = fee;
      const total = fee + BigInt(CONFIG.fee.lamports ?? 0n);
      $("r-lzfee").textContent = sol(fee); $("r-total").textContent = sol(total);
      const lacking = state.lamports < total + 100_000n;
      if (!LIVE) note("sign-note", "The quote is live; sending opens once the route goes live.", "warn");
      else if (lacking) note("sign-note", `Not enough SOL: you need about ${sol(total + 100_000n)} including the transaction fee.`, "bad");
      else note("sign-note", "");
      $("sign").disabled = !LIVE || lacking || state.running || !$("review-ack-check").checked;
    } catch (e) {
      if (seq === state.quoteSeq) { $("r-lzfee").textContent = "unavailable"; note("sign-note", `Could not quote the bridge fee: ${e.message}`, "bad"); }
    }
  }, 350);
}

// ── step 4: sign and send ───────────────────────────────────────────────────
function track(k, s, msg) { const li = document.querySelector(`#track li[data-k="${k}"]`); if (!li) return; li.dataset.s = s; li.querySelector("span").textContent = msg; }
function resetTrack(plan) {
  for (const li of document.querySelectorAll("#track li")) { li.dataset.s = ""; li.querySelector("span").textContent = "—"; }
  document.querySelector('#track li[data-k="stake"]').hidden = plan !== "stake";
  note("track-note", "");
}

async function send() {
  if (!LIVE || state.running || state.unfinished) return;
  const w = state.signed.wallet;
  state.running = true; $("sign").disabled = true; note("sign-note", "building and simulating…");
  resetTrack(state.plan); setStep("step-status", "active");
  track("solana", "busy", "building");
  let started = false;
  try {
    const minAmountLd = removeDust(state.amountLd);

    const nativeFee = await quoteNativeFee(clients, { user: state.user, transit: w.transitAddress, amountLd: minAmountLd });
    const { transaction, blockhash, lastValidBlockHeight } = await buildRouteTransaction(clients, {
      user: state.user, transit: w.transitAddress, amountLd: minAmountLd, nativeFee, fee: CONFIG.fee,
    });
    const sim = await clients.connection.simulateTransaction(transaction, { sigVerify: false });
    if (sim.value.err) {
      const why = (sim.value.logs || []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-2).join(" · ");
      throw new Error(`Simulation failed, nothing was sent. ${why || JSON.stringify(sim.value.err)}`);
    }

    const route = {
      plan: state.plan, hotkey: state.plan === "stake" ? toHex(state.hotkey) : null, coldkey: state.coldkeyAddress,
      netuid: String(state.netuid),
      reserveRao: String(state.plan === "stake" ? state.reserveRao : 0n), amountLd: String(minAmountLd), sig: null, at: Date.now(),
    };
    savePending(w.transitAddress, route);

    note("sign-note", "check your wallet…"); track("solana", "busy", "waiting for your signature");
    let signature;
    try {
      if (state.provider.signAndSendTransaction) ({ signature } = await state.provider.signAndSendTransaction(transaction));
      else signature = await clients.connection.sendRawTransaction((await state.provider.signTransaction(transaction)).serialize(), { skipPreflight: false });
    } catch (e) { clearPending(w.transitAddress); throw e; }
    route.sig = signature; savePending(w.transitAddress, route);
    note("sign-note", "sent");
    $("track-links").replaceChildren(link(`https://solscan.io/tx/${signature}`, "Solscan ↗"), text("  ·  "), link(`https://layerzeroscan.com/tx/${signature}`, "LayerZero Scan ↗"), text("  ·  "), link(`https://taostats.io/account/${state.coldkeyAddress}`, "your Bittensor wallet ↗"));
    track("solana", "busy", "confirming…");

    const confirmed = await confirm(signature, blockhash, lastValidBlockHeight);
    if (!confirmed.ok) { clearPending(w.transitAddress); track("solana", "bad", confirmed.why); throw new Error(confirmed.why); }
    track("solana", "ok", "confirmed"); setStep("step-review", "done");
    started = true;
    await runRoute(route, { expectLd: minAmountLd, fresh: true });
  } catch (e) {
    if (!started) {
      state.running = false;
      if (isRejection(e)) { note("sign-note", ""); track("solana", "", "—"); setStep("step-status", "locked"); gate(); }
      else { 
        note("sign-note", `Send failed: ${e.message || String(e)}`, "bad"); 
        if (!/confirm|expired|failed on Solana/.test(e.message)) track("solana", "bad", "not sent"); 
        // Re-enable the button so the user can retry without refreshing.
        // Don't call gate() — it fires requestQuote() which overwrites sign-note.
        $("sign").disabled = false;
        setStep("step-status", "locked");
      }
    }
  }
}

async function confirm(signature, blockhash, lastValidBlockHeight) {
  for (;;) {
    const [{ value: [st] }, height] = await Promise.all([
      clients.connection.getSignatureStatuses([signature]),
      clients.connection.getBlockHeight("confirmed"),
    ]);
    if (st?.err) return { ok: false, why: `failed on Solana: ${JSON.stringify(st.err)}` };
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { ok: true };
    if (height > lastValidBlockHeight) {
      // The block height passed the deadline, but the tx may have landed in one of the last
      // blocks and the RPC just hasn't indexed it yet. Wait a moment and check one more time
      // before declaring it expired — this closes a race where the status lags behind the height.
      await new Promise((r) => setTimeout(r, 4000));
      const { value: [final] } = await clients.connection.getSignatureStatuses([signature]);
      if (final?.err) return { ok: false, why: `failed on Solana: ${JSON.stringify(final.err)}` };
      if (final && (final.confirmationStatus === "confirmed" || final.confirmationStatus === "finalized")) return { ok: true };
      return { ok: false, why: "expired before it landed: nothing was sent, try again" };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── step 5: the Bittensor half, signed here with the transit key ────────────
async function runRoute(route, { expectLd = null, fresh = false } = {}) {
  const w = state.signed.wallet;
  const coldkey = ss58Decode(route.coldkey), hotkey = route.plan === "stake" && route.hotkey ? fromHex(route.hotkey) : null;
  state.running = true; gate();
  if (!fresh) { resetTrack(route.plan); track("solana", "ok", "sent earlier"); if (route.sig) $("track-links").replaceChildren(link(`https://layerzeroscan.com/tx/${route.sig}`, "LayerZero Scan ↗"), text("  ·  "), link(`https://taostats.io/account/${route.coldkey}`, "your Bittensor wallet ↗")); }
  setStep("step-status", "active");
  note("track-note", "Keep this page open: it signs the Bittensor steps for you with your transit key.", "warn");
  const freeBefore = await getFreeBalance(coldkey).catch(() => null);
  try {
    const netuid = BigInt(route.netuid || "0");
    const summary = await finishRoute({
      transitKey: w.transitKey, coldkey, hotkey, netuid, plan: route.plan, reserveRao: BigInt(route.reserveRao || 0), expectLd,
      onStep: (k, s, msg) => track(k, s, msg),
    });
    clearPending(w.transitAddress);
    const freeAfter = await getFreeBalance(coldkey).catch(() => null);
    const free = freeBefore !== null && freeAfter !== null && freeAfter > freeBefore ? freeAfter - freeBefore : null;
    track("sweep", "ok", [summary.stakedRao > 0n && `staked ${stakeAmount(summary.stakedRao, netuid)}`, free !== null && `${tao(free)} free`].filter(Boolean).join(" · ") || "done");
    note("track-note", summary.stakedRao > 0n ? `Done. The ${bittensorStakeAsset(netuid)} stake is owned by your coldkey; unstake it any time from any Bittensor wallet.`
      : summary.stakeRefused ? "Bittensor refused the stake, so your TAO arrived unstaked. It is free TAO in your wallet: stake it from any Bittensor wallet." : "Done. It is free TAO in your Bittensor wallet.", summary.stakeRefused ? "warn" : "ok");
      
    $("f-dest").textContent = short(route.coldkey, 6);
    $("f-staked-label").textContent = netuid === 0n ? "Staked TAO" : `Staked Alpha, subnet ${netuid}`;
    $("f-staked").textContent = summary.stakedRao > 0n ? stakeAmount(summary.stakedRao, netuid) : `0 ${bittensorStakeAsset(netuid)}`;
    $("f-free").textContent = free !== null ? tao(free) : (summary.stakedRao === 0n && expectLd ? tao(expectLd) : "0 TAO");
    $("final-balance").hidden = false;
    
    setStep("step-status", "done");
    if (state.user) refreshBalances();
  } catch (e) {
    const busy = document.querySelector('#track li[data-s="busy"]');
    if (busy) track(busy.dataset.k, "bad", "stopped");
    note("track-note", `${e.message || e}. Nothing is lost: what has not reached your wallet waits in your transit account, which only your signature controls. Sign the same message on this page to finish.`, "bad");
  } finally {
    state.running = false;
    await checkTransit();
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────
function init() {
  if (!LIVE) $("not-live").hidden = false;
  $("connect").addEventListener("click", connect);
  
  // ── direction toggle ────────────────────────────────────────────────────────
  Array.from(document.querySelectorAll("input[name=direction]")).forEach(opt => {
    opt.addEventListener("change", (e) => {
      if (state.running) { e.preventDefault(); return; }
      state.direction = e.target.value;
      document.querySelectorAll(".dir-fwd").forEach(el => el.hidden = (state.direction !== "forward"));
      document.querySelectorAll(".dir-rev").forEach(el => el.hidden = (state.direction !== "reverse"));
      
      $("amount").value = "";
      gate();
    });
  });
  $("derive").addEventListener("click", sign);
  $("coldkey-in").addEventListener("input", onPaste);
  document.querySelectorAll('input[name="ck-mode"]').forEach((r) => r.addEventListener("change", applyMode));
  $("phrase-toggle").addEventListener("click", togglePhrase);
  $("phrase-ack").addEventListener("change", gate);
  $("review-ack-check").addEventListener("change", gate);
  $("coldkey-copy").addEventListener("click", async () => { await navigator.clipboard.writeText(state.coldkeyAddress); $("coldkey-copy").textContent = "copied"; setTimeout(() => ($("coldkey-copy").textContent = "copy"), 1400); });
  $("r-huge-copy").addEventListener("click", async () => { await navigator.clipboard.writeText(state.coldkeyAddress); $("r-huge-copy").textContent = "copied"; setTimeout(() => ($("r-huge-copy").textContent = "copy"), 1400); });
  $("resume-go").addEventListener("click", resume);
  $("resume-forget").addEventListener("click", forget);
  $("amount").addEventListener("input", gate);
  $("reserve").addEventListener("input", gate);
  $("amount-max").addEventListener("click", () => { $("amount").value = fmtUnits(removeDust(state.taoLd), 9, 9).replace(/,/g, ""); gate(); });
  document.querySelectorAll('input[name="plan"]').forEach((r) => r.addEventListener("change", () => { state.plan = r.value; gate(); }));
  $("netuid-in").addEventListener("input", onNetuid);
  $("hotkey-in").addEventListener("input", onHotkey);
  $("sign").addEventListener("click", send);
  wireDebug();
  getGasPrice().then((p) => { state.gasPrice = p; gate(); }).catch(() => {});
  addEventListener("beforeunload", (e) => { if (state.running) { e.preventDefault(); e.returnValue = ""; } });
  // Keys live only in memory; drop them when the page goes away.
  addEventListener("pagehide", () => { state.signed = null; $("phrase").replaceChildren(); });
  addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); }); // restored from the back/forward cache without its keys
  gate();
}

init();
