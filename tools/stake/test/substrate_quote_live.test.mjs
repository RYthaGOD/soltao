// Read-only mainnet checks for the return route's coldkey side. Nothing is submitted.
//   node test/substrate_quote_live.test.mjs
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { verify as srVerify } from "@scure/sr25519";
import { quoteTransfer, prepareTransfer, accountNonce, coldkeySigner, coldkeyPair, getApi, disconnectApi } from "../src/substrate.js";
import { publicKeyFromMnemonic } from "../src/derive.js";

const mnemonic = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const destination = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const hex = (b) => Buffer.from(b).toString("hex");

try {
  const quote = await quoteTransfer(mnemonic, destination, 1_000_000n);
  if (quote.address !== "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV") throw new Error("unexpected derived signer");
  if (quote.feeRao <= 0n) throw new Error("runtime returned no transfer fee");
  console.log(`PASS  live coldkey transfer quote is ${quote.feeRao} rao; no transaction submitted`);

  // Resumable funding signs offline first, so its identity can be saved before it is submitted.
  let signedMsg = null;
  const prepared = await prepareTransfer(mnemonic, destination, 1_000_000n, { onSign: (m) => { signedMsg = m; } });
  const onChain = await accountNonce(prepared.address);
  if (prepared.address !== quote.address) throw new Error("prepared transfer signed by an unexpected key");
  if (!/^0x[0-9a-f]{64}$/.test(prepared.id) || !/^0x[0-9a-f]+$/.test(prepared.signed)) throw new Error("prepared transfer has no extrinsic hash or bytes");
  if (BigInt(prepared.nonce) < onChain) throw new Error(`prepared nonce ${prepared.nonce} is below the on-chain nonce ${onChain}`);
  console.log(`PASS  a funding transfer signs offline against the live runtime (nonce ${prepared.nonce}, id ${prepared.id.slice(0, 12)}…); not submitted`);

  // The signature inside it verifies, under two independent sr25519 implementations.
  const api = await getApi();
  const ext = api.createType("Extrinsic", prepared.signed);
  const sig = ext.signature.toU8a(); // the bare 64 bytes; polkadot strips the MultiSignature tag here
  if (sig.length !== 64) throw new Error(`expected a 64-byte sr25519 signature, got ${sig.length}`);
  const pub = publicKeyFromMnemonic(mnemonic);
  if (!signedMsg || !srVerify(signedMsg, sig, pub)) throw new Error("the WebAssembly-free signature does not verify with @scure/sr25519");
  await cryptoWaitReady();
  if (!signatureVerify(signedMsg, sig, prepared.address).isValid) throw new Error("the WebAssembly-free signature does not verify with polkadot's own sr25519");
  if (!ext.isSigned || ext.signer.toString() !== prepared.address) throw new Error("the extrinsic does not carry the coldkey as signer");
  console.log(`PASS  its signature verifies under @scure/sr25519 and polkadot's own sr25519`);

  // And it is the same extrinsic polkadot's Keyring would build, outside the (randomised) signature.
  const header = await api.rpc.chain.getHeader();
  const opts = { nonce: BigInt(prepared.nonce), blockHash: header.hash, era: api.createType("ExtrinsicEra", { current: header.number, period: 64 }) };
  const ours = api.tx.balances.transferAllowDeath(destination, 1_000_000n);
  const { signer } = coldkeySigner(mnemonic);
  await ours.signAsync(prepared.address, { ...opts, signer });
  const theirs = api.tx.balances.transferAllowDeath(destination, 1_000_000n);
  await theirs.signAsync(coldkeyPair(mnemonic), opts);
  const mask = (e) => e.toHex().replace(hex(e.signature.toU8a()), "");
  if (ours.toHex().length !== theirs.toHex().length || mask(ours) !== mask(theirs)) throw new Error("the WebAssembly-free extrinsic differs from a Keyring-signed one outside the signature");
  console.log(`PASS  byte-identical to a Keyring-signed extrinsic outside the signature (${(ours.toHex().length - 2) / 2} bytes)`);
} finally {
  await disconnectApi();
}
