import { ApiPromise, HttpProvider } from "@polkadot/api";

async function main() {
  const provider = new HttpProvider("https://lite.chain.opentensor.ai");
  const api = await ApiPromise.create({ provider, noInitWarn: true });
  try {
    const hash = await api.rpc.chain.getBlockHash();
    const header = await api.rpc.chain.getHeader(hash);
    const args = (call) => call.meta.args.map((arg) => `${arg.name}:${arg.type.toString()}`);
    const removeStake = args(api.tx.subtensorModule.removeStake);
    const transfer = args(api.tx.balances.transferAllowDeath);
    if (removeStake.length !== 3 || removeStake[0] !== "hotkey:AccountId32" || removeStake[1] !== "netuid:u16" || removeStake[2] !== "amountUnstaked:u64") {
      throw new Error(`unexpected removeStake metadata: ${removeStake.join(", ")}`);
    }
    if (transfer.length !== 2 || transfer[0] !== "dest:MultiAddress" || transfer[1] !== "value:Compact<u64>") {
      throw new Error(`unexpected transferAllowDeath metadata: ${transfer.join(", ")}`);
    }
    console.log(`PASS  block ${header.number}: removeStake(${removeStake.join(", ")})`);
    console.log(`PASS  balances.transferAllowDeath(${transfer.join(", ")})`);
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
