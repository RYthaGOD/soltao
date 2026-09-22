// A Bittensor wallet that belongs to a Solana wallet.
//
// The user signs one fixed message with their Solana wallet. Ed25519 signatures are deterministic,
// so the same wallet always produces the same signature, and so the same Bittensor wallet. That
// signature is stretched into a standard 12-word phrase, which is an ordinary Bittensor coldkey:
// sr25519, no derivation path, SS58 prefix 42. It imports into btcli and any Substrate wallet.
//
// Whoever holds the signature holds the wallet. The message is written in Sign-In-With-Solana
// form so a wallet that checks the requesting domain can warn on any site but soltao.xyz.

import { hkdf } from "@noble/hashes/hkdf";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { blake2b } from "@noble/hashes/blake2b";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { secretFromSeed, getPublicKey } from "@scure/sr25519";
import { base58 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

export const SS58_PREFIX = 42;
const HKDF_SALT = "soltao.xyz/bittensor-wallet/v1";
const utf8 = (s) => new TextEncoder().encode(s);

/**
 * The Sign In With Solana fields the user signs. Changing any of them changes every derived wallet.
 *
 * Keep this text plain ASCII. That was the actual cause of two live failures on 22 Sep 2026 ("The
 * app's signature request cannot be shown due to invalid formatting.", code -32000, thrown inside
 * Phantom's own solana.js from both signMessage() and its real signIn() — same internal validator
 * either way, which is what pointed away from the message *shape* and toward its *bytes*): the
 * statement's em dash (U+2014), added to dodge an unrelated colon-parsing worry that turned out not
 * to be real (hand-traced our colon-containing text through the reference parser and reconstructor,
 * createSignInMessageText in @solana/wallet-standard-util, and it round-trips perfectly — Phantom's
 * own docs example doesn't avoid colons either). A period fixed it. Confirmed no non-ASCII or
 * control characters remain in the full message (test/derive.test.mjs enforces this going forward).
 */
export function signInFields(solanaAddress, { domain = "soltao.xyz", uri = "https://soltao.xyz/stake/" } = {}) {
  return {
    domain, address: solanaAddress, uri, version: "1", chainId: "mainnet",
    statement: `Create my Bittensor wallet. Only sign this on ${domain}. This signature is the key to that wallet. It moves no funds.`,
  };
}

/** The exact text a fallback signMessage() call signs: signInFields(), laid out by hand. */
export function derivationMessage(solanaAddress, opts) {
  const f = signInFields(solanaAddress, opts);
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.address,
    "",
    f.statement,
    "",
    `URI: ${f.uri}`,
    `Version: ${f.version}`,
    `Chain ID: ${f.chainId}`,
  ].join("\n");
}

/** 64-byte ed25519 signature → 12-word phrase. Bound to the signing address as HKDF info. */
export function mnemonicFromSignature(signature, solanaAddress) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error("expected a 64-byte ed25519 signature");
  const entropy = hkdf(sha256, signature, utf8(HKDF_SALT), utf8(solanaAddress), 16);
  return entropyToMnemonic(entropy, wordlist);
}

/** Substrate's mini-secret: PBKDF2-SHA512 over the phrase's *entropy*, salt "mnemonic", 2048 rounds. */
function miniSecret(mnemonic) {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("not a valid 12/24-word phrase");
  const entropy = mnemonicToEntropy(mnemonic, wordlist);
  return pbkdf2(sha512, entropy, utf8("mnemonic"), { c: 2048, dkLen: 64 }).slice(0, 32);
}

/** Phrase → sr25519 public key, exactly as btcli's `sr25519::Pair::from_phrase(phrase, None)`. */
export function publicKeyFromMnemonic(mnemonic) {
  return getPublicKey(secretFromSeed(miniSecret(mnemonic)));
}

function checksum(payload) {
  return blake2b(new Uint8Array([...utf8("SS58PRE"), ...payload]), { dkLen: 64 }).slice(0, 2);
}

export function ss58Encode(publicKey, prefix = SS58_PREFIX) {
  if (publicKey.length !== 32) throw new Error("expected a 32-byte public key");
  const payload = new Uint8Array([prefix, ...publicKey]);
  return base58.encode(new Uint8Array([...payload, ...checksum(payload)]));
}

/** SS58 → 32-byte key. Throws on anything that is not a checksummed prefix-42 address. */
export function ss58Decode(address) {
  let bytes;
  try { bytes = base58.decode(address.trim()); } catch { throw new Error("not a valid SS58 address"); }
  if (bytes.length !== 35) throw new Error("not a 32-byte SS58 address");
  if (bytes[0] !== SS58_PREFIX) throw new Error(`expected a Bittensor address (prefix ${SS58_PREFIX}, starts with 5)`);
  const want = checksum(bytes.slice(0, 33));
  if (bytes[33] !== want[0] || bytes[34] !== want[1]) throw new Error("SS58 checksum does not match: check for a typo");
  return bytes.slice(1, 33);
}

export const toHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ── the transit key ─────────────────────────────────────────────────────────
// The bridge can only deliver to a Bittensor EVM (H160) address, so the same signature also yields a
// secp256k1 key for one: the transit account. It receives the bridged wTAO, unwraps it, stakes it
// and hands the stake to the coldkey above. It belongs to the user exactly as the coldkey does, and
// is empty again when a route finishes. A separate HKDF domain keeps the two keys independent.

const TRANSIT_SALT = "soltao.xyz/bittensor-transit/v1";

/** 32-byte secp256k1 private key: 48 bytes of HKDF output reduced into [1, n-1], per FIPS 186-4 B.4.1. */
export function transitKeyFromSignature(signature, solanaAddress) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error("expected a 64-byte ed25519 signature");
  const okm = hkdf(sha256, signature, utf8(TRANSIT_SALT), utf8(solanaAddress), 48);
  const n = secp256k1.CURVE.n;
  let k = 0n;
  for (const b of okm) k = (k << 8n) | BigInt(b);
  k = (k % (n - 1n)) + 1n;
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(k & 0xffn); k >>= 8n; }
  return out;
}

/** Lower-case H160 for a secp256k1 private key. */
export function evmAddress(privateKey) {
  const pub = secp256k1.getPublicKey(privateKey, false).slice(1);
  return toHex(keccak_256(pub).slice(-20));
}

/** Everything the page needs from one signature. */
export function walletFromSignature(signature, solanaAddress) {
  const mnemonic = mnemonicFromSignature(signature, solanaAddress);
  const publicKey = publicKeyFromMnemonic(mnemonic);
  const transitKey = transitKeyFromSignature(signature, solanaAddress);
  return { mnemonic, publicKey, address: ss58Encode(publicKey), transitKey, transitAddress: evmAddress(transitKey) };
}
