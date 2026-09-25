// /stake/ page controller. Everything runs in the browser. The only things sent anywhere are RPC
// reads, the user's own Solana transaction once they sign it, and the Bittensor transactions their
// transit key signs to finish the route. The one thing stored is an unfinished route's settings
// (no keys), in this browser, so the route can be finished after the page closes.

import { PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { CONFIG } from "./config.js";
import { derivationMessage, signInFields, walletFromSignature, ss58Decode, ss58Encode, toHex } from "./derive.js";
import { createClients, getTaoBalance, quoteNativeFee, quotePriorityFee, priorityFeeLamports, buildRouteTransaction, removeDust } from "./solana.js";
import { findOnSubnet, getDelegate, getFreeBalance, getUidCount, subnetValidators } from "./bittensor.js";
import { getGasPrice } from "./evm.js";
import { usdPrices, fmtUsd } from "./prices.js";
import { fitReturnAmount } from "./fit.js";
import { sealRoute, readRoute, untrustedPlan, sealRecord, openRecord } from "./pending.js";
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
  gasPrice: null, nativeFee: null, priorityMicro: null, quoteSeq: 0,
  running: false, unfinished: null, transitRead: false, direction: "forward",
  chutesPrefill: null, // a Chutes payment address from a ?chutes= link
  ret: { free: null, quote: null }, // the return direction: coldkey free TAO (rao), the current quote
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
// Settings only: plan, validator, destination, amount, the Solana signature. Never a key. Sealed with
// a MAC from the transit key (src/pending.js), so an edited destination is ignored, not honoured.
const pendingKey = (transit) => `soltao.stake.pending.${transit}`;
function loadPending(w) {
  try { return JSON.parse(localStorage.getItem(pendingKey(w.transitAddress)) || "null"); } catch { return null; }
}
/** The saved route as the page may act on it now: trusted as saved, or hints bound to the wallet on screen. */
const pendingNow = (raw) => (raw && state.signed ? readRoute(raw, state.signed.wallet.transitKey, state.coldkeyAddress) : null);
function savePending(w, route) { try { localStorage.setItem(pendingKey(w.transitAddress), JSON.stringify(sealRoute(route, w.transitKey))); } catch { /* storage off: the route still finishes while the page is open */ } }
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
    // A phone browser never has a wallet injected, even with the wallet app installed: the page has
    // to be opened inside the wallet's own browser. Its universal link does that, then lands back here.
    if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      noteHtml("connect-note", [text("On a phone, open this page inside your wallet app: "), link(`https://phantom.app/ul/browse/${here}?ref=${ref}`, "Open in Phantom ↗"), text(" · "), link(`https://solflare.com/ul/v1/browse/${here}?ref=${ref}`, "Open in Solflare ↗")], "warn");
      return;
    }
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
  const before = state.coldkeyAddress;
  state.coldkey = publicKey; state.coldkeyAddress = publicKey ? ss58Encode(publicKey) : null; state.mustAck = mustAck;
  if (state.coldkeyAddress !== before) { holdingsSeq++; $("holdings-wrap").hidden = true; $("holdings-btn").disabled = false; move = null; $("move-panel").hidden = true; pay = null; $("pay-panel").hidden = true; }
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
  const raw = loadPending(w), rec = pendingNow(raw);
  const pending = raw && rec ? raw : null; // kept raw: whether it is trusted is decided again at each render
  state.transitRead = false;
  try {
    const [t, price] = await Promise.all([
      transitState(w.transitKey, rec?.route.hotkey ? fromHex(rec.route.hotkey) : null, rec?.route.netuid ?? "0"),
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
  if (state.direction === "reverse") refreshReturn();
}

function renderUnfinished() {
  const u = state.unfinished;
  $("resume").hidden = !u || state.running;
  if (!u) return;
  const r = resumeRoute(u);
  const p = r.route, dest = r.coldkey;
  const netuid = BigInt(p.netuid ?? 0);
  const parts = [u.wtao > 0n && `${tao(u.wtao / RAO)} still bridged (wTAO)`, u.native > sweepFloor(state.gasPrice) && `${tao(u.native / RAO)}`, u.stake > 0n && `${stakeAmount(u.stake, netuid)} staked but not yet handed over`].filter(Boolean);
  const plan = r.plan === "stake" && p.hotkey ? (u.stake > 0n ? `hand the stake on ${short(ss58Encode(fromHex(p.hotkey)), 6)} to your wallet and send the rest` : `stake it to ${short(ss58Encode(fromHex(p.hotkey)), 6)} and send the rest`) : "send it as free TAO";
  // A route saved before records were sealed (or whose seal does not verify) never chooses where the
  // money goes: it finishes to the wallet in step 2, and says so if it had named another one.
  const caveat = r.trusted ? "" : ` This route's saved record could not be verified (it may predate an update), so it finishes to the wallet shown in step 2${r.savedDestination && r.savedDestination !== dest ? `. It named ${short(r.savedDestination, 6)}; to finish there instead, choose "a Bittensor address I already have" in step 2 and paste it` : ""}${u.stake > 0n ? "" : ", unstaked"}.`;
  if (u.holds) {
    $("resume-text").textContent = `Your transit account holds ${parts.join(", ")} from a route that did not finish. Finishing will ${plan} to ${dest ? short(dest, 6) : "the Bittensor wallet above"}.${caveat}`;
    $("resume-go").textContent = "Finish it";
  } else {
    const ago = Math.max(1, Math.round((Date.now() - (p.at || Date.now())) / 60_000));
    $("resume-text").textContent = `A route sent from this browser ${ago} min ago has not reached your transit account yet. Keep this page open and it finishes when the bridge delivers: it will ${plan} to ${dest ? short(dest, 6) : "the Bittensor wallet above"}.${caveat}`;
    $("resume-go").textContent = "Wait for it";
  }
  $("resume-forget").hidden = u.holds;
  $("resume-go").disabled = !dest || state.running;
  $("resume-links").replaceChildren(...(p?.sig ? [link(`https://layerzeroscan.com/tx/${p.sig}`, "LayerZero Scan ↗")] : []));
}

async function resume() {
  const u = state.unfinished; if (!u || state.running) return;
  const r = resumeRoute(u);
  if (!r.coldkey) return;
  await runRoute({ ...r.route, plan: r.plan, coldkey: r.coldkey }, { expectLd: u.holds ? null : BigInt(r.route.amountLd) });
}

/** How an unfinished route would finish right now, from the chain read and whatever was saved. */
function resumeRoute(u) {
  const rec = pendingNow(u.pending);
  if (!rec) return { trusted: true, plan: "deliver", coldkey: state.coldkeyAddress, route: { plan: "deliver", hotkey: null, netuid: "0", reserveRao: "0", amountLd: null } };
  if (rec.trusted) return { trusted: true, plan: rec.route.plan, coldkey: rec.route.coldkey, route: rec.route, savedDestination: rec.savedDestination };
  return { trusted: false, plan: untrustedPlan(u), coldkey: rec.destination, route: rec.route, savedDestination: rec.savedDestination };
}

function forget() {
  if (state.signed) clearPending(state.signed.wallet.transitAddress);
  state.unfinished = null; renderUnfinished(); gate();
}

// ── step 3: amount and plan ─────────────────────────────────────────────────
let netuidSeq = 0;
const NETUID_SETTLE_MS = 400;
async function onNetuid() {
  const v = $("netuid-in").value.trim(); const seq = ++netuidSeq;
  state.netuid = 0n; state.netuidValid = true; state.netuidChecking = false;
  const recheckHotkey = () => { if ($("hotkey-in").value.trim()) onHotkey(); };
  if (/^\d+$/.test(v) && BigInt(v) <= 65535n) state.netuid = BigInt(v);
  resetPicker(); // a list belongs to one subnet; never leave another's on screen
  state.netuid = 0n;
  if (!v) {
    $("netuid-in").removeAttribute("aria-invalid");
    note("netuid-note", "0 is Root, the default.");
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
  // Typing "128" passes through 1 and 12. Drop the hotkey's approval now, since it was for another
  // subnet, but only scan once typing settles: each scan is ~6 requests to a rate-limited public RPC.
  if ($("hotkey-in").value.trim()) { state.hotkey = null; hotkeySeq++; note("hotkey-note", `waiting to check it on subnet ${state.netuid}…`); }
  gate();
  await new Promise((r) => setTimeout(r, NETUID_SETTLE_MS));
  if (seq !== netuidSeq) return;
  try {
    const uids = await getUidCount(state.netuid);
    if (seq !== netuidSeq) return;
    state.netuidChecking = false;
    if (uids === 0) {
      $("netuid-in").setAttribute("aria-invalid", "true");
      note("netuid-note", `Subnet ${state.netuid} is not registered on Bittensor.`, "bad");
      if ($("hotkey-in").value.trim()) note("hotkey-note", "Enter a registered subnet first.", "bad");
    } else {
      state.netuidValid = true;
      $("netuid-in").setAttribute("aria-invalid", "false");
      note("netuid-note", `Subnet ${state.netuid} · ${uids} registered hotkeys. Staking here mints its Alpha.`, "ok");
      recheckHotkey();
    }
  } catch (e) {
    if (seq === netuidSeq) { state.netuidChecking = false; note("netuid-note", `Could not reach Bittensor to check it: ${e.message}`, "bad"); }
  }
  gate();
}

// ── the subnet directory ────────────────────────────────────────────────────
// Every subnet from the chain's SubnetInfo runtime API (one call, through the Bittensor-side bundle,
// on request): name and symbol as the owner registered them, the pool's spot price and its TAO. Two
// orders, both named on the page; nothing is ranked beyond them. Choosing a row only fills the field.
let directory = null; // { at, rows }
const BLOCKS_PER_DAY = 7_200n; // one block every 12 seconds
async function openDirectory() {
  $("dir-wrap").hidden = false; $("dir-btn").disabled = true;
  try {
    if (!directory || Date.now() - directory.at > 5 * 60_000) {
      note("dir-rule", "reading every subnet from Bittensor…");
      const lib = await loadReturnLib();
      directory = { at: Date.now(), rows: await lib.subnetDirectory() };
    }
    renderDirectory();
  } catch (e) {
    note("dir-rule", `Could not read the subnets from Bittensor: ${e.message}`, "bad");
  } finally {
    $("dir-btn").disabled = false;
  }
}
function renderDirectory() {
  if (!directory) return;
  const q = $("dir-search").value.trim().toLowerCase(), order = $("dir-sort").value;
  let rows = directory.rows.filter((r) => !q || String(r.netuid) === q || r.name.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q));
  const most = (key) => (a, b) => ((b[key] ?? -1n) > (a[key] ?? -1n) ? 1 : (b[key] ?? -1n) < (a[key] ?? -1n) ? -1 : a.netuid - b.netuid);
  if (order === "pool") rows = rows.filter((r) => r.netuid !== 0).sort(most("taoInRao"));
  if (order === "emission") rows = rows.filter((r) => r.netuid !== 0).sort(most("taoPerBlockRao"));
  const at = new Date(directory.at).toISOString().slice(11, 16);
  const rule = {
    netuid: "in subnet-number order",
    pool: "sorted by TAO in each subnet's pool, most first (root has no pool and is left out)",
    emission: "sorted by TAO the chain adds to each subnet's pool per day, most first (root is left out)",
  }[order];
  note("dir-rule", `${rows.length} of ${directory.rows.length} subnets, ${rule}. "TAO added per day" is the TAO the chain put into that pool in the last block, times 7,200 blocks (12 seconds each); it moves from block to block. Names are what each owner registered on-chain; a name is not an endorsement. Read ${at} UTC.`);
  const current = state.netuidValid ? Number(state.netuid) : null;
  $("dir-body").replaceChildren(...rows.map((r) => {
    const tr = document.createElement("tr");
    if (r.netuid === current) tr.setAttribute("aria-current", "true");
    if (r.description) tr.title = r.description;
    const td = (t, cls) => Object.assign(document.createElement("td"), { textContent: t, className: cls || "" });
    const use = Object.assign(document.createElement("button"), { type: "button", textContent: "Use" });
    use.setAttribute("aria-label", `Use subnet ${r.netuid}, ${r.name}`);
    use.addEventListener("click", () => { $("netuid-in").value = String(r.netuid); onNetuid(); renderDirectory(); });
    const cell = document.createElement("td"); cell.append(use);
    tr.append(
      td(String(r.netuid), "num"), td(`${r.name}${r.symbol ? ` ${r.symbol}` : ""}`),
      td(r.netuid === 0 ? "1 (root)" : r.priceRao === null ? "—" : fmtUnits(r.priceRao, 9), "num"),
      td(r.netuid === 0 ? "no pool" : fmtUnits(r.taoInRao, 9, 0), "num"),
      td(r.netuid === 0 || r.taoPerBlockRao === null ? "—" : fmtUnits(r.taoPerBlockRao * BLOCKS_PER_DAY, 9, 2), "num"), cell,
    );
    return tr;
  }));
}

// ── the validator picker ────────────────────────────────────────────────────
// Lists the chosen subnet's validator-permit holders from the metagraph, on request (about 13 reads
// against a rate-limited RPC, so never on every keystroke). It states its one sort rule and picks
// nothing: choosing a row only fills the hotkey field, which is then checked like a pasted one.
let pickSeq = 0;
function resetPicker() {
  pickSeq++;
  $("pick-wrap").hidden = true; $("pick-body").replaceChildren();
  $("pick-btn").disabled = false;
  $("pick-btn").textContent = state.netuid === 0n ? "List root validators" : `List subnet ${state.netuid}'s validators`;
}
async function openPicker() {
  if (state.netuidChecking || !state.netuidValid) return;
  const netuid = state.netuid, seq = ++pickSeq;
  $("pick-btn").disabled = true; $("pick-wrap").hidden = false; $("pick-body").replaceChildren();
  note("pick-rule", `reading ${netuid === 0n ? "root" : `subnet ${netuid}`}'s validators from Bittensor…`);
  try {
    const list = await subnetValidators(netuid);
    if (seq !== pickSeq) return;
    const at = new Date().toISOString().slice(11, 16);
    const where = netuid === 0n ? "root" : `subnet ${netuid}`;
    if (!list.length) { note("pick-rule", `No hotkey holds a validator permit on ${where} right now.`, "warn"); return; }
    note("pick-rule", `${list.length} validators on ${where}, sorted by share of its validator dividends at the last epoch, highest first (read ${at} UTC). That share moves every epoch: it is a snapshot, not a forecast, and not a recommendation. Names are not on-chain, so check a hotkey on taostats before you choose.`);
    const current = $("hotkey-in").value.trim();
    $("pick-body").replaceChildren(...list.map((v) => {
      const ss58 = ss58Encode(fromHex(v.hotkey));
      const tr = document.createElement("tr");
      if (ss58 === current) tr.setAttribute("aria-current", "true");
      const td = (t, cls) => Object.assign(document.createElement("td"), { textContent: t, className: cls || "" });
      const use = Object.assign(document.createElement("button"), { type: "button", textContent: "Use" });
      use.setAttribute("aria-label", `Use validator uid ${v.uid}, ${ss58}`);
      use.addEventListener("click", () => {
        $("hotkey-in").value = ss58;
        for (const row of $("pick-body").children) row.removeAttribute("aria-current");
        tr.setAttribute("aria-current", "true");
        onHotkey();
      });
      const cell = document.createElement("td"); cell.append(use);
      tr.append(td(String(v.uid), "num"), td(short(ss58, 6)), td(v.takePct === null ? "not a delegate" : `${v.takePct.toFixed(2)}%`, "num"), td(`${(v.dividendShare * 100).toFixed(2)}%`, "num"), cell);
      return tr;
    }));
  } catch (e) {
    if (seq === pickSeq) note("pick-rule", `Could not read the validators from Bittensor: ${e.message}. Try again in a minute.`, "bad");
  } finally {
    if (seq === pickSeq) $("pick-btn").disabled = false;
  }
}

let hotkeySeq = 0;
/** A link that reopens this page with the same subnet and validator filled in (see prefillFromLink). */
const shareLink = (netuid, hotkey) => Object.assign(document.createElement("a"), { href: `/stake/?netuid=${netuid}&hotkey=${encodeURIComponent(hotkey)}`, textContent: "link to this choice" });
async function onHotkey() {
  const v = $("hotkey-in").value.trim(); const seq = ++hotkeySeq;
  state.hotkey = null;
  if (!v) { $("hotkey-in").removeAttribute("aria-invalid"); note("hotkey-note", "Pick one from the list, or paste its address."); return gate(); }
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
      noteHtml("hotkey-note", [text(`Registered validator · take ${d.takePct.toFixed(2)}% of rewards · `), shareLink(0n, v)], "ok");
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
    noteHtml("hotkey-note", [text(`Validator on subnet ${netuid} · uid ${at.uid}${take} · ${(at.dividendShare * 100).toFixed(2)}% of the subnet's validator dividends last epoch · `), shareLink(netuid, v)], "ok");
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
  
  if (state.direction === "reverse") {
    if (state.mode !== "derive") return "Bridging back needs the Bittensor wallet your signature creates.";
    if (state.ret.free === null) return "Reading your free TAO on Bittensor…";
    if (state.amountLd > state.ret.free) return `More than the ${tao(state.ret.free)} free in your Bittensor wallet`;
    return "";
  }
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
  const reverse = state.direction === "reverse";
  // A return may start over leftover gas money on the transit account (it is reused), but never over
  // wTAO or stake an unfinished forward route still means to deliver.
  const u = state.unfinished;
  const blocked = keysReady && Boolean(u) && (!reverse || u.wtao > 0n || u.stake > 0n || (u.pending && !u.holds));
  setStep("step-plan", keysReady && !blocked ? "active" : "locked");
  note("amount-note", blocked ? "Finish the route in step 2 first." : amountErr, amountErr || blocked ? "bad" : null);
  const acked = $("review-ack-check").checked;
  const forwardReady = state.plan === "deliver" || Boolean(state.hotkey);
  const ready = keysReady && !blocked && state.amountLd > 0n && !amountErr;
  const reviewReady = ready && (reverse ? RETURN_OPEN : forwardReady);
  const planReady = reviewReady && (reverse || acked);
  if (planReady) setStep("step-plan", "done");
  setStep("step-review", reviewReady ? "active" : "locked");
  renderReview(reviewReady);
  if (reviewReady) (reverse ? requestReturnQuote : requestQuote)(); else { state.nativeFee = null; state.ret.quote = null; $("sign").disabled = true; }
}

function renderReview(ready) {
  const set = (id, v) => ($(id).textContent = ready ? v() : "—");
  if (state.direction === "reverse") {
    set("r-send", () => tao(state.amountLd));
    set("r-dest", () => `${state.user} (your Solana wallet)`);
    if (!ready) for (const id of ["r-gas", "r-lzfee", "r-cost", "r-receive"]) $(id).textContent = "—";
    return;
  }
  $("r-huge-dest").textContent = ready ? state.coldkeyAddress : "—";
  set("r-send", () => tao(state.amountLd));
  set("r-dest", () => state.coldkeyAddress);
  set("r-via", () => state.signed.wallet.transitAddress);
  set("r-plan", () => {
    if (state.plan !== "stake") return `Deliver ${tao(state.amountLd)}, plus what the gas drop has left, as free TAO`;
    const drop = CONFIG.gasDropWei / RAO, unwrap = (CONFIG.gasUsed.unwrap * state.gasPrice) / RAO;
    const stake = state.amountLd + drop - unwrap - state.reserveRao - stakeGasReserve(state.gasPrice) / RAO;
    const to = short(ss58Encode(state.hotkey), 6), rest = `Your ${tao(state.reserveRao)} reserve and the unused gas money arrive as free TAO`;
    if (state.netuid === 0n) return `Stake about ${tao(stake)} on root to ${to}. ${rest}`;
    // What goes in is TAO; the Alpha it buys depends on the subnet's pool price when it lands.
    const pct = Number(CONFIG.subnetPriceToleranceBps) / 100;
    return `Stake about ${tao(stake)} on subnet ${state.netuid} to ${to}, bought as its Alpha at the pool price. If that price is more than ${pct}% worse when it lands, nothing is staked and the TAO arrives free. ${rest}`;
  });
  set("r-gas", () => { const g = bittensorGas(); return g === null ? "—" : `about ${tao(g)}`; });
  // Name the counterparty, not just the amount: the fee is a plain transfer to this address.
  $("r-fee").textContent = CONFIG.fee.lamports ? `${sol(CONFIG.fee.lamports)}${CONFIG.fee.wallet ? ` → ${short(CONFIG.fee.wallet, 4)}` : ""}` : "none";
  if (!ready) { $("r-lzfee").textContent = "—"; $("r-prio").textContent = "—"; $("r-total").textContent = "—"; $("r-usd").textContent = "—"; }
}

let quoteTimer;
// ── the return direction: free TAO in the derived coldkey -> canonical TAO on Solana ─────────────
// The engine is src/return_route.js, shipped in its own bundle (stake/return.js) and fetched only
// here. Its checkpoints are saved sealed (src/pending.js) before every broadcast, so closing the page
// never repeats a transfer, wrap or send. Arrival is read from the Solana wallet's own TAO balance.
let returnLib = null;
function loadReturnLib() {
  if (!returnLib) returnLib = new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src: __RETURN_BUNDLE__ });
    s.onload = () => (globalThis.__soltaoReturn ? resolve(globalThis.__soltaoReturn) : reject(new Error("the return code did not start")));
    s.onerror = () => { returnLib = null; reject(new Error("could not load the return code")); };
    document.head.append(s);
  });
  return returnLib;
}
const returnKey = (transit) => `soltao.return.pending.${transit}`;
function loadReturn(w) { try { return openRecord(JSON.parse(localStorage.getItem(returnKey(w.transitAddress)) || "null"), w.transitKey, "return"); } catch { return null; } }
function saveReturn(w, value) { try { localStorage.setItem(returnKey(w.transitAddress), JSON.stringify(sealRecord(value, w.transitKey, "return"))); } catch { /* storage off: it still finishes while the page is open */ } }
function clearReturn(w) { try { localStorage.removeItem(returnKey(w.transitAddress)); } catch { /* nothing stored */ } }
const solanaRecipient = () => toHex(new PublicKey(state.user).toBytes());
// The OFT carries 6 decimals across, so what lands on Solana is the amount floored to 0.000001 TAO.
const arrivingLd = (amountRao) => BigInt(amountRao) - (BigInt(amountRao) % CONFIG.dustLd);

/** Loads the return code if needed and reads the derived coldkey's free TAO. */
async function refreshReturn() {
  if (state.direction !== "reverse" || !state.signed) return;
  $("tao-free").replaceChildren(Object.assign(document.createElement("span"), { className: "skel" }));
  $("tao-staked").textContent = "see step 2 to unstake";
  try {
    const lib = await loadReturnLib();
    state.ret.free = await lib.freeBalance(state.signed.wallet.address);
    $("tao-free").textContent = tao(state.ret.free);
    const saved = loadReturn(state.signed.wallet);
    if (saved && !state.running) {
      $("amount").value = fmtUnits(BigInt(saved.amountRao), 9, 9).replace(/,/g, "");
      note("sign-note", "A return from this browser has not finished. Signing continues it from where it stopped, without repeating any step.", "warn");
      $("sign").textContent = "Finish the return";
    }
  } catch (e) {
    $("tao-free").textContent = "unavailable";
    note("amount-note", `Could not read your Bittensor wallet: ${e.message}`, "bad");
  }
  gate();
}

// ── holdings: everything the Bittensor wallet on screen holds ─────────────────
// Free TAO plus every stake position, from the chain's own StakeInfo runtime API. Read on request,
// through the Bittensor-side bundle, so the forward page stays light. Works for a pasted coldkey too.
let holdingsSeq = 0;
async function showHoldings() {
  const coldkey = state.coldkeyAddress;
  if (!coldkey) return;
  const seq = ++holdingsSeq;
  $("holdings-btn").disabled = true; $("holdings-wrap").hidden = false; $("holdings-body").replaceChildren();
  note("holdings-note", `reading ${short(coldkey, 6)} from Bittensor…`);
  try {
    const lib = await loadReturnLib();
    const [free, positions] = await Promise.all([lib.freeBalance(coldkey), lib.stakePositions(coldkey)]);
    if (seq !== holdingsSeq || coldkey !== state.coldkeyAddress) return;
    const row = (where, hotkey, amount) => {
      const tr = document.createElement("tr");
      for (const [t, cls] of [[where], [hotkey], [amount, "num"]]) tr.append(Object.assign(document.createElement("td"), { textContent: t, className: cls || "" }));
      return tr;
    };
    const action = (label, fn) => {
      const td = document.createElement("td");
      if (canMove()) { const b = Object.assign(document.createElement("button"), { type: "button", textContent: label }); b.addEventListener("click", fn); td.append(b); }
      return td;
    };
    const freeRow = row("Free", "—", tao(free));
    const freeActions = action("Stake", () => openMove({ kind: "stake", free }));
    if (canPay()) {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: "Top up Chutes" });
      b.addEventListener("click", () => openPay(free));
      freeActions.append(" ", b);
    }
    freeRow.append(freeActions);
    $("holdings-body").replaceChildren(
      freeRow,
      ...positions.map((p) => {
        const tr = row(p.netuid === 0 ? "Staked on root" : `Staked on subnet ${p.netuid}`, short(p.hotkey, 6), stakeAmount(p.stake, p.netuid));
        tr.append(action("Unstake", () => openMove({ kind: "unstake", hotkey: p.hotkey, netuid: p.netuid, max: p.stake })));
        return tr;
      }),
    );
    resumeMove();
    resumePay();
    note("holdings-note", `Read ${new Date().toISOString().slice(11, 16)} UTC. ${positions.length ? `${positions.length} stake position${positions.length === 1 ? "" : "s"}. Subnet stakes are in that subnet's Alpha, root stakes in TAO.` : "No stake positions."}`);
  } catch (e) {
    if (seq === holdingsSeq) note("holdings-note", `Could not read it from Bittensor: ${e.message}`, "bad");
  } finally {
    if (seq === holdingsSeq) $("holdings-btn").disabled = false;
  }
}

// ── stake moves from the derived coldkey: unstake a position, or stake free TAO ───────────────────
// Unstaked TAO is free, so "Bridge to Solana" can then bring it home; staking free TAO is how a subnet
// stake the chain refused on price is retried at today's price. Gated like the return (RETURN_OPEN)
// until a real-funds run, and only for the wallet the signature creates: a pasted coldkey cannot sign.
const canMove = () => RETURN_OPEN && Boolean(state.signed) && state.mode === "derive" && state.coldkeyAddress === state.signed.wallet.address && !state.running;
const moveKey = (transit) => `soltao.move.pending.${transit}`;
function loadMove(w) { try { return openRecord(JSON.parse(localStorage.getItem(moveKey(w.transitAddress)) || "null"), w.transitKey, "stake-move"); } catch { return null; } }
function saveMove(w, value) { try { localStorage.setItem(moveKey(w.transitAddress), JSON.stringify(sealRecord(value, w.transitKey, "stake-move"))); } catch { /* storage off */ } }
function clearMove(w) { try { localStorage.removeItem(moveKey(w.transitAddress)); } catch { /* nothing stored */ } }

let move = null, moveQuoteSeq = 0;
function openMove(m) {
  if (m.kind === "stake") {
    // Staking reuses step 3's subnet and validator, which have already passed the on-chain checks.
    if (!state.hotkey || !state.netuidValid || state.netuidChecking) {
      $("move-panel").hidden = false; move = null;
      $("move-title").textContent = "Stake free TAO";
      note("move-quote", "Choose the subnet and a checked validator in step 3 first; this stakes to that choice.", "warn");
      $("move-go").disabled = true; return;
    }
    const reserve = CONFIG.defaultReserveRao; // left free to pay for later moves
    m = { ...m, hotkey: ss58Encode(state.hotkey), netuid: Number(state.netuid), max: m.free > reserve ? m.free - reserve : 0n };
  }
  move = m;
  $("pay-panel").hidden = true; pay = null;
  const where = m.netuid === 0 ? "root" : `subnet ${m.netuid}`;
  $("move-title").textContent = m.kind === "stake" ? `Stake free TAO on ${where} to ${short(m.hotkey, 6)}` : `Unstake from ${where} (${short(m.hotkey, 6)})`;
  $("move-amount-label").textContent = m.kind === "stake" ? "TAO to stake" : `${m.netuid === 0 ? "TAO" : "Alpha"} to unstake`;
  $("move-amount").value = fmtUnits(m.max, 9, 9).replace(/,/g, "");
  $("move-go").textContent = "Confirm"; $("move-go").disabled = false; note("move-note", "");
  // Unstake-then-return: offered only when no earlier return is unfinished, which would come first.
  $("move-then").checked = false;
  $("move-then-wrap").hidden = m.kind !== "unstake" || Boolean(loadReturn(state.signed.wallet));
  $("move-panel").hidden = false;
  quoteMove();
}
async function quoteMove() {
  if (!move) return;
  const amt = parseTao($("move-amount").value), seq = ++moveQuoteSeq;
  if (amt === null || amt <= 0n) { note("move-quote", "Enter an amount like 0.5", "bad"); $("move-go").disabled = true; return; }
  if (amt > move.max) { note("move-quote", `More than the ${fmtUnits(move.max, 9)} available${move.kind === "stake" ? ` (${tao(CONFIG.defaultReserveRao)} stays free for fees)` : ""}`, "bad"); $("move-go").disabled = true; return; }
  $("move-go").disabled = false;
  if (move.netuid === 0 && !(move.kind === "unstake" && $("move-then").checked)) { note("move-quote", move.kind === "stake" ? `Stakes ${tao(amt)} on root.` : `Unstakes ${tao(amt)} from root into free TAO.`); return; }
  const then = move.kind === "unstake" && $("move-then").checked;
  try {
    const lib = await loadReturnLib(), price = await lib.alphaPriceRao(move.netuid);
    const proceeds = (amt * price) / RAO;
    // The bridge fee for a return of about that much, so the chained choice is priced before it is made.
    const lz = then ? (await lib.quoteReturn({ amountRao: removeDust(proceeds), solanaRecipient: solanaRecipient() })).nativeFee / RAO : null;
    if (seq !== moveQuoteSeq) return;
    const pct = Number(CONFIG.subnetPriceToleranceBps) / 100;
    const sale = move.netuid === 0 ? `Unstakes ${tao(amt)} from root into free TAO.` : move.kind === "stake"
      ? `Buys about ${fmtUnits((amt * RAO) / price, 9)} Alpha at today's pool price (${fmtUnits(price, 9)} TAO each). If the price is more than ${pct}% higher when it lands, nothing is staked.`
      : `Sells for about ${tao(proceeds)} at today's pool price (${fmtUnits(price, 9)} TAO per Alpha). If the price is more than ${pct}% lower when it lands, nothing is unstaked.`;
    note("move-quote", then
      ? `${sale} Then that TAO goes to your Solana wallet as canonical TAO, less the LayerZero fee (about ${tao(lz)} today) and a little Bittensor gas; ${tao(RETURN_KEEP_RAO)} stays free for later fees. Both figures are read again before it is sent.`
      : sale);
  } catch (e) { if (seq === moveQuoteSeq) note("move-quote", `Could not read ${move.netuid === 0 ? "the bridge fee" : "the subnet's price"}: ${e.message}`, "bad"); }
}
function resumeMove() {
  const saved = state.signed && loadMove(state.signed.wallet);
  if (!saved || !canMove()) return;
  move = { kind: saved.kind, hotkey: saved.hotkey, netuid: Number(saved.netuid), max: BigInt(saved.amount), resume: saved };
  $("move-then").checked = Boolean(saved.thenReturn); $("move-then-wrap").hidden = !saved.thenReturn;
  $("move-title").textContent = `An earlier ${saved.kind} did not finish`;
  $("move-amount").value = fmtUnits(BigInt(saved.amount), 9, 9).replace(/,/g, "");
  note("move-quote", "Finishing checks the transaction that was already signed and sent; it never signs a second one while that one could still land.", "warn");
  $("move-go").textContent = "Finish it"; $("move-go").disabled = false; $("move-panel").hidden = false;
}
async function runMove() {
  if (!move || state.running || !canMove()) return;
  const w = state.signed.wallet, m = move;
  const saved = m.resume ?? null;
  const amount = saved ? BigInt(saved.amount) : parseTao($("move-amount").value);
  if (amount === null || amount <= 0n) return;
  state.running = true; $("move-go").disabled = true; $("move-cancel").disabled = true; gate();
  const thenReturn = m.kind === "unstake" && $("move-then").checked && !loadReturn(w);
  const meta = { kind: m.kind, hotkey: m.hotkey, netuid: String(m.netuid), amount: String(amount), thenReturn };
  let chain = null;
  try {
    const lib = await loadReturnLib();
    const res = await lib.runStakeMove({
      mnemonic: w.mnemonic, kind: m.kind, hotkey: m.hotkey, netuid: m.netuid, amount,
      progress: saved?.progress ?? {},
      onStep: (_k, s, msg) => note("move-note", msg, s === "bad" ? "warn" : s === "ok" ? "ok" : null),
      onCheckpoint: (progress) => saveMove(w, { ...meta, progress }),
    });
    clearMove(w);
    if (res.done) note("move-note", m.kind === "unstake"
      ? `Done: ${stakeAmount(res.moved, m.netuid)} unstaked into free TAO.${thenReturn ? " Now bringing it to Solana: step 5, \"Where it is\", follows it." : ` "Bridge to Solana" can bring it home.`}`
      : `Done: now ${stakeAmount(res.stakeAfter, m.netuid)} staked on ${m.netuid === 0 ? "root" : `subnet ${m.netuid}`}.`, "ok");
    else if (thenReturn) note("move-note", "The unstake did not happen, so nothing is being returned.", "warn");
    if (res.done && thenReturn && res.freed > 0n) chain = res.freed;
    move = null;
  } catch (e) {
    note("move-note", `${e.message || e}. Anything already sent is saved, so opening the holdings again continues it.`, "bad");
  } finally {
    state.running = false; $("move-cancel").disabled = false; gate();
    if (move === null && chain === null) showHoldings().then(() => { $("move-panel").hidden = false; });
    if (state.direction === "reverse" && chain === null) refreshReturn();
  }
  if (chain !== null) await returnAfterUnstake(chain);
}

// ── top up Chutes: free TAO from the derived coldkey to a pasted Chutes payment address ───────────
// The only place the page pays an address that is not the user's own, so it is its own action with its
// own acknowledgement, never part of a route. Signed, sealed and settled like a stake move
// (src/payments.js), so a closed tab resumes the same transfer instead of paying twice.
const canPay = () => CHUTES_OPEN && canMove();
const payKey = (transit) => `soltao.pay.pending.${transit}`;
function loadPay(w) { try { return openRecord(JSON.parse(localStorage.getItem(payKey(w.transitAddress)) || "null"), w.transitKey, "chutes-pay"); } catch { return null; } }
function savePay(w, value) { try { localStorage.setItem(payKey(w.transitAddress), JSON.stringify(sealRecord(value, w.transitKey, "chutes-pay"))); } catch { /* storage off */ } }
function clearPay(w) { try { localStorage.removeItem(payKey(w.transitAddress)); } catch { /* nothing stored */ } }

let pay = null, payQuoteSeq = 0, payTimer = null;
function payeeProblem(to) {
  if (!to) return "Paste your Chutes payment address.";
  try { ss58Decode(to); } catch (e) { return `${e.message}.`; }
  if (to === state.signed.wallet.address) return "That is this wallet's own address, not your Chutes one.";
  return null;
}
function openPay(free) {
  const reserve = CONFIG.defaultReserveRao; // left free to pay for later moves
  pay = { max: free > reserve ? free - reserve : 0n };
  $("pay-to").value = $("pay-to").value || state.chutesPrefill || "";
  $("pay-amount").value = "";
  $("pay-ack").checked = false;
  $("pay-go").textContent = "Send to Chutes"; note("pay-note", "");
  $("move-panel").hidden = true; move = null;
  $("pay-panel").hidden = false;
  quotePay();
}
function quotePay() {
  if (!pay || pay.resume) return;
  clearTimeout(payTimer);
  pay.quoted = false; gatePay();
  payTimer = setTimeout(quotePayNow, 400); // the quote reads the chain; let typing settle first
}
function gatePay() {
  if (!pay) return;
  $("pay-go").disabled = state.running || !(pay.resume || (pay.quoted && $("pay-ack").checked));
}
async function quotePayNow() {
  if (!pay || pay.resume) return;
  const seq = ++payQuoteSeq, lib = await loadReturnLib();
  if (!pay || seq !== payQuoteSeq) return;
  const to = $("pay-to").value.trim(), amt = parseTao($("pay-amount").value);
  const problem = payeeProblem(to);
  $("pay-to").setAttribute("aria-invalid", String(Boolean(problem && to)));
  if (problem) { note("pay-quote", problem, to ? "bad" : null); return; }
  if (amt === null || amt <= 0n) { note("pay-quote", "Enter an amount like 0.5"); return; }
  if (amt < lib.CHUTES_MIN_RAO) { note("pay-quote", `Send at least ${tao(lib.CHUTES_MIN_RAO)}: Chutes ignores smaller payments.`, "bad"); return; }
  if (amt > pay.max) { note("pay-quote", `More than the ${tao(pay.max)} available (${tao(CONFIG.defaultReserveRao)} stays free for fees).`, "bad"); return; }
  try {
    const q = await lib.quotePayment(state.signed.wallet.mnemonic, to, amt);
    if (seq !== payQuoteSeq) return;
    if (q.remainingRao < 0n) { note("pay-quote", `That plus the ${tao(q.feeRao)} network fee is more than this wallet holds.`, "bad"); return; }
    pay.quoted = true; gatePay();
    note("pay-quote", `Sends ${tao(amt)} to ${short(to, 6)}. Bittensor network fee about ${tao(q.feeRao)}; ${tao(q.remainingRao)} stays free here. Chutes adds it to your balance in dollars at the TAO price when it lands, usually within a minute. It carries a public "via soltao" tag, so top-ups through this page can be counted.`);
  } catch (e) { if (seq === payQuoteSeq) note("pay-quote", `Could not read the fee from Bittensor: ${e.message}`, "bad"); }
}
function resumePay() {
  const saved = state.signed && loadPay(state.signed.wallet);
  if (!saved || !canPay()) return;
  pay = { resume: saved, max: BigInt(saved.amount) };
  $("pay-to").value = saved.to; $("pay-amount").value = fmtUnits(BigInt(saved.amount), 9, 9).replace(/,/g, "");
  note("pay-quote", "An earlier top-up did not finish. Finishing checks the transfer that was already signed and sent; it never signs a second one while that one could still land.", "warn");
  $("pay-go").textContent = "Finish it"; $("pay-go").disabled = false; $("pay-panel").hidden = false;
}
async function runPay() {
  if (!pay || state.running || !canPay()) return;
  const w = state.signed.wallet, saved = pay.resume ?? null;
  const to = saved ? saved.to : $("pay-to").value.trim();
  const amount = saved ? BigInt(saved.amount) : parseTao($("pay-amount").value);
  if (!saved && (payeeProblem(to) || amount === null || !$("pay-ack").checked)) return;
  state.running = true; $("pay-go").disabled = true; $("pay-cancel").disabled = true; gate();
  const meta = { to, amount: String(amount) };
  try {
    const lib = await loadReturnLib();
    const res = await lib.runPayment({
      mnemonic: w.mnemonic, to, amount, progress: saved?.progress ?? {},
      onStep: (_k, s, msg) => note("pay-note", msg, s === "bad" ? "warn" : s === "ok" ? "ok" : null),
      onCheckpoint: (progress) => savePay(w, { ...meta, progress }),
    });
    clearPay(w);
    if (res.done) note("pay-note", `Sent ${tao(res.sent)} to your Chutes payment address. Chutes credits it in dollars once it sees the transfer; check your balance there.`, "ok");
    pay = null;
  } catch (e) {
    note("pay-note", `${e.message || e}. Anything already sent is saved, so opening the holdings again continues it.`, "bad");
  } finally {
    state.running = false; $("pay-cancel").disabled = false; gate();
    if (pay === null) showHoldings().then(() => { $("pay-panel").hidden = false; });
    else if (loadPay(w)) resumePay(); // signed before it failed: only "Finish it" from here
    else quotePay();
  }
}

// What a chained return leaves free on the coldkey, so a later unstake or stake can pay its own fee.
const RETURN_KEEP_RAO = 1_000_000n; // 0.001 TAO

/**
 * The second half of "unstake, then return": sends the TAO the unstake freed, less whatever the return's
 * own costs (bridge fee, gas held on transit, the funding transfer's fee) would overdraw, so the free
 * balance never goes below RETURN_KEEP_RAO. Everything is re-read from the chain here, after the unstake.
 */
async function returnAfterUnstake(freedRao) {
  const w = state.signed.wallet;
  try {
    if (loadReturn(w)) throw new Error("an earlier return from this browser has not finished; finish that one first from \"Bridge to Solana\"");
    const lib = await loadReturnLib();
    const free = await lib.freeBalance(w.address);
    const amount = await fitReturnAmount({
      freed: freedRao, free, keep: RETURN_KEEP_RAO, min: lib.MIN_RETURN_RAO, floor: removeDust,
      leftAfter: async (amt) => {
        const [q, price, t] = await Promise.all([
          lib.quoteReturn({ amountRao: amt, solanaRecipient: solanaRecipient() }), getGasPrice(), transitState(w.transitKey, null),
        ]);
        const plan = lib.planReturnFunding({ amountRao: amt, nativeFeeWei: q.nativeFee, gasPriceWei: price, transitNativeWei: t.native, transitWtaoWei: t.wtao });
        return plan.fundingRao > 0n ? (await lib.quoteTransfer(w.mnemonic, ss58Encode(t.self), plan.fundingRao)).remainingRao : free;
      },
    });
    if (amount === 0n) throw new Error("what the unstake freed does not cover the bridge fee and gas, so it stays as free TAO on Bittensor");
    setDirection("reverse");
    $("amount").value = fmtUnits(amount, 9, 9).replace(/,/g, "");
    $("step-status").scrollIntoView({ behavior: "smooth", block: "start" });
    await runReturn({ amountRao: amount, afterUnstake: true });
  } catch (e) {
    note("move-note", `Unstaked, but the return did not start: ${e.message || e}. The TAO is free on Bittensor; "Bridge to Solana" can bring it home.`, "warn");
  }
}

function trackRev(k, s, msg) {
  const key = { wrap: "deposit", bridge: "send" }[k] ?? k;
  const li = document.querySelector(`#track-rev li[data-k="${key}"]`); if (!li) return;
  li.dataset.s = s; li.querySelector("span").textContent = msg;
}

function requestReturnQuote() {
  clearTimeout(quoteTimer);
  $("r-lzfee").replaceChildren(Object.assign(document.createElement("span"), { className: "skel" }));
  $("sign").disabled = true;
  quoteTimer = setTimeout(async () => {
    const seq = ++state.quoteSeq;
    try {
      const lib = await loadReturnLib();
      const w = state.signed.wallet;
      const [q, price, t] = await Promise.all([
        lib.quoteReturn({ amountRao: state.amountLd, solanaRecipient: solanaRecipient() }),
        getGasPrice(),
        transitState(w.transitKey, null),
      ]);
      const plan = lib.planReturnFunding({ amountRao: state.amountLd, nativeFeeWei: q.nativeFee, gasPriceWei: price, transitNativeWei: t.native, transitWtaoWei: t.wtao });
      const fq = plan.fundingRao > 0n ? await lib.quoteTransfer(w.mnemonic, ss58Encode(t.self), plan.fundingRao) : { feeRao: 0n, remainingRao: state.ret.free ?? 0n };
      if (seq !== state.quoteSeq) return;
      state.ret.quote = { q, plan, fq };
      $("r-lzfee").textContent = tao(q.nativeFee / RAO);
      $("r-gas").textContent = `up to ${tao(plan.gasReserveWei / RAO)} held for gas; what is not used stays yours`;
      $("r-cost").textContent = tao(plan.fundingRao + fq.feeRao);
      $("r-receive").textContent = `${fmtUnits(q.solanaAmountLd, 9)} canonical TAO`;
      if (fq.remainingRao < 0n) {
        note("sign-note", `Not enough free TAO: this return needs ${tao(plan.fundingRao + fq.feeRao)} including fees, and the wallet has ${tao(state.ret.free ?? 0n)}.`, "bad");
        $("sign").disabled = true;
        return;
      }
      if (!loadReturn(w)) note("sign-note", "");
      $("sign").disabled = state.running;
    } catch (e) {
      if (seq === state.quoteSeq) { $("r-lzfee").textContent = "unavailable"; note("sign-note", `Could not quote the return: ${e.message}`, "bad"); }
    }
  }, 350);
}

/**
 * Runs, or continues, the free-TAO return. `amountRao` overrides the amount field (the chained
 * unstake-then-return); `retryReverted` sends again after the user saw the last send revert.
 */
async function runReturn({ amountRao: chosen = null, retryReverted = false, afterUnstake = false } = {}) {
  if (state.running || !RETURN_OPEN) return;
  const w = state.signed.wallet;
  const lib = await loadReturnLib();
  const saved = loadReturn(w);
  const amountRao = saved ? BigInt(saved.amountRao) : chosen ?? state.amountLd;
  const recipient = saved ? saved.recipient : solanaRecipient();
  const baseline = saved ? BigInt(saved.baseline) : await getTaoBalance(clients.connection, state.user);
  const meta = { amountRao: String(amountRao), baseline: String(baseline), recipient, at: saved?.at ?? Date.now() };
  saveReturn(w, { ...meta, progress: saved?.progress ?? {} });

  state.running = true; $("sign").disabled = true; setStep("step-status", "active"); gate();
  for (const li of document.querySelectorAll("#track-rev li")) { li.dataset.s = ""; li.querySelector("span").textContent = "—"; }
  const unstakeLi = document.querySelector('#track-rev li[data-k="unstake"]');
  unstakeLi.hidden = !afterUnstake;
  if (afterUnstake) { unstakeLi.dataset.s = "ok"; unstakeLi.querySelector("span").textContent = "done"; }
  note("track-note", "");
  try {
    const res = await lib.finishFreeReturn({
      mnemonic: w.mnemonic, transitKey: w.transitKey, solanaRecipient: recipient, amountRao, expectedColdkey: w.address,
      progress: saved?.progress ?? {}, retryReverted, onStep: trackRev,
      onCheckpoint: (progress) => saveReturn(w, { ...meta, progress }),
    });
    if (res.pending) throw new Error("the LayerZero send is still pending on Bittensor");
    $("track-links").replaceChildren(link(`https://layerzeroscan.com/tx/${res.sendHash}`, "LayerZero Scan ↗"), text("  ·  "), link(`https://solscan.io/account/${state.user}`, "your Solana wallet ↗"));
    trackRev("send", "ok", "sent through LayerZero");
    const want = baseline + arrivingLd(amountRao);
    const start = Date.now();
    for (;;) {
      const bal = await getTaoBalance(clients.connection, state.user).catch(() => null);
      if (bal !== null && bal >= want) break;
      if (Date.now() - start > 30 * 60_000) throw new Error("the bridge has not delivered to Solana yet: it usually takes minutes, and LayerZero Scan shows where it is. Sign in again later and this page keeps watching");
      trackRev("finish", "busy", `waiting for it on Solana · ${Math.round((Date.now() - start) / 1000)}s`);
      await new Promise((r) => setTimeout(r, 8000));
    }
    trackRev("finish", "ok", `${tao(arrivingLd(amountRao))} arrived`);
    clearReturn(w);
    $("sign").textContent = "Sign and send";
    note("track-note", `Done. ${tao(arrivingLd(amountRao))} is back in your Solana wallet as canonical TAO.`, "ok");
    setStep("step-status", "done");
  } catch (e) {
    const busy = document.querySelector('#track-rev li[data-s="busy"]');
    if (busy) busy.dataset.s = "bad";
    if (e.reverted) {
      // The send reverted, so nothing crossed: the wTAO is still on the transit account. Sending again
      // is the user's call, because a send that fails for a lasting reason would spend gas each time.
      trackRev("send", "bad", "reverted on Bittensor; nothing was sent");
      const again = Object.assign(document.createElement("button"), { type: "button", className: "btn btn-ghost btn-sm", textContent: "Send it again" });
      again.addEventListener("click", () => { again.disabled = true; runReturn({ retryReverted: true }); });
      noteHtml("track-note", [
        text("Bittensor refused the LayerZero send, so nothing crossed and your TAO is still on your transit account as wTAO, "),
        link(`https://evm.taostats.io/tx/${e.hash}`, "the refused transaction ↗"),
        text(". Sending again re-quotes the bridge fee and reuses that wTAO. "), again,
      ], "bad");
    } else {
      note("track-note", `${e.message || e}. Nothing is lost: every step is saved before it is sent, so signing in again on this page continues exactly where it stopped.`, "bad");
    }
  } finally {
    state.running = false;
    if (state.user) refreshBalances();
    refreshReturn();
  }
}

/** Approximate dollars for the TAO being sent and the SOL it costs. Display only; a failed feed hides it. */
async function showUsd(seq, totalLamports) {
  $("r-usd").textContent = "…";
  const p = await usdPrices().catch(() => null);
  if (seq !== state.quoteSeq) return;
  if (!p) { $("r-usd").textContent = "price feed unavailable"; return; }
  const parts = [
    p.tao !== null && `${fmtUsd((Number(state.amountLd) / 1e9) * p.tao)} of TAO`,
    p.sol !== null && `${fmtUsd((Number(totalLamports) / 1e9) * p.sol)} in fees`,
  ].filter(Boolean);
  $("r-usd").textContent = `${parts.join(", ")} (Dexscreener, ${new Date(p.at).toISOString().slice(11, 16)} UTC)`;
}

function requestQuote() {
  clearTimeout(quoteTimer);
  $("r-lzfee").replaceChildren(Object.assign(document.createElement("span"), { className: "skel" }));
  $("sign").disabled = true;
  quoteTimer = setTimeout(async () => {
    const seq = ++state.quoteSeq;
    try {
      const [fee, priority] = await Promise.all([
        quoteNativeFee(clients, { user: state.user, transit: state.signed.wallet.transitAddress, amountLd: state.amountLd }),
        // A failed estimate is not worth blocking the route over: fall back to the configured floor.
        quotePriorityFee(clients.connection).catch(() => CONFIG.priorityFee.minMicroLamports),
      ]);
      if (seq !== state.quoteSeq) return;
      state.nativeFee = fee; state.priorityMicro = priority;
      const prio = priorityFeeLamports(priority);
      const total = fee + prio + BigInt(CONFIG.fee.lamports ?? 0n);
      $("r-lzfee").textContent = sol(fee); $("r-prio").textContent = sol(prio); $("r-total").textContent = sol(total);
      showUsd(seq, total);
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
  if (state.direction === "reverse") return runReturn();
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
      priorityMicroLamports: state.priorityMicro ?? CONFIG.priorityFee.minMicroLamports, // exactly what the review showed
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
    savePending(w, route);

    note("sign-note", "check your wallet…"); track("solana", "busy", "waiting for your signature");
    let signature;
    try {
      if (state.provider.signAndSendTransaction) ({ signature } = await state.provider.signAndSendTransaction(transaction));
      else signature = await clients.connection.sendRawTransaction((await state.provider.signTransaction(transaction)).serialize(), { skipPreflight: false });
    } catch (e) { clearPending(w.transitAddress); throw e; }
    route.sig = signature; savePending(w, route);
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
      : summary.stakeRefused ? `Bittensor refused the stake${netuid === 0n ? "" : ` (the validator changed, or subnet ${netuid}'s price moved past the ${Number(CONFIG.subnetPriceToleranceBps) / 100}% limit)`}, so your TAO arrived unstaked. It is free TAO in your wallet: stake it again at today's price, or bring it back to Solana, from "Show what this Bittensor wallet holds" in step 2, or from any Bittensor wallet.` : "Done. It is free TAO in your Bittensor wallet.", summary.stakeRefused ? "warn" : "ok");
      
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
// The sign-in message names soltao.xyz, so wallets refuse it on any other origin, and static mirrors
// (GitHub Pages, Railway's generated domain) cannot serve this page's CSP. Send them to the real one.
// Local hosts stay, for development and the headless tests.
const CANONICAL = "soltao.xyz";
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;
// The return direction stays shut on soltao.xyz until CONFIG.returnLive; local hosts open it for testing.
const RETURN_OPEN = CONFIG.returnLive === true || LOCAL.test(location.hostname);
// "Top up Chutes" stays shut on soltao.xyz until CONFIG.chutesLive; local hosts open it for testing.
const CHUTES_OPEN = CONFIG.chutesLive === true || LOCAL.test(location.hostname);
function onCanonicalHost() {
  if (location.hostname === CANONICAL || LOCAL.test(location.hostname)) return true;
  location.replace(`https://${CANONICAL}/stake/${location.search}${location.hash}`);
  return false;
}

function setDirection(direction) {
  state.direction = direction;
  document.querySelector(`input[name="direction"][value="${direction}"]`).checked = true;
  document.querySelectorAll(".dir-fwd").forEach(el => el.hidden = (state.direction !== "forward"));
  document.querySelectorAll(".dir-rev").forEach(el => el.hidden = (state.direction !== "reverse"));
  $("amount").value = "";
  state.ret.quote = null;
  if (state.direction === "reverse") {
    // Only the wallet the signature creates can sign a return, so the paste option does not apply.
    document.querySelector('input[name="ck-mode"][value="derive"]').checked = true; applyMode();
    refreshReturn();
  }
  gate();
}

function init() {
  if (!onCanonicalHost()) return;
  if (!LIVE) $("not-live").hidden = false;
  $("connect").addEventListener("click", connect);
  
  // ── direction toggle ────────────────────────────────────────────────────────
  Array.from(document.querySelectorAll("input[name=direction]")).forEach(opt => {
    opt.addEventListener("change", (e) => {
      if (state.running) { e.preventDefault(); return; }
      setDirection(e.target.value);
    });
  });
  if (RETURN_OPEN) document.querySelector('input[name="direction"][value="reverse"]').disabled = false;
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
  $("pick-btn").addEventListener("click", openPicker);
  $("dir-btn").addEventListener("click", openDirectory);
  $("dir-search").addEventListener("input", renderDirectory);
  $("dir-sort").addEventListener("change", renderDirectory);
  $("holdings-btn").addEventListener("click", showHoldings);
  $("move-amount").addEventListener("input", quoteMove);
  $("move-then").addEventListener("change", quoteMove);
  $("move-max").addEventListener("click", () => { if (move) { $("move-amount").value = fmtUnits(move.max, 9, 9).replace(/,/g, ""); quoteMove(); } });
  $("move-go").addEventListener("click", runMove);
  $("move-cancel").addEventListener("click", () => { if (!state.running) { move = null; $("move-panel").hidden = true; } });
  $("pay-to").addEventListener("input", quotePay);
  $("pay-amount").addEventListener("input", quotePay);
  $("pay-ack").addEventListener("change", gatePay);
  $("pay-max").addEventListener("click", () => { if (pay && !pay.resume) { $("pay-amount").value = fmtUnits(pay.max, 9, 9).replace(/,/g, ""); quotePay(); } });
  $("pay-go").addEventListener("click", runPay);
  $("pay-cancel").addEventListener("click", () => { if (!state.running) { pay = null; $("pay-panel").hidden = true; } });
  $("sign").addEventListener("click", send);
  getGasPrice().then((p) => { state.gasPrice = p; gate(); }).catch(() => {});
  addEventListener("beforeunload", (e) => { if (state.running) { e.preventDefault(); e.returnValue = ""; } });
  // Keys live only in memory; drop them when the page goes away.
  addEventListener("pagehide", () => { state.signed = null; $("phrase").replaceChildren(); });
  addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); }); // restored from the back/forward cache without its keys
  prefillFromLink();
  gate();
}

// A shared link can name the subnet and validator: /stake/?netuid=1&hotkey=5F… fills step 3 and runs
// the same on-chain checks as typing them. It only fills fields; nothing is chosen or sent for the user.
function prefillFromLink() {
  const q = new URLSearchParams(location.search);
  const netuid = (q.get("netuid") || "").trim(), hotkey = (q.get("hotkey") || "").trim();
  if (/^\d{1,5}$/.test(netuid)) { $("netuid-in").value = netuid; onNetuid(); }
  if (/^5[1-9A-HJ-NP-Za-km-z]{47}$/.test(hotkey)) { $("hotkey-in").value = hotkey; if (!netuid || netuid === "0") onHotkey(); }
  // ?chutes=5F… (a Chutes payment address) pre-fills "Top up Chutes" once the user opens it; it is
  // still shown, checked and acknowledged there like a pasted one.
  const chutes = (q.get("chutes") || "").trim();
  if (/^5[1-9A-HJ-NP-Za-km-z]{47}$/.test(chutes)) state.chutesPrefill = chutes;
  // With a subnet in the link, onNetuid re-checks the hotkey once the subnet is confirmed.
}

init();
