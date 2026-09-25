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

    // Root rewards (src/substrate.js, "root rewards"): the claim call, the basket reads, the minimum.
    const claim = args(api.tx.subtensorModule.claimRootWithHotkey);
    if (claim.length !== 1 || claim[0] !== "hotkey:AccountId32") throw new Error(`unexpected claimRootWithHotkey metadata: ${claim.join(", ")}`);
    console.log(`PASS  subtensorModule.claimRootWithHotkey(${claim.join(", ")})`);
    const basket = api.call.betaBasketRuntimeApi;
    if (!basket?.getRootBasketPositions || !basket?.getBasketPayout) throw new Error("BetaBasketRuntimeApi.getRootBasketPositions / getBasketPayout are missing");
    const nobody = "5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM"; // a key with no stake
    const rows = await basket.getRootBasketPositions(nobody);
    if (!Array.isArray(rows.toArray?.() ?? rows)) throw new Error("getRootBasketPositions did not return a list");
    const threshold = await api.query.subtensorModule.rootClaimableThreshold(0);
    const minRao = BigInt((threshold.bits ?? threshold).toString()) >> 32n;
    if (minRao <= 0n || minRao > 1_000_000_000n) throw new Error(`implausible root claim minimum: ${minRao} rao`);
    console.log(`PASS  BetaBasketRuntimeApi reads answer (${rows.length} positions for an empty key); root claim minimum ${Number(minRao) / 1e9} TAO`);
  } finally {
    await api.disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
