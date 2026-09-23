# soltao Gateway Plan

Last updated: 2026-09-23

## Product promise

soltao is the Solana front door to Bittensor. A user should be able to start with canonical TAO in a Solana wallet, understand where it is going, stake it on Bittensor, track it, then unstake and bring canonical TAO back to the same Solana wallet.

Stake and unstake are launch requirements. Discovery, comparison, and portfolio views should support that journey instead of becoming a generic dashboard.

## Locked decisions

- Launch audience: users start from a Solana wallet.
- soltao derives a user-owned Bittensor coldkey and Bittensor EVM transit account from one wallet signature.
- Launch must support root staking and subnet staking.
- Exiting returns canonical TAO to the user's Solana wallet by default.
- If a subnet execution limit cannot be met, pause with funds unstaked on Bittensor and ask the user to approve a fresh quote or return to Solana.
- If the page closes mid-route, resume when the user returns by reading chain state and finishing remaining steps. No server gets authority to move funds while the user is absent.

## Milestone 1: protect the current stake route

Goal: keep the existing forward stake path safe while bridge-back is rebuilt.

Acceptance:

- Forward stake build passes.
- Existing forward route tests pass.
- No live UI can trigger the incomplete reverse route spike.
- Localhost cannot derive predictable mainnet-capable wallets without a real wallet signature.

## Milestone 2: root and subnet staking, honestly labeled

Status: implemented and covered by the route simulator, including resume from stake held on a
nonzero saved netuid. Additionally verified 23 Sep 2026 against real Bittensor mainnet state (zero
cost, no funds spent): `tools/stake/test/mainnet.test.mjs` replays the exact signed transactions
`route.js` produces through the real staking precompile at real subnet 1, staking to subnet 1's
real owner hotkey (independently confirmed live to be a registered delegate). Result: 0.1 TAO
converted to ~11.2 Alpha, owned by the fresh coldkey, with zero root-stake cross-contamination,
across 7 of 8 repeated runs (the one failure was an RPC rate-limit from our own repeated testing,
not a reverted transaction). Still not verified via an actual real signed transaction with real
funds through the live page — see `tools/stake/HANDOVER.md`.

Goal: make the current stake route clear for both root TAO and subnet Alpha.

Acceptance:

- Netuid is validated before a user can send.
- Resume uses the saved netuid.
- Review copy distinguishes root TAO from subnet Alpha.
- Final balance labels do not call Alpha "TAO".
- Subnet staking is covered by a simulation or controlled integration test before release.

## Milestone 3: bridge-back foundation

Status: in progress. The foundation now has independently checked OFT calldata, explicit rao/wei/Solana-local conversions, a live mainnet fee quote, a coldkey signer identity check, and live runtime-metadata guards for transfer and unstake. It is not connected to the page yet.

Goal: build return-to-Solana for free TAO first, then add unstake.

Acceptance:

- Derived coldkey mnemonic, transit key, and Solana destination are passed explicitly and tested.
- Amounts stay in one unit at each boundary: rao for Bittensor, wei for Bittensor EVM, local decimals for LayerZero OFT.
- The route quotes LayerZero return fees and shows the net return before any signature.
- The route transfers free TAO from coldkey to transit, wraps to wTAO, sends over LayerZero, and tracks arrival.
- Failure states leave funds in a named, recoverable account.

Evidence captured on 2026-09-23:

- A read-only live `quoteSend` for 1 TAO from canonical wTAO to Solana returned a 0.002859118 TAO native LayerZero fee.
- The return amount is floored to the OFT's six shared decimals; 1 rao maps to one 9-decimal Solana local unit after normalization.
- The Substrate signer produced from the derived phrase matches the coldkey produced by the page.
- Current runtime metadata orders unstake as `hotkey, netuid, amount`; the earlier reverse prototype had the last two arguments reversed and has been corrected.

## Milestone 4: unstake and return

Goal: fulfill the full promise for staked balances.

Acceptance:

- User chooses a known position: root hotkey or subnet hotkey/netuid.
- soltao shows free, staked, pending action, estimated fees, and expected returned TAO.
- Unstake uses the correct Bittensor authority and waits for the balance to become transferable.
- Page-close recovery resumes from every step.
- Full exit and partial exit are both deliberate choices.

## Milestone 5: gateway experience

Goal: make soltao feel like the place to enter Bittensor from Solana.

Acceptance:

- Subnet directory with search, netuid, name, price/liquidity/emissions/take fields, source timestamps, and clear unavailable states.
- Validator picker filtered by subnet, with take and basic status fields.
- Portfolio shows Solana TAO, Bittensor free TAO, root stake, subnet Alpha positions, and return actions.
- No hidden recommendations. If soltao ranks or filters, it explains the exact rule.

## Deferred

- Existing Bittensor wallet connection.
- Standing limit orders.
- Auto-compounding.
- Paid campaigns or featured subnets.
- Governance, crowdloans, leasing, and alerts.
