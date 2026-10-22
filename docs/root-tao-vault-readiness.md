# Root TAO vault implementation status

22 October 2026. **Not live; not ready for deposits.**

The user requested continuing through to a usable live product. That direction authorizes
development and release preparation. It does not make incomplete backing or custody guarantees
true. Personal wallet proof was deferred at the user's request; do not request that address again
as a prerequisite for this engineering work.

## Implemented

- Pure accounting specification: `tools/stake/vault/model.mjs`, twelve scenario/property tests,
  including liquid/staked backing, pending unstakes, actual realization before reserving exits,
  and Root reward proceeds remaining staked.
- Solidity prototype adapter: `tools/stake/vault/RootStakeAdapter.sol`, pinned compiler 0.8.24.
  Constructor binds an owner and root validator; only that owner can stake, unstake, claim or
  pay out. **It is a privileged capability prototype, not a user-facing vault.** No share mint,
  user redemption, accounting integration, timelock or production authority policy exists yet.
- Read-only runtime probe: `tools/stake/test/VaultCapability.sol` creates the adapter inside
  `eth_call`, exercising the real constructor and mapped contract coldkey. It stakes, queries
  rewards, attempts a claim, checks four unauthorized actions, unstakes and recovers funds.
  Only the test harness bytecode is injected with a state override. No state persists.
- Operator command: `npm run test:vault:live -- --save`; complete JSON evidence is saved before
  the command reports an incomplete required capability. A missing reward view or rejected
  claim causes a nonzero exit. Never report success merely because stake/unstake worked.

## Current finalized-state evidence

See [machine-readable report](vault-capability-2026-10-22.json). Runtime 482, finalized block
9,336,777, hash `0x1f59977222994c2211e08c9a13a3310f53cda808e6fc3eb7c78262409b76ce5c`:

| Capability | Result |
|---|---|
| Contract-owned root staking | 99,999,999 rao recorded after requested 100,000,000 rao |
| Reward read | Call returned a 32-byte value |
| Root reward claim | Bulk `claimRoot(uint16[])` with empty compatibility array accepted; no payout on fresh stake |
| Unauthorized stake/unstake/claim/payout | All rejected with the adapter's authorization error |
| Contract root unstake | Remaining root stake zero |
| Payout back to harness | 199,998,999,000,000,000 wei recovered from initial 0.2 TAO simulation funding |
| Paid reward claim | Not proven; fresh stake cannot earn rewards within the same call |

The initial selected-validator call `claimRootWithHotkey(bytes32)` reverted, including with large
gas envelopes. A direct read-only call exposed the underlying error: `RootClaimTooHeavy`. The
legacy-looking `claimRootHotkey(bytes32)` selector was explicitly rejected as unknown. The
documented bulk claim uses the coldkey-wide admission budget and succeeded from the adapter.
This is a tested alternative for this scenario, not a general guarantee for arbitrarily large
validator sets.

The successful empty-rewards bulk claim measured 330,062 gas inside the adapter-call scope,
but needed a larger allowance: 10 million forwarded gas failed, 100 million succeeded. Final
probe used 150 million outer gas and 100 million forwarded to the adapter. Declared admission
and measured execution differ. These are simulation observations, not a production fee quote,
transaction gas configuration or proof that a paid claim fits the same envelope.

## Remaining work in dependency order

1. Prove a positive claim payout with controlled local-chain rewards, not just the now-accepted
   zero-value call. Check production gas admission and third-party hotkey-list growth protections.
2. Extend the tested liquid/staked and unstake-to-reserve model to actual chain settlement,
   fees, gas funding, partial outcomes, user exit queues and recovery.
3. Verify the existing TAO OFT integration capabilities and choose the authenticated share and
   asset transport. Define one economic share ledger across chains, finality, replay protection
   and refund/finalization exclusivity.
4. Implement the vault/share contracts using the tested model; define every privileged action,
   upgrade, pause and recovery authority. No production key or multisig membership selected.
5. Prove end-to-end test-fund issuance, rewards and redemption on supported test infrastructure.
   Review the contracts independently before production deployment, as required by the
   `build-defi-protocol` skill. Review disclosures and production operating requirements.
6. Deploy the reviewed configuration and verify contracts, receipt supply, backing and live
   redemption. A website deployment alone cannot make this product ready for deposits.

## Verification in this pass

Solidity compiled successfully and the final live read-only probe passed its call/authorization
checks. Earlier diagnostic probes deliberately returned nonzero when a required claim failed.
All twelve accounting tests passed, including 5,000 seeded transitions and 250 no-profit
deposit/exit loops. Accounting tests remain separate from runtime capability evidence. Existing
production browser bundles were not changed.

Sources: [official staking V2 reference](https://www.bittensor.com/docs/guides/evm/precompiles/staking-v2),
[staking ABI](https://github.com/opentensor/subtensor/blob/main/precompiles/src/solidity/stakingV2.sol),
[precompile implementation](https://github.com/opentensor/subtensor/blob/main/precompiles/src/staking.rs).
Checked 22 October 2026. Source main branches are mutable; the recorded finalized-state report is
the authority for what this particular simulation observed.
