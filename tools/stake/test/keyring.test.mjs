import { coldkeyPair } from "../src/substrate.js";
import { publicKeyFromMnemonic, ss58Encode } from "../src/derive.js";

const mnemonic = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const pair = coldkeyPair(mnemonic);
const expected = ss58Encode(publicKeyFromMnemonic(mnemonic));
if (pair.address !== expected) throw new Error(`signer mismatch: ${pair.address} !== ${expected}`);
console.log(`PASS  return signer is the same derived coldkey ${pair.address}`);

// The browser signs with @scure/sr25519 (no WebAssembly); it must be the same account.
import { coldkeySigner } from "../src/substrate.js";
const scure = coldkeySigner(mnemonic);
if (scure.address !== expected) throw new Error(`scure signer mismatch: ${scure.address} !== ${expected}`);
console.log(`PASS  the WebAssembly-free signer is the same derived coldkey ${scure.address}`);
