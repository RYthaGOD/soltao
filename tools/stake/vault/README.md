# Root TAO receipt — offline accounting prototype

Run `npm run test:vault` from `tools/stake`. No network or wallet is used.

`npm run test:vault:live -- --save` compiles the Solidity capability prototype and simulates it
against finalized Bittensor state. Read-only network access is required. It never deploys or
broadcasts. The bulk claim call, staking, unstaking, payout and authorization checks pass; a
positive reward payout remains unproven. See `docs/root-tao-vault-readiness.md` and its recorded
JSON report. Do not deploy the privileged prototype adapter.

`model.mjs` is an executable specification, not a contract, token or bridge service. All events
are trusted simulation inputs; production authorization, finality and proof verification are
absent. Do not connect it to funds or use event IDs as a substitute for message authentication.

## Policies modeled

- Pending deposits remain separate from shareholder backing until accepted. Acceptance uses
  pre-deposit backing and supply, rounds shares down, and enforces stored minimum output.
- Pricing waits until observed rewards are fully realized. A mismatch in realization fails;
  reconciliation of uncertain reward estimates remains future work.
- Active backing is split into liquid and staked balances. Root rewards increase staked backing.
  Allocations and unstake requests have unique operation IDs. Requesting an unstake does not
  create liquid assets: a matching realization must arrive before exits or expenses can use it.
- Virtual offsets are one raw asset unit and 1,000,000,000 raw share units. They are accounting
  offsets, not owned or spendable shares. Initial conversion therefore uses nine more raw share
  digits than raw asset digits; actual receipt decimals are not a deployment decision yet.
- Donations are quarantined and excluded from pricing. Production needs an enforceable way to
  distinguish donations from authorized deposits and earnings. A raw balance-based `totalAssets`
  implementation would invalidate this assumption. Donation release/sweep is not implemented.
- Exits are priced only when backing is modeled as available and segregated. Shares burn and
  a fixed liability is reserved atomically. Reserved exits stop earning rewards and cannot be
  spent as shares. Payout can finish while new pricing is paused. Cancellation is not modeled.
- An exit request waiting for actual unstaking/bridging is NOT this reservation transition.
  The model now tracks liquid/staked locations and pending unstakes; cross-chain locations,
  partial unstake outcomes, queued user shares and authenticated payouts need later states.
- Expenses/losses consume only active assets. They cannot silently consume already-segregated
  reservations or pending deposits. Loss of those assets would require an explicit recovery or
  insolvency model; this prototype does not claim they are immune from real-world losses.
- Total loss halts pricing when shares remain. Recapitalization is undefined and rejected.
- Domain-bound event IDs replay idempotently only with the same payload. Duplicate operation
  IDs under new event IDs cannot accept/refund a deposit twice or pay an exit twice.
- Every transition returns a new state. Failures leave the original state unchanged.

## Conservation

In raw asset units:

`incoming = active + pending + reserved + quarantined + payouts + refunds + expenses + losses`

`active = liquid + staked`

Observed but unrealized rewards are excluded from incoming. Realization adds staked assets exactly once.
The sum of all spendable balances equals total outstanding shares. Pending-deposit and reserved-
exit totals must agree with their operation ledgers. Virtual offsets do not enter these balances.

Integer rounding may leave small amounts attributable to virtual offsets; a final shareholder
is not promised every raw asset unit. Production needs an explicit dust/end-of-life policy.

## Next engineering milestone

Prove current-runtime contract-owned root reward access, claim, unstake and controlled payout.
Then model real liquidity and authenticated cross-chain settlement before porting accounting to
contracts. The user's instruction to skip the personal wallet check on 22 October defers that
operator task; it does not mark the missing real-funds evidence as passed.

Tests cover adversarial scenarios and seeded state transitions. Passing them validates this
model's stated rules, not economic security or readiness for mainnet.
