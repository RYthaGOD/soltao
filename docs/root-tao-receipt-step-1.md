# Root TAO receipt: step 1 — product boundary and proof gates

Date: 22 October 2026. Status: design baseline for review, not implementation approval or
evidence of a working vault. Working name: **Root TAO receipt**; ticker and branding undecided.

Build update: the user subsequently instructed “skip this and lets build.” Personal wallet
readiness is deferred. An offline accounting prototype now lives in `tools/stake/vault/` with
`npm run test:vault`. This authorizes moving accounting work ahead of the earlier investigation
order; contract capability and real-funds release proof remain unproven. Gate D is partially
implemented (pure accounting); real bridge, valuation reconciliation and liquidity states remain.

## Product promise

A user deposits canonical Solana TAO and, after confirmed settlement, receives transferable
Solana shares representing a proportional claim on a root-staked TAO vault. Redemption returns
canonical Solana TAO after the underlying withdrawal and bridge steps complete. A receipt
holder does not need to stake the receipt again to participate in the vault's net returns.

Shares have a variable TAO redemption value. No fixed APY, guaranteed principal, guaranteed
instant redemption or guaranteed secondary-market peg is promised. A displayed share value
is distinct from the price a buyer might pay on a DEX.

This is a separate product from the current gateway: existing user coldkeys remain user-owned;
their freely withdrawable positions cannot back fungible vault shares. No migration of existing
holdings is implied. Do not extend the gateway's current custody claims to this vault.

## First prototype scope

| Item | Baseline |
|---|---|
| Deposit and withdrawal asset | Existing canonical TAO mint; exact identity checked at integration |
| Strategy | Root staking only; no deliberate subnet alpha allocation or leverage |
| Receipt | Transferable, non-rebasing shares; supply changes on deposits/redemptions |
| Yield | Net realized staking rewards; losses and expenses may reduce share value |
| Exit | Asynchronous request and settlement; transaction progress remains recoverable |
| Prototype funds | Simulated or test funds only |
| Fees | Explicit inputs to the accounting model; production schedule undecided |
| Liquidity | No promised DEX listing, lending integration or instant exit reserve |
| Token launch | Deferred; no mint, sale or mainnet deployment in step 1 |

Root staking still depends on validator rewards, network rules and reward realization. Root-only
does not mean the underlying reward system is free of alpha-basket exposure or execution costs.

## Candidate architecture, subject to proof

Prefer evaluating a **contract-controlled Bittensor EVM vault** with one authoritative share
ledger, with its shares represented on Solana through an authenticated bridge. Compare reusing
existing vault/share standards with custom logic before selecting implementation dependencies.
Do not treat a Solana PDA as able to control a Bittensor coldkey directly.

Solana escrow and any local mint authority must be program-controlled. Bittensor vault custody
must be enforced by its own contract and proven withdrawal permissions. Relayers should only
carry authenticated messages, never have discretionary authority to mint shares or transfer
backing. If a multisig, attestor or upgrade authority can change those guarantees, enumerate that
power and disclose it. Calling a design contract-controlled is not proof it is trustless.

The historical gateway replay uses state-override code at a transit address. It is useful evidence
of individual call behavior, but it does not establish a deployable vault's complete deposit,
claim, unstake and redemption lifecycle. A Staking proxy on a user-owned coldkey does not solve
fungible backing: the owner can still withdraw the assets independently.

LayerZero's OVault documentation provides an architectural reference for cross-chain assets and
shares. It is not proof that the existing TAO OFT supports arbitrary composition, that new peers
can be added without permission, or that all needed calls work from a Bittensor EVM contract.
Those capabilities are explicit gates below. A supported existing asset transfer plus separate
authenticated orchestration may be necessary.

## Accounting requirements before program code

Use exact integer amounts with explicit decimal conversion and conservative rounding. Separate
ownership, asset location, message state and share supply; a balance read alone is not a deposit
receipt. Supply accounting must include shares escrowed or in transit without counting a locked
origin token and its remote representation twice.

Define the share price from the assets attributable to outstanding shares after liabilities and
accrued expenses. Track pending deposit assets, active backing, reserved withdrawal assets,
paid-out assets and operator-funded gas separately. Each asset belongs to exactly one accounting
category at a given state; pending deposits do not enrich existing shares before their issuance.

For an accepted deposit, calculate shares using pre-deposit backing and supply; round issuance
down and enforce the user's minimum shares. Define a protected bootstrap separately, including
donation/inflation defenses and the nonzero-assets/zero-supply case. Reject dust deposits that
would issue zero shares. Do not implement the bootstrap as an unprotected special-case 1:1 mint.

For redemption, specify exactly when shares stop participating in returns and how the payout is
priced. Either keep escrowed shares in the economic supply until settlement, or burn them while
creating and reserving an explicitly priced withdrawal liability. Never mix those treatments.
Refunding or cancelling a request must not restore shares after its payout has succeeded.

Unclaimed rewards need special care: ignoring rewards until claim can let a new depositor buy
into earnings that predate their deposit. Before admitting a deposit or pricing an exit, either
realize those rewards, or use a verified and conservative valuation with a defined reconciliation
rule. If neither is possible, pause pricing. The claim threshold must not create a free option
for incoming depositors. The next math milestone must select and test one policy.

## Required failure behavior

- Every deposit, share delivery and redemption has a unique domain-bound operation ID.
  Duplicate, reordered, delayed and replayed messages cannot duplicate an economic action.
- Confirmed asset arrival does not by itself permit arbitrary share issuance. The authenticated
  operation must establish the depositor, recipient, amount, route and minimum output.
- A timeout means unresolved until reconciled. It does not authorize both refund and completion.
- Shares are not spendable while reserved for exit. Pending exits remain visible across reloads.
- Stale or inconsistent backing evidence stops price-sensitive deposits and redemptions; it
  does not justify an invented exchange rate. Record the reason and recovery path.
- Pausing new deposits must not casually disable already-funded payout recovery. Define separate
  scopes for deposit pause, strategy pause and unsafe settlement halt, and test each.

## Proof gates and order

| Gate | Evidence required | Current status |
|---|---|---|
| A — existing gateway | User-operated Move and paid Root Claim evidence under the existing runbook | Pending; public derived coldkey requested |
| B — vault authority | Current-runtime read-only replay of contract-owned root deposit, rewards access, claim, unstake and controlled payout; negative authorization cases | Not established |
| C — cross-chain capability | Exact TAO asset route, supported message/composition paths, peer/authority requirements, supply model and recoverable failed delivery | Not established |
| D — accounting model | Pure offline model with bootstrap, donations, old rewards, fees, losses, dust, partial failure, duplicates, exits and conservation tests | Not started |
| E — test deployment | End-to-end test funds, authority inventory, operational recovery and independent security review | Not started |
| F — public release | Gateway proof, demand/volume evidence required by project plan, audited implementation, reviewed disclosures and fresh explicit launch authorization | Not authorized |

Preparation and read-only investigation may continue while Gate A awaits the user's wallet.
The first engineering investigation is Gate B, not token creation. If the contract cannot safely
claim and release its backing, stop this architecture and revisit it before writing share code.
Even a successful Gate B does not satisfy the cross-chain or accounting gates.

The existing gateway plan's restriction on new live features and earlier research's deferral of
pooled vaults remain release constraints. The user's new direction authorizes stepwise design
and investigation, not spending funds, choosing custody operators or launching a token.

## Step 1 completion and immediate next action

Step 1 is complete when this product boundary, candidate control model and unresolved proof gates
are recorded. They are recorded here. They remain design proposals; no security or economic
guarantee is inferred from writing them down.

Next: use the public coldkey shown by the live gateway to perform a read-only readiness check for
the existing Move/Claim runbook. Never request a recovery phrase, signature or private key. In
parallel with that user-dependent gate, inspect current runtime interfaces for the Gate B calls;
do not broaden the first investigation into a token launch or full vault implementation.

## References and evidence limits

- [Gateway release sequence](gateway-plan.md) and [wallet proof runbook](gateway-proof-runbook.md).
- [Historical vault research](vault-research-2026-09-28.md): explicitly historical; fee estimates,
  permissions and runtime behavior must be rechecked.
- `tools/stake/test/Replay.sol` and `tools/stake/test/mainnet.test.mjs`: simulation evidence,
  not deployed vault contracts or real-funds proof.
- [LayerZero OVault reference](https://docs.layerzero.network/v2/developers/evm/ovault/overview),
  checked 22 October 2026: reusable architecture candidate; compatibility unproven.
- [Bittensor eTAO guide](https://www.bittensor.com/docs/guides/etao), checked 22 October 2026:
  emission rules, not a receipt-token standard or a guarantee of vault returns.
