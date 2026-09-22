// Derivation must match btcli byte for byte, or users cannot import the wallet anywhere else.
// Substrate's well-known development phrase has published addresses; if these match, the whole
// phrase → entropy → mini-secret → sr25519 → SS58 chain matches sp_core's `from_phrase`.

import { ed25519 } from "@noble/curves/ed25519";
import { ethers } from "ethers";
import {
  derivationMessage, mnemonicFromSignature, publicKeyFromMnemonic, ss58Encode, ss58Decode, walletFromSignature, toHex,
  transitKeyFromSignature, evmAddress,
} from "../src/derive.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

const DEV = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
expect("dev phrase, no path → Substrate's published root address",
  ss58Encode(publicKeyFromMnemonic(DEV)) === "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV", ss58Encode(publicKeyFromMnemonic(DEV)));

// Alice is //Alice off the same phrase, a hard derivation this module never uses; checking her
// public key through SS58 alone confirms the encoder against a second published vector.
const ALICE_PUB = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
expect("SS58 encodes Alice's public key to her published address",
  ss58Encode(Uint8Array.from(Buffer.from(ALICE_PUB.slice(2), "hex"))) === "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
expect("SS58 round-trips", toHex(ss58Decode("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")) === ALICE_PUB);

for (const [label, bad] of [["typo", "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQZ"], ["Solana address", "taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY"], ["garbage", "0xabc"]]) {
  let threw = false; try { ss58Decode(bad); } catch { threw = true; }
  expect(`SS58 rejects a ${label}`, threw);
}

// Determinism: the same Solana key signing the same message yields the same Bittensor wallet.
const solanaSecret = ed25519.utils.randomPrivateKey();
const solanaAddress = "SoLtaoTest1111111111111111111111111111111111";
const msg = new TextEncoder().encode(derivationMessage(solanaAddress));
const sigA = ed25519.sign(msg, solanaSecret), sigB = ed25519.sign(msg, solanaSecret);
const a = walletFromSignature(sigA, solanaAddress), b = walletFromSignature(sigB, solanaAddress);
expect("ed25519 signs the message identically twice", toHex(sigA) === toHex(sigB));
expect("same Solana wallet → same Bittensor wallet", a.address === b.address && a.mnemonic === b.mnemonic, a.address);
expect("phrase is 12 words", a.mnemonic.split(" ").length === 12);
expect("phrase re-derives the same address (what btcli would do)", ss58Encode(publicKeyFromMnemonic(a.mnemonic)) === a.address);
const other = walletFromSignature(ed25519.sign(msg, ed25519.utils.randomPrivateKey()), solanaAddress);
expect("a different Solana wallet → a different Bittensor wallet", other.address !== a.address);
expect("the address binds in: same signature, other address → other wallet",
  walletFromSignature(sigA, "AnotherSoLAddress111111111111111111111111111").address !== a.address);

// The transit key: deterministic, a valid secp256k1 key, and independent of the coldkey.
expect("same signature → same transit account", a.transitAddress === b.transitAddress, a.transitAddress);
expect("transit address matches ethers for the same private key",
  a.transitAddress === new ethers.Wallet(toHex(a.transitKey)).address.toLowerCase());
expect("transit key differs from the coldkey's secret material", toHex(a.transitKey) !== toHex(a.publicKey));
expect("a different Solana wallet → a different transit account", other.transitAddress !== a.transitAddress);
{
  const n = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
  let inRange = true;
  for (let i = 0; i < 200; i++) { const k = BigInt(toHex(transitKeyFromSignature(ed25519.sign(msg, ed25519.utils.randomPrivateKey()), solanaAddress))); if (k < 1n || k >= n) inRange = false; }
  expect("transit keys always fall inside [1, n-1] (200 samples)", inRange);
}

let threw = false; try { mnemonicFromSignature(new Uint8Array(10), solanaAddress); } catch { threw = true; }
expect("rejects a signature that is not 64 bytes", threw);

// A stray non-ASCII byte (an em dash, added 22 Sep 2026 to dodge an unrelated worry) made Phantom's
// own signIn() and signMessage() both refuse this message with "invalid formatting" (code -32000),
// live, twice. The reference SIWS parser didn't care; Phantom's real implementation did. Guard it.
{
  const msg = derivationMessage(solanaAddress);
  const bad = [...msg].filter((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== "\n"));
  expect("the signed-in message is plain ASCII (no smart punctuation, no control characters)", bad.length === 0, JSON.stringify(bad));
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
