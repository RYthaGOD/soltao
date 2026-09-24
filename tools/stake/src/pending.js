// The unfinished route the page remembers in localStorage, sealed so it cannot be quietly edited.
//
// A resume pays out to the `coldkey` saved here. Anything that can write this origin's storage (a
// malicious extension, someone at the keyboard) could otherwise swap that destination and wait for
// the user to click "Finish it". So the saved route carries an HMAC keyed from the transit key, which
// exists only in memory after the user signs. A route whose MAC does not verify is ignored, and the
// page falls back to its no-memory behaviour: finish to the wallet on screen.

import { hmac } from "@noble/hashes/hmac";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

const utf8 = (s) => new TextEncoder().encode(s);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const FIELDS = ["plan", "hotkey", "coldkey", "netuid", "reserveRao", "amountLd", "sig", "at"];

const macKey = (transitKey) => hkdf(sha256, transitKey, utf8("soltao.xyz/pending-route/v1"), utf8("mac"), 32);
// Fixed field order, so the MAC never depends on how JSON.stringify happened to order keys.
const body = (route) => JSON.stringify(FIELDS.map((f) => route[f] ?? null));

/** The route with its MAC, ready to store. */
export function sealRoute(route, transitKey) {
  const clean = Object.fromEntries(FIELDS.map((f) => [f, route[f] ?? null]));
  return { ...clean, mac: hex(hmac(sha256, macKey(transitKey), utf8(body(clean)))) };
}

const saneShape = (s) => s && typeof s === "object" && typeof s.coldkey === "string" && /^\d+$/.test(s.amountLd) && /^\d+$/.test(s.reserveRao);

/**
 * What the page may do with whatever is stored, given the wallet now on screen.
 *
 *   null        nothing usable stored
 *   trusted     sealed by this wallet: finish exactly as saved
 *   untrusted   saved by the page before sealing existed (live until 24 Sep 2026), or a seal that does
 *               not verify. Its hotkey and netuid are only hints for finding stake already sitting on
 *               the transit account, which the chain then confirms. Nothing is trusted to pay out: the
 *               destination is always `onScreen`, and a route that has not staked yet delivers free TAO
 *               instead of staking to a hotkey nobody can vouch for.
 */
export function readRoute(stored, transitKey, onScreen) {
  const sealed = openRoute(stored, transitKey);
  if (sealed) return { trusted: true, route: sealed, destination: sealed.coldkey, savedDestination: sealed.coldkey };
  if (!saneShape(stored)) return null;
  const hints = Object.fromEntries(FIELDS.map((f) => [f, stored[f] ?? null]));
  const hotkeyOk = typeof hints.hotkey === "string" && /^0x[0-9a-f]{64}$/i.test(hints.hotkey);
  const netuidOk = /^\d+$/.test(String(hints.netuid ?? "0"));
  return {
    trusted: false,
    route: { ...hints, hotkey: hotkeyOk ? hints.hotkey : null, netuid: netuidOk ? String(hints.netuid ?? "0") : "0", coldkey: onScreen ?? null },
    destination: onScreen ?? null,
    savedDestination: stored.coldkey,
  };
}

/** Stake found on the transit account can be handed over; an untrusted route stakes nothing new. */
export const untrustedPlan = (found) => (found.stake > 0n ? "stake" : "deliver");

// ── any other record the page must not trust unsealed (the return route's checkpoints) ──
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v));
const labelKey = (transitKey, label) => hkdf(sha256, transitKey, utf8(`soltao.xyz/${label}/v1`), utf8("mac"), 32);

/** `value` (plain JSON) with a MAC over its canonical form, keyed from the transit key and a label. */
export function sealRecord(value, transitKey, label) {
  return { value, mac: hex(hmac(sha256, labelKey(transitKey, label), utf8(canonical(value)))) };
}

/** The value if the record was sealed by this key under this label, otherwise null. */
export function openRecord(stored, transitKey, label) {
  if (!stored || typeof stored !== "object" || typeof stored.mac !== "string" || !("value" in stored)) return null;
  const want = hex(hmac(sha256, labelKey(transitKey, label), utf8(canonical(stored.value))));
  let diff = want.length ^ stored.mac.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (stored.mac.charCodeAt(i) || 0);
  return diff === 0 ? stored.value : null;
}

/** The stored route if its MAC verifies and its shape is sane, otherwise null. */
export function openRoute(stored, transitKey) {
  if (!stored || typeof stored !== "object" || typeof stored.mac !== "string") return null;
  const want = hex(hmac(sha256, macKey(transitKey), utf8(body(stored))));
  let diff = want.length ^ stored.mac.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (stored.mac.charCodeAt(i) || 0);
  if (diff !== 0) return null;
  return saneShape(stored) ? Object.fromEntries(FIELDS.map((f) => [f, stored[f]])) : null;
}
