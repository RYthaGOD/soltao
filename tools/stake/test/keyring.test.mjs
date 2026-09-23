import { coldkeyPair } from "../src/substrate.js";
import { publicKeyFromMnemonic, ss58Encode } from "../src/derive.js";

const mnemonic = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const pair = coldkeyPair(mnemonic);
const expected = ss58Encode(publicKeyFromMnemonic(mnemonic));
if (pair.address !== expected) throw new Error(`signer mismatch: ${pair.address} !== ${expected}`);
console.log(`PASS  return signer is the same derived coldkey ${pair.address}`);
