# Gateway proof runbook

Prepared 10 Oct 2026. These are pending operator runs, not completed tests. Follow the current
`tools/stake/HANDOVER.md` for production status. Keep Chutes off until its credited top-up is proven.

Read-only preflight on 11 Oct 2026: `npm run test:return:metadata` passed at block 9,259,338.
The live runtime accepts the expected Move, Claim, root-unstake and transfer call definitions;
the basket and swap simulation reads also answered. The observed root-claim minimum was
0.0005 TAO. Re-read the quote before a run; this check neither sends funds nor proves a payout.

### Supplied wallet checked on 11 Oct

Craig supplied `5Cvj3sq8RU2m6vFQmz2jFVix8sqBfWcuqyGKaCnMXyf9QG94`. This matches
`CONFIG.fee.bittensor`, the gateway's Bittensor fee recipient. Reads at finalized block 9,260,908
(`0x2f02d064f449bf78f5f6070a3b0d8d461c77bd0e384bac220ff2b6d3349d5cbe`), collected at
`2026-10-11T15:45:41Z`, returned:

- Free TAO: 0.008593908 (8,593,908 rao); reserved and frozen: zero.
- Nonce: 1.
- Stake positions: none.
- Root reward baskets: none.

Move and Claim are not ready on this address: there is no position to move and no reward to claim.
The check does not establish whether this address matches the wallet derived by the live page.
Next, obtain the public Bittensor address shown after signing in with the Solana wallet used for
the earlier stake. The page's action gate requires that derived address; a pasted public address
alone is only a lookup. Nothing was signed or sent during this check.

## First: Move, then Claim

Use the existing position in Craig's wallet on `https://soltao.xyz/stake/`. Choose the amount and
maximum acceptable total fee before confirming anything. Signing in derives the keys; confirming
an action authorizes the page to sign a Bittensor transaction. Do not expect a second Solana-wallet
transaction prompt for every Bittensor action.

No signature, mnemonic, private key, signed transaction bytes, or browser-storage export belongs
in this evidence document. Public transaction hashes and public addresses are sufficient.

### Same-subnet Move

1. Open holdings and record the public coldkey, origin hotkey, subnet, position amount and free TAO.
2. Pick a different checked validator on the same subnet. Record its hotkey and existing position.
   This exercises `move_stake`; cross-subnet `move_stake_limit` remains a separate proof gap.
3. Choose a small partial position amount in the displayed units: TAO on root or Alpha on a subnet.
   Review the soltao fee and network fee, paid from free TAO. Leave enough free TAO for both.
4. Confirm once. Record the extrinsic hash and block, its dispatch result, the batched fee transfer,
   and the origin and destination positions after it settles.
5. Reload, sign in with the same wallet and inspect holdings. Reconcile the original transaction
   before considering a retry. A pending or unknown result is not evidence that nothing was sent.

Pass: a successful dispatch, the intended position moved to the intended hotkey on the same subnet,
the expected fee paid once, and the refreshed page agrees with chain state. Record any emissions
between the before/after reads rather than treating every balance delta as the move amount.

### Root Claim

1. Use a root position with nonzero claimable rewards. Record the hotkey, root stake, estimated
   reward and free TAO. If no rewards are available, mark the run deferred.
2. Read both the soltao fee and network fee. Recommended test threshold: estimated reward exceeds
   five times their sum; this is an operator criterion, not a claim about an enforced UI rule.
3. Confirm once. Record the extrinsic hash, block, dispatch result and batched fee transfer.
4. Re-read root stake under the same hotkey and rewards, then reload and verify the same outcome.

Pass: a successful paid claim with root stake increasing under the selected validator, and the
expected fee paid once. Rewards are added to root stake, not to free TAO. A successful extrinsic
that pays nothing is not a successful payout proof; the application also checks for a stake increase.

## Remaining evidence

| Action | Evidence required | Current state |
|---|---|---|
| Same-subnet Move | Dispatch, origin/destination positions, fee, reload | Pending |
| Cross-subnet Move | `move_stake_limit`, actual output and limit result | Pending; not covered by a same-subnet run |
| Root Claim | Successful payout, root stake increase, fee, reload | Pending |
| Stake from holdings | Correct position increase, free TAO decrease, fee | Pending |
| Root unstake | Plain `removeStake`, root decrease and free TAO increase | Pending |
| First-time Solana TAO account return | Account absent before, created after, canonical TAO delivered and LayerZero delivery record | Pending |
| Chutes payment | Chutes-issued address, at least 0.01 TAO transferred, account credit actually posted | Pending; feature remains off |

Do not close a recipient token account to manufacture the first-time-account test. Use an intended
recipient with no existing canonical TAO account when that run is separately chosen.

## Evidence record

For each run, add a dated record with: action and exact path; served `stake.js` and `return.js`
hashes; public wallet/coldkey; hotkeys and subnet IDs; amount and units; quoted and actual fees;
before/after balances; transaction hash and block; dispatch/delivery result; reload result;
operator observation and any unresolved discrepancy.

Update the proof table in README and the handover only for the path actually demonstrated. Keep
the historical record of what had and had not been tested at submission time.

## Measurement boundaries

`npm run usage` measures successful Solana transactions containing the page's direct canonical OFT
send and its SOL fee transfer. It cannot establish Bittensor stake completion, return delivery,
retained users, or distinct people. Keep public-chain evidence separate from a voluntary pilot log
of visits, connection, funding, submission, completion, return and support incidents.

The reporter follows the documented [signature history](https://solana.com/docs/rpc/http/getsignaturesforaddress)
and [transaction](https://solana.com/docs/rpc/http/gettransaction) responses. Reaching an older
signature checks the requested time boundary; it does not prove that an RPC provider has no gaps
inside its history. Important partner claims should also be reconciled against known transaction
hashes and destination-chain evidence.
