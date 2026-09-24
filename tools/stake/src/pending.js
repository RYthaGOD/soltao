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

/** The stored route if its MAC verifies and its shape is sane, otherwise null. */
export function openRoute(stored, transitKey) {
  if (!stored || typeof stored !== "object" || typeof stored.mac !== "string") return null;
  const want = hex(hmac(sha256, macKey(transitKey), utf8(body(stored))));
  let diff = want.length ^ stored.mac.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (stored.mac.charCodeAt(i) || 0);
  if (diff !== 0) return null;
  const okShape = typeof stored.coldkey === "string" && /^\d+$/.test(stored.amountLd) && /^\d+$/.test(stored.reserveRao);
  return okShape ? Object.fromEntries(FIELDS.map((f) => [f, stored[f]])) : null;
}
