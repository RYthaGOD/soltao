# soltao Gateway Plan

Last updated: 2026-09-24

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

Status: done, deployed to production 23 Sep 2026. The predictable-localhost-wallet bypass was
removed from `app.js`; the bridge-back scaffold (direction toggle) ships in the same page but is
disabled in HTML and hard-gated in JS, confirmed inert on the live domain post-deploy.

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
not a reverted transaction). Deployed to production 23 Sep 2026 on Craig's explicit go-ahead, on
the strength of that verification plus the root-staking route's prior real-funds confirmation.
Still not verified via an actual real signed transaction with real funds through the live page —
see `tools/stake/HANDOVER.md` for the exact current gap.

Goal: make the current stake route clear for both root TAO and subnet Alpha.

Acceptance:

- Netuid is validated before a user can send.
- Resume uses the saved netuid.
- Review copy distinguishes root TAO from subnet Alpha.
- Final balance labels do not call Alpha "TAO".
- Subnet staking is covered by a simulation or controlled integration test before release.

## Milestone 3: bridge-back foundation

Status: return engine implemented behind the disabled production UI. It has independently checked OFT calldata, explicit rao/wei/Solana-local conversions, a live mainnet fee quote, a coldkey signer identity check, live runtime-metadata guards, resumable funding/wrap/send checkpoints, and a zero-cost replay through the real canonical wTAO and LayerZero contracts. It is not connected to the page yet.

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
- `return_route.js` completes free-TAO funding, wrapping, final fee re-quoting, top-ups, and canonical OFT send while checkpointing the EVM transaction hash immediately after broadcast.
- Recovery tests cover interruptions after coldkey funding, after wrapping, after OFT broadcast, and while the OFT transaction is pending; none duplicates a transfer, wrap, or send.
- A read-only mainnet-state replay wrapped 1 TAO through the real wTAO contract and executed its real LayerZero send toward Solana. It measured 59,827 total gas for wrap and 246,363 for send, inside the configured 75,000 and 650,000 limits, with zero wTAO left behind.

Remaining before the toggle can be enabled:

- Persist the route checkpoints from the browser and render the free-return review/tracker states.
- Track the destination Solana token account and prove arrival, including first-time token-account behavior.
- Keep the Polkadot signer in a separately loaded return bundle so the current forward page does not absorb its size.
- Complete one deliberately small real-funds free-TAO return after explicit approval.

## Milestone 4: unstake and return

Goal: fulfill the full promise for staked balances.

Acceptance:

- User chooses a known position: root hotkey or subnet hotkey/netuid.
- soltao shows free, staked, pending action, estimated fees, and expected returned TAO.
- Unstake uses the correct Bittensor authority and waits for the balance to become transferable.
- Page-close recovery resumes from every step.
- Full exit and partial exit are both deliberate choices.

## Milestone 5: gateway experience

Status: not started. Data sources for the subnet directory and validator picker were researched on
24 Sep 2026 — see `research/subnet-validator-data-research.md` for what taostats can and cannot
supply, what the Bittensor metagraph precompile supplies for free, and the measured cost of each.

Goal: make soltao feel like the place to enter Bittensor from Solana.

Acceptance:

- Subnet directory with search, netuid, name, price/liquidity/emissions/take fields, source timestamps, and clear unavailable states.
- Validator picker filtered by subnet, with take and basic status fields.
- Portfolio shows Solana TAO, Bittensor free TAO, root stake, subnet Alpha positions, and return actions.
- No hidden recommendations. If soltao ranks or filters, it explains the exact rule.

Known prerequisite, ahead of any picker: the live hotkey check is subnet-blind. `onHotkey()` uses
`getDelegate(hotkey)`, which takes no netuid, so a hotkey that validates nowhere on the chosen
subnet still passes as a "registered validator". Confirmed against mainnet on 24 Sep 2026; details
and the zero-cost way to settle the remaining unknown are in the research note above.

## Deferred

- Existing Bittensor wallet connection.
- Standing limit orders.
- Auto-compounding.
- Paid campaigns or featured subnets.
- Governance, crowdloans, leasing, and alerts.
