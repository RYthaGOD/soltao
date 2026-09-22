// Browser build only: stands in for @layerzerolabs/lz-utilities and @layerzerolabs/lz-foundation.
//
// The Solana SDK imports six small helpers from those two packages, and they drag in LayerZero's
// multi-chain tooling with them: a Cosmos SDK (3.6 MB), memoizee, secp256k1, bech32, and code that
// needs eval, which the site's CSP forbids. These are equivalent implementations of just the six.
// test/shim.test.mjs checks them against the real packages, output for output.

import { keccak_256 as nobleKeccak, sha3_256 as nobleSha3 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";

const HEX = /^(0x)?[0-9A-F]*$/i;

export function isHex(value) {
  return /^(0x)?[0-9A-F]+$/i.test(value);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    if (!HEX.test(value)) throw new Error("Invalid hex string");
    const hex = value.replace(/^0x/i, "");
    const even = hex.length % 2 ? "0" + hex : hex;
    const out = new Uint8Array(even.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (typeof value === "number") {
    if (value < 0) throw new Error("Number must be non-negative");
    const bytes = [];
    while (value > 0) { bytes.unshift(value & 255); value >>= 8; }
    return new Uint8Array(bytes);
  }
  if (typeof value === "bigint") return toBytes(value.toString(16));
  if (value && typeof value.length === "number") return new Uint8Array(value);
  throw new Error("unsupported type");
}

export function padify(hexOrBytes, { dir, size = 32 } = {}) {
  if (size === null) return hexOrBytes;
  if (typeof hexOrBytes === "string") {
    const value = hexOrBytes.replace("0x", "");
    if (value.length > size * 2) throw new Error(`size ${Math.ceil(value.length / 2)} exceeds padding size ${size}`);
    return `0x${dir === "right" ? value.padEnd(size * 2, "0") : value.padStart(size * 2, "0")}`;
  }
  if (hexOrBytes.length > size) throw new Error(`size ${hexOrBytes.length} exceeds padding size ${size}`);
  const out = new Uint8Array(size);
  out.set(hexOrBytes, dir === "right" ? 0 : size - hexOrBytes.length);
  return out;
}

export function arrayify(value, size) {
  const bytes = toBytes(value);
  return size === undefined ? bytes : padify(bytes, { size });
}

export function hexlify(value) {
  if (typeof value === "string" && HEX.test(value)) return "0x" + value.replace(/^0x/i, "");
  const hex = Array.from(arrayify(value), (b) => b.toString(16).padStart(2, "0")).join("");
  if (!hex) throw new Error("invalid hex string"); // matches lz-utilities: empty bytes do not hexlify
  return "0x" + hex;
}

export const keccak_256 = (message) => nobleKeccak(message);
export const sha2_256 = (message) => sha256(message);

// Unused by the Solana path; exported so a stray import fails loudly at build time, not silently.
export const sha3_256 = (message) => nobleSha3(message);
