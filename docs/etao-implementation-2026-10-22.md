# eTAO: verified findings and implementation sequence

22 October 2026. Prepared from the supplied report, project code and finalized Bittensor reads.

## What is verified

The inspector recorded finalized block **9,336,573**, hash
`0x4429433e7fa4b6b4e9817ef82fae0ce32fcbdcfce8e8e316c1aea49370d54992`,
at **2026-10-22 04:14:24 UTC (12:14:24 Perth)**, runtime **482**.
Exact integer fractions and runtime identity are in [the snapshot](etao-snapshot-2026-10-22.json).

| Subnet | Owner % | Validator bucket % | Miner % | Root baseline % | Alpha-validator remainder % |
|---|---:|---:|---:|---:|---:|
| 8 | 0 | 50 | 50 | 5.4980 | 44.5020 |
| 41 | 10 | 40 | 50 | 5.7441 | 34.2559 |
| 47 | 18 | 12.6 | 69.4 | 12.4512 | 0.1488 |

All columns are percentages of that subnet's alpha emissions, not annual returns. Values are
rounded to four decimal places; raw parts use a denominator of `u64::MAX`. These examples verify
the report's split figures at this block, not their future persistence or subnet branding.

The particularly material finding is subnet 47: a 12.6% validator bucket left only about
0.1488% of total alpha emissions for alpha validators at this block. A UI showing only the
validator bucket would hide most of the economic distinction.

The runtime source at
[emission_weights.rs](https://github.com/opentensor/subtensor/blob/main/pallets/subtensor/src/subnets/emission_weights.rs)
defines five slots: burn, recycle, owner, validator, miner. It documents the owner maximum of
33%, lease floor at the canonical owner default, validator maximum of 50%, and miner minimum
of 33%. Burn/recycle are reserved at zero in this version. The main branch is mutable and is
supporting source context, not evidence that all of its code runs in runtime 482.

Root's baseline depends on the subnet's alpha issuance and global weighted Root stake. It is
not a network-wide fixed 5.4%. Root receives `min(validator allocation, baseline)`; alpha
validators receive the remainder. If the baseline overtakes an existing validator allocation,
the remainder can reach zero. Root priority does not guarantee a fixed payout or APY.

The report's exact activation block, launch timing and weekly update limit were not independently
verified in this pass. They must not become hardcoded product rules on this evidence alone.

## Implemented locally

`tools/stake/etao.mjs` validates exact five-slot vectors and reads all requested subnets from one
finalized state. It rejects invalid IDs, absent subnets, missing eTAO storage, malformed totals,
inexact integer input and enabled reserved slots. The optional runtime view supplies Root's
baseline/payment; its payment is checked against the validator cap. Unknown baseline data stays
null, rather than receiving a fixed default.

`tools/stake/etao-inspect.mjs` exposes that read as an operator command with a 60-second overall
deadline. JSON is emitted only after the complete snapshot succeeds. No signer or transaction
submission is used. These files are outside the published browser bundles.

```powershell
cd D:\TAO\tools\stake
npm run test:etao
npm run etao:inspect -- 8 41 47
```

Tests cover exact decoding, rejected input, finalized block consistency, unsupported metadata,
missing subnets, unavailable Root data, capped Root payments, zero alpha remainder and inconsistent
Root payment. `pretest` runs these checks before the existing regression suite.

Validation: dedicated eTAO tests and live finalized inspector passed. The existing `npm test`
suite passed with network access, including the unsigned Solana mainnet simulation at
509,017 / 650,000 compute units. The first restricted-network attempt stopped on an RPC
permission error; the network-enabled rerun completed successfully. No broadcast occurred.

## Next implementation milestones

1. Complete the existing [Move and Claim proof gate](gateway-proof-runbook.md) using the user's
   live wallet and record public transaction evidence. The [gateway plan](gateway-plan.md) says:
   “Do not start a new feature, and do not name a subnet, until that is done.” This pass prepares
   operator research; it does not change the staking interface or recommend these example subnets.
2. After that gate, show emission allocations in each subnet profile, including Root and the
   alpha-validator remainder, with block/time and explicit unavailable/error states. Keep Root's
   own profile separate; it has no configurable subnet split.
3. Add neutral comparisons such as owner allocation and alpha-validator remainder. Avoid
   “staker-friendly” rankings based on allocation alone: stake dilution, validator performance,
   take, pool price, trading costs and liquidity also affect outcomes.
4. Estimate returns from actual share-value history and current stake/emission inputs, separating
   alpha-unit earnings from TAO-price changes and route/claim fees. Label trailing observations
   separately from scenarios. A simple validator-percentage multiplier is insufficient.
5. Add timestamped history and split-change detection after the live fields are verified. Do not
   add alerts until an opted-in delivery mechanism and durable collection cadence exist.

No deployment, wallet action, outreach or token changes were performed.
