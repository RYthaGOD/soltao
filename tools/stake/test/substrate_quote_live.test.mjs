// Read-only check that the derived coldkey can price the funding transfer used by bridge-back.
import { quoteTransfer, prepareTransfer, accountNonce, disconnectApi } from "../src/substrate.js";

const mnemonic = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const destination = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

try {
  const quote = await quoteTransfer(mnemonic, destination, 1_000_000n);
  if (quote.address !== "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV") throw new Error("unexpected derived signer");
  if (quote.feeRao <= 0n) throw new Error("runtime returned no transfer fee");
  console.log(`PASS  live coldkey transfer quote is ${quote.feeRao} rao; no transaction submitted`);

  // Resumable funding signs offline first, so its identity can be saved before it is submitted.
  // Signing against the live runtime proves the call shape and era; nothing is submitted here.
  const signed = await prepareTransfer(mnemonic, destination, 1_000_000n);
  const onChain = await accountNonce(signed.address);
  if (signed.address !== quote.address) throw new Error("prepared transfer signed by an unexpected key");
  if (!/^0x[0-9a-f]{64}$/.test(signed.id) || !/^0x[0-9a-f]+$/.test(signed.signed)) throw new Error("prepared transfer has no extrinsic hash or bytes");
  if (BigInt(signed.nonce) < onChain) throw new Error(`prepared nonce ${signed.nonce} is below the on-chain nonce ${onChain}`);
  console.log(`PASS  a funding transfer signs offline against the live runtime (nonce ${signed.nonce}, id ${signed.id.slice(0, 12)}…); not submitted`);
} finally {
  await disconnectApi();
}
