// Read-only check that the derived coldkey can price the funding transfer used by bridge-back.
import { quoteTransfer, disconnectApi } from "../src/substrate.js";

const mnemonic = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const destination = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

try {
  const quote = await quoteTransfer(mnemonic, destination, 1_000_000n);
  if (quote.address !== "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV") throw new Error("unexpected derived signer");
  if (quote.feeRao <= 0n) throw new Error("runtime returned no transfer fee");
  console.log(`PASS  live coldkey transfer quote is ${quote.feeRao} rao; no transaction submitted`);
} finally {
  await disconnectApi();
}
