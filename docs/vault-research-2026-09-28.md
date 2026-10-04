# Managed staking strategy: research

28 Sep 2026. Research for a possible second soltao product: bring Bittensor staking yield to Solana users, with soltao taking a cut of the revenue (the token buyback was dropped on 27 Sep). The hackathon entry stays on staking until 12 Oct. The build plan is at the end.

Every figure comes from chain state, from a script in `tools/stake/`, or from a cited page:
- `yield_research.mjs`: 30- and 90-day returns per validator.
- `backtest_research.mjs`: monthly backtest with no look-ahead. It caches reads in `.research-cache.json`.
- `test/mainnet.test.mjs`: the zero-cost replay.

All of them are read-only. Chain figures were read at block ~9,160,460 (27–28 Sep 2026, runtime spec 470).

## Short answers

| Question | Answer |
|---|---|
| Is there yield beyond root? | Yes, but it's price risk. Every top subnet pays 25–45% a year **in alpha**, but alpha moved −27% to +326% against TAO over 90 days. Root pays 3.7–6.0% a year **in TAO**. |
| Is there an edge that doesn't depend on price calls? | Yes: **validator choice**. See the backtest section. Many permitted validators on the top subnets paid stakers **nothing** over a month. |
| Can it be done without custody? | Yes. Bittensor has a **`Staking` proxy** type. A user can let soltao rebalance their stake, and the chain itself forbids that proxy from moving funds to another wallet. Stakao already runs this model. |
| Can a contract hold stake (for a pooled vault later)? | Yes. The staking precompile stakes as the calling contract's own mapped coldkey. Proven again today by the zero-cost replay: 29/29 checks pass. |
| Competitors? | Stakao (proxy-based, subscription). Tensorplex stTAO is **deprecated**. Exchanges offer custodial staking at about 4.7%. Nothing Solana-native found. |
| Demand? | Open. One question for TensorFlow, below. |

## 1. How emissions reach a staker (from chain state)

What each top subnet emits, read live on 28 Sep:

- **Every one of the top 10 subnets emits exactly 1.0 alpha per block** (`SubnetAlphaOutEmission`, tempo 360 blocks, so paid out every ~72 min). Alpha emission isn't where subnets differ. Their prices are, so the TAO value of the emissions ranges from 150 to 650 TAO a day (`SubnetAlphaOutEmission × SubnetTAO / SubnetAlphaIn × 7,200`).
- **The split of that 1 alpha:**
  - The subnet owner takes 18% (`SubnetOwnerCut` = 0.18).
  - The remaining 82% is split between miners (41%) and validators with their stakers (41%).
  - The validator share is shared with root stakers by `RootProp`, and root's part goes into each root validator's basket.
  - Each validator keeps its take (at most 18%) and the rest grows its share pool.
- **Rule of thumb for a subnet staker's yield in alpha:** `0.41 × 7,200 × 365 / SubnetAlphaOut`. With 2.7M–5.0M alpha outstanding, that's about 21–40% a year. Against the measured 28 Aug → 27 Sep returns of each subnet's largest validator, this simple formula was within ~15% on 8 of 10 subnets (subnet 44 was off by 17%, subnet 8 by 29%). It ignores root's cut and take, which lower the yield, and zero-paying validators, which concentrate dividends on the rest. Treat it as a guide, not a model. Measured share growth is the ground truth.
- **TAO also flows into pools** (`SubnetTaoInEmission`, about 0.003–0.013 TAO per block per subnet), which supports alpha prices. `SubnetTaoFlow` (net staking in minus out) was negative on 7 of the 10. Emission weighting now uses an EMA of price with an emission gate (`EmissionGateBar`), so subnets with falling demand lose emission share over time.
- **What a staker actually earns in TAO** = share-value growth × change in alpha price. Measure the first from `TotalHotkeyAlpha / TotalHotkeySharesV2` (older blocks: `TotalHotkeyShares`, U64F64). Measure the second from `SubnetTAO / SubnetAlphaIn`. Skip windows where `AlphaSharePoolEpoch` changed, because the pool was reset.
- **Root:** root stake itself never grows. Dividends go into the validator's **beta basket**, a fund of subnet alpha that the staker claims as TAO restaked on root. `BasketTwr` is the chain's own staker return index. It started about 30 days ago.

Measured 90-day returns (29 Jun → 27 Sep) are in the table in section 2.

## 2. Returns, and a backtest with no look-ahead

**Root:** the top 8 root validators paid 0.30–0.48% over 30 days, 3.7–6.0% a year in TAO (`BasketTwr`). That agrees with Kraken (about 4.69%) and Staking Rewards (about 4.90%).

**The top 12 subnets over 90 days** (from `yield_research.mjs`, largest-stake validator on each):

| Subnet | Emissions only, 90 days (APY in alpha) | Alpha price vs TAO | Return in TAO |
|---|---|---|---|
| 64 Chutes | 8.4% (39%) | −8.9% | −1.3% |
| 51 Lium | 8.7% (40%) | +68% | +83% |
| 4 Targon | 7.1% (32%) | +0.7% | +7.9% |
| 8 Vanta | 12.1% (59%) | −4.1% | +7.5% |
| 3 Teutonic | 9.7–12.6% | +33% | +46–50% |
| 120 Affine | 8.6–10.7% | −16% | −7 to −9% |
| 44 Score | 8.0% | −14% | −7.1% |
| 9 Iota | 9.3% | −27% | −20.5% |
| 56 | 10.2–15.4% | −15% | −6.1 to −1.7% |
| 68 Nova | 9.1% | −3.4% | +5.3% |
| 53 Engy | 5.4–7.0% | +326% | +349% |
| 34 | 10.4–12.0% | −6.0% | +3.9 to +5.3% |

The median return was about +5% in TAO over 90 days, and 5 of the 12 lost TAO. This list is today's top subnets, so it's biased toward winners.

**Monthly backtest** (`backtest_research.mjs`). At the start of each 30-day window it picks, using only data available then:
- the top 10 subnets by TAO in the pool;
- on each of those subnets, the permitted validators with at least 1,000 alpha;
- and then compares three validator choices:
  - the **picker**: best trailing 30-day share growth;
  - the **largest** validator;
  - the **median** validator.

Portfolio rules compared, in TAO:
- (a) root only;
- (b) root plus the picker on the top 3 subnets by TAO-value of emissions;
- (c) as (b), but keeping only subnets whose alpha price rose over the trailing 30 days;
- (d) equal weight across all 10.

This covers four monthly windows, 30 May → 27 Sep 2026. The archive node's rate limit stopped the run before windows 5 and 6. The reads are cached, so a later run picks up where it stopped.

**Validator choice, alpha earned per month:**

| Window | Picker | Largest | Median | Picker beat largest | Validators that paid 0 |
|---|---|---|---|---|---|
| 28 Aug → 27 Sep | 3.19% | 2.74% | 2.30% | 7/10 | 19 |
| 29 Jul → 28 Aug | 2.94% | 2.49% | 2.64% | 5/10 | 12 |
| 29 Jun → 29 Jul | 3.91% | 2.52% | 3.10% | 9/10 | 10 |
| 30 May → 29 Jun | 3.75% | 2.91% | 3.20% | 9/10 | 13 |
| **Average** | **3.45%** | **2.67%** | **2.81%** | **30/40** | **about 13 a month** |

Over a year that compounds to about **50% in alpha for the picker vs about 37% for the largest validator**. The rule is simple: move to whoever grew fastest last month, using a same-subnet `move_stake` that costs 0.00037 TAO and needs no swap. It won three months in four, and about 13 permitted validators a month across the top 10 subnets paid their stakers nothing.

**Portfolio rules, return in TAO per window:**

| Window | (a) Root | (b) Top 3 subnets | (c) Top 3 with momentum | (d) All 10 equal |
|---|---|---|---|---|
| 28 Aug → 27 Sep | +0.41% | +1.28% | +12.82% (subnet 51 only) | −0.81% |
| 29 Jul → 28 Aug | n/a* | +10.41% | +10.41% | +5.37% |
| 29 Jun → 29 Jul | n/a* | +13.01% | +17.03% | +5.20% |
| 30 May → 29 Jun | n/a* | +1.28% | 0% (nothing kept) | +2.04% |
| **4 months, compounded** | about +1.6%† | **+28%** | +46% | +12% |

\* Root's basket return index (`BasketTwr`) only started in September. †Estimated at root's measured ~0.4% a month.

"Top 3 by TAO-value of emissions" works out to the top 3 by alpha price, because every top subnet emits the same 1 alpha per block.

**How to read this honestly:**
- Four months is a small sample, and the middle of 2026 was good for alpha.
- The momentum rule's +46% comes mostly from being concentrated in subnet 51 while it rallied. That's luck as much as skill.
- The 90-day table above shows the downside: 5 of 12 subnets lost TAO.
- What holds up in every window is the validator edge (30/40), not the subnet call.

**Recommendation:**
1. Build validator selection first. It's the smallest-risk, clearest-evidence improvement.
2. Offer subnet exposure only as a labelled, opt-in "higher risk" choice, with root as the default.
3. Re-run the backtest monthly as more history exists.

## 3. Moving stake: the mechanics

Read from runtime metadata (spec 470). Fees are `paymentInfo` estimates, 28 Sep 2026. Nothing was signed.

| Call | What it does | Pool swap? | Network fee |
|---|---|---|---|
| `add_stake_limit(hotkey, netuid, amount, limit_price, allow_partial)` | TAO → alpha on a validator, with a price limit | yes | 0.00085 TAO |
| `remove_stake_limit(...)` | alpha → free TAO | yes | 0.00065 TAO |
| `move_stake(from_hotkey, to_hotkey, netuid, netuid, amount)` | **switch validator on the same subnet** | **no** | **0.00037 TAO** |
| `move_stake_limit(...)` / `swap_stake_limit(...)` | move between subnets (alpha → TAO → alpha), with a ratio limit | yes, both legs | 0.00105 TAO (`swap_stake`) |
| `claim_root_with_hotkey(hotkey)` | redeem root basket rewards, restaked on root | sells alpha | **0.00825 TAO** |
| `stake_into_basket(hotkey, amount)` | buy a root validator's basket directly | yes, pro rata | 0.00537 TAO |
| `set_coldkey_auto_stake_hotkey(netuid, hotkey)` | where future rewards auto-stake | no | – |

Other things that matter:
- **The pool swap fee is 0.05%** (`Swap.FeeRate` = 33/65,535). The top pools hold 35k–200k TAO, so slippage on 10 TAO is about 0.01–0.06%.
- **Switching validator on the same subnet is almost free**: 0.00037 TAO, no swap and no price risk. That's the cheapest thing a strategy can do, and the one the backtest says is worth doing.
- **Minimums:** `NominatorMinRequiredStake` is 0.01 TAO (soltao uses 0.02).
- **`RootStakeUnlockInterval` is 0**, so there's no hold on root unstaking today, but governance can switch it on.
- **Validators can change take at most once per 216,000 blocks (about 30 days).**
- **Root claims:** one claim costs about 0.00825 TAO. At 5% a year, that's worth doing only above roughly 1 TAO staked per validator per claim every two months. **Batch claims when accrued rewards are more than 5× the fee.**
- **Root basket trading is live** (`BasketTradingEnabled = true`). Validators rebalance their root basket within guardrails: 2% price bands, a turnover cap, and concentration and liquidity caps. So a root staker already holds a managed alpha fund, and `stake_into_basket` lets anyone buy into one directly. **A soltao strategy has to beat that, or use it.**

## 4. Custody: how a managed strategy can run without custody

**The `Staking` proxy.** Bittensor's proxy pallet has these types: `Any, Owner, NonCritical, NonTransfer, Senate, NonFungible, Triumvirate, Governance, Staking, Registration, Transfer, SmallTransfer, RootWeights, ChildKeys, SudoUncheckedSetCode, SwapHotkey, SubnetLeaseBeneficiary, RootClaim, BasketTrading`.

In subtensor's source (`runtime/src/proxy_filters/`, `main` at `c004cebf3`, 24 Sep 2026; still to confirm against the deployed spec 470):
- **`Staking` allows** `add_stake(_limit)`, `remove_stake(_limit/_full_limit)`, `unstake_all(_alpha)`, `move_stake(_limit)`, `swap_stake(_limit)`, `stake_into_basket`, `add_collateral`, `set_min_collateral`.
- **`Staking` does not allow** `transfer_stake` or `transfer_stake_and_hotkey`, which are in a separate `StakeTransferCalls` group. It also doesn't allow balance transfers.
- **`RootClaim`** is a separate proxy type, so soltao could claim root rewards on a user's behalf and nothing more.

So a user's coldkey (derived in the browser, as today) can sign `proxy.add_proxy(soltao_key, Staking, 0)` once. After that, soltao's server can rebalance their stake on schedule, but it can never send their TAO or stake to another wallet. Proxy deposit: 0.06 + 0.033 TAO, refundable when the proxy is removed. Revocable at any time with `remove_proxy`.

**The risk the proxy leaves:** a stolen soltao proxy key can't take funds, but it could cause losses:
- swapping stake into a thin pool and front-running it;
- moving stake to a validator paying nothing.

Take is capped, but not at zero pay. Mitigations:
- use `*_limit` calls only;
- keep an allowlist of subnets and validators, with a per-day turnover cap;
- use `proxy.announce` with a delay (the pallet supports announced proxies, so the user has time to veto);
- keep the soltao key in a hardware or KMS signer.

Other options, for comparison:
- **User signs every move** (no proxy): the safest, but not "managed". A good first release.
- **Pooled vault contract on Bittensor EVM:** possible. The replay shows a contract calling the staking precompile stakes as its own mapped coldkey (Transit contract in `test/Replay.sol`, 29/29 checks passed on 28 Sep). It needs Solidity, a share token bridged to Solana, an audit and a legal review. Not before real volume.
- **soltao holds the keys:** ruled out.

## 5. Competitors

- **Stakao** ([stakao.com](https://stakao.com/bittensor-staking)): non-custodial, "a staking-only proxy permission that cannot transfer funds. Revoke anytime." Free plan (Smart DCA) and Premium at €19 a month or €168 a year. "Does not take a cut of your staking rewards." Strategies: Smart DCA, AI Agent, Quant Core, market-cap baskets, thematic. Validator checks and rebalancing every 4 hours. TVL and user numbers aren't disclosed. **This is the direct model to learn from.** soltao's difference would be starting from a Solana wallet with no Bittensor wallet setup.
- **Tensorplex stTAO:** "Tensorplex Stake and the tTAO Bridge have been deprecated"; users are pointed to Backprop Finance ([stake.tensorplex.ai](https://stake.tensorplex.ai/)).
- **Exchanges:** Kraken (about 4.69%) and Coinbase, custodial root-style staking.
- **Data:** [taostats yield](https://taostats.io/yield), [Tao Yield](https://www.taoyield.com/).
- **TaoFi** (starts from Base), **VoidAI** (wraps TAO and alpha).
- **Solana:** Colosseum Copilot shows Solana vault designs (`stake2yield-vaults`, `receipt-money`, Breakout Apr 2025) but nothing connected to Bittensor. As of 28 Sep 2026, nothing found that brings Bittensor staking yield to Solana. Absence of evidence, not proof.

**Pricing:** Stakao's subscription with no cut is the benchmark users will compare against. A small fee per rebalance, or a performance fee, needs to beat "€0 on the free plan".

## 6. Demand (open)

The question for TensorFlow, once there's trust: *"If I built it, would you want your stake managed for you (validator picking, claiming rewards) through a permission that can't move your funds? Would you stay on root, or want some subnet exposure?"*

## 7. Legal shape (not legal advice)

The proxy model is software: the user's own wallet, following a strategy they chose and can revoke. A pooled vault that shares returns is closer to a fund, so get legal advice before building one.

## 8. The build plan

**Phase 0, now: research.** Done except demand.

**Phase 1, after 12 Oct: validator hygiene in the holdings view.** The smallest useful release, with no new custody.
- `src/strategy.js` (new, pure, unit-tested) scores each position's validator on trailing 30-day share growth from `TotalHotkeyAlpha / TotalHotkeySharesV2`. It flags zero-paying validators and those below the median.
- The holdings view offers "Switch to a better validator on this subnet": a `move_stake` on the same netuid, costing 0.00037 TAO with no swap. The user signs it through the existing `stake_moves.js` / `settle.js` path, with the dispatch-event verdict.
- Root: "Claim rewards" is only offered once rewards are more than 5× the claim fee.

**Phase 2: managed mode through the `Staking` proxy.**
- A one-time `add_proxy(soltao, Staking, delay)` signed by the user's coldkey, with the deposit shown.
- A small soltao service (a separate process, key in a KMS) runs the Phase 1 rules on a schedule for opted-in coldkeys: validator switches, and batched root claims (with a separate `RootClaim` proxy if wanted).
- Guardrails: `*_limit` calls only, allowlists, a turnover cap, announced proxy calls, and an on-page activity log read from chain events.
- Revenue: a fee per executed move, or a small performance fee on claimed rewards. Taking a fee needs a separate transfer the proxy cannot make, so fees are paid by the user's own signature (for example, prepaid credits in the Solana route) or by the `NonTransfer` proxy (which to check). **Open design question.**

**Phase 3, optional: subnet allocation.** Only if the backtest shows a subnet rule beating root after costs. Users choose between "root only" and "root plus top-N".

**Phase 4, maybe: a pooled vault contract.** Only with volume, an audit and legal sign-off.

Before any of this goes live:
- One small real-funds `move_stake` and one proxy add/remove, with Craig's approval.
- `npm test`, the page test, and `npm run test:live`.
