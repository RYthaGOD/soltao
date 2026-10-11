# soltao audit and next direction

Date: 2026-10-10  
Scope: post-Colosseum technical audit, product audit, and next-direction strategy.  
Skills used: `review-and-iterate` and `colosseum-copilot`.

## Executive verdict

soltao is in a good position, but the shape is narrower than "TAO DeFi on Solana" today.

The proven product is a self-custody TAO gateway: canonical Solana TAO -> Bittensor native stake -> return to Solana, with no soltao contract and no server. That is valuable because TAO on Solana is young, thinly integrated, and not natively useful beyond holding/trading.

The next product should not be a broad vault, LST, or generic DeFi dashboard yet. The next credible step is:

1. make the gateway boringly trustworthy;
2. prove service payments with one live Chutes top-up;
3. add non-custodial validator hygiene for existing positions;
4. run a small partner/user pilot;
5. only then decide whether a vault, receipt token, or managed strategy is justified.

In short: own "TAO enters Bittensor from Solana" before trying to own "TAO DeFi on Solana."

## What is strong

- The architecture is unusually clean for a hackathon build. The README states that `/stake/` has no soltao contract and no server: the browser derives the Bittensor coldkey and transit key from the user's Solana signature and executes the route client-side.
- The trust model is explicit. `tools/stake/src/derive.js` freezes the SIWS domain/URI and derives independent coldkey and transit keys with separate HKDF salts.
- The route is resumable from chain state. `tools/stake/src/pending.js` seals saved route and return records with a MAC keyed from the transit key, so edited localStorage is not trusted.
- The Bittensor half refuses to trap funds in the transit account. If staking is rejected, `tools/stake/src/route.js` delivers funds unstaked to the user's coldkey instead.
- The test suite is broad for a client-side bridge/staking route. `npm test` passed on 2026-10-10, including derivation, return recovery, stake moves, payment batching, subnet validation, pending-state sealing, confirm logic, CSP/RPC checks, and a mainnet Solana transaction simulation.
- The live route mostly verifies. `npm run test:live` confirmed the deployed `stake.js?v=b6c4271f` matches the local build, CSP permits the configured RPCs, mirrors redirect to the canonical domain, and `/stake/?netuid=64` renders without console or CSP errors.

## Current grades

| Area | Grade | Why |
|---|---:|---|
| Security model | B+ | Strong self-custody design, strict CSP posture, sealed local state. Still highly dependent on users signing exactly the soltao SIWS message and on the served script staying clean. |
| Correctness | B+ | The core route, return, and stake-move state machines are well tested. Real-funds proof still lags live buttons. |
| Testing | A- | Local suite passed. Live suite found stale history, not a funds-safety regression. |
| Product clarity | B- | "Stake TAO from Solana" is clear. "Enable TAO DeFi on Solana" is still a thesis. |
| Partner readiness | C+ | Good proof pack, but stale data, unproven buttons, token-conflict optics, and thin recent usage block a serious cohort. |
| Overall | B | The engineering is ahead of distribution. That is a better problem than the reverse, but it is the problem now. |

## Findings

### High: partner-cohort readiness is not there yet

The repo says this plainly: Move, Claim, staking more from holdings, root unstake, Chutes, and first-time Solana token-account arrival still lack real-funds proof. The handover explicitly says the next step is one small real-funds Move and Claim, not a new feature.

Fix:
- Run one controlled real-funds Move.
- Run one controlled real-funds Claim when rewards are available and fee economics make sense.
- Run one root unstake.
- Observe one first-time TAO ATA return, or keep it labeled as inferred.
- Keep Chutes off until one live credited top-up is done.

### High: live subnet history is stale

Resolved 10 Oct 2026: refreshed, deployed and checked live; details in the follow-up below.

`npm run test:live` failed one check:

`the daily history is served, complete and under 3 days old - 3.9 days old`

Local `stake/history/index.json` was generated at `2026-10-06T16:49:47.598Z`. This is not a funds-safety issue, but it weakens the "front door to Bittensor" claim because the page is now showing stale subnet history.

Fix:
- Run `cd tools/stake && npm run history`.
- Run `npm run build`, `npm test`, and `npm run test:live`.
- Deploy only after explicit approval.

### High: the services thesis is still switched off

The strongest version of soltao is not just "stake TAO." It is "Solana wallets can pay for Bittensor services." But the Chutes top-up remains `chutesLive: false`, and the README/HANDOVER both say it needs one credited real-funds run.

Fix:
- Top up Craig's own Chutes account with a small amount from the live page.
- Confirm Chutes credits it.
- Then decide whether to flip `chutesLive` and pitch Chutes as the first service integration.

### Medium: the $SOLTAO discount creates trust drag

The disclosure is handled honestly, but the product now has a commercial reason to hold the builder's separate token. That is a tax on trust, especially for partners. The route does not require the token, but the discount makes the token part of the product story again.

Fix options:
- Best for partner trust: park the holder discount until after the first partner cohort.
- Minimum: keep the disclosure, but separate product socials and partner outreach from coin socials.

### Medium: demand has not visibly rebounded

The full usage script hung against the default Solana RPC during this audit. A narrower PublicNode slice was valid only for recent history and found:

- since `2026-10-09T12:00:00Z`: 40 fee-wallet transactions checked, 0 stake routes.

This does not prove no routes since 6 Oct, because PublicNode lacks the full history needed for that range. It does show no very recent route rebound.

Fix:
- Use a reliable archival RPC for `npm run usage`.
- Add a privacy-preserving pilot tracker before partner outreach. At minimum: invited, visited, connected, funded, submitted, confirmed, returned, support incident.

### Medium: dependency hygiene is good enough for now, but docs should prefer `npm ci`

Build verification already uses `npm ci`, but README test/setup snippets still say `npm install`. Because a few dependencies use caret ranges in `tools/stake/package.json`, `npm ci` is the reproducible command people should copy.

Fix:
- Change README test/setup commands to `npm ci`.
- Keep the lockfile as the source of dependency truth.

## Colosseum Copilot landscape

Token verified: authenticated through `2026-12-14`.

Project search did not find close Bittensor/TAO/Solana competitors. Similarity scores were low:

| Query | Top adjacent matches | Read |
|---|---|---|
| `Bittensor TAO staking from Solana wallet` | Stakes, NAMEDAO, Kalyna Wallet, Stakery | Generic staking/wallet adjacency, no exact TAO gateway. |
| `TAO DeFi on Solana Bittensor` | defi REIT, Allora finance, Guradianfi, DeFiSphere | Generic DeFi matches, not Bittensor-specific. |
| `Solana DeFi vault staking yield Bittensor` | STRATOS DEFI POD, SYT, ABS Finance, Stake2Yield-style projects | The yield/vault category is crowded, but not around TAO/Bittensor. |

Winner-vs-field comparison across 293 winners and 5,428 projects showed winners over-indexing on:

- `rust` and `anchor`;
- `oracle`, `amm`, `stablecoin`;
- clusters like `Solana Data and Monitoring Infrastructure` and `Solana Yield and DeFi Optimization`;
- target users like DeFi traders and DeFi investors.

Interpretation: if soltao wants to become "TAO DeFi," the winning pattern is not another broad dashboard. It needs a concrete financial primitive: capital movement, risk-aware routing, yield improvement, payments, or liquidity. The least crowded defensible wedge is still Bittensor-specific TAO movement and service payment from Solana.

## Recommended roadmap

### Phase 0: maintenance and proof, now

- Refresh subnet history and clear the live test.
- Prove Move, Claim, root unstake, and first-time ATA or hide/soften those actions until proven.
- Re-run usage with a full-history RPC and update README, HANDOVER, and submission copy.
- Keep the product claim: "native stake and return from Solana." Do not overclaim "TAO DeFi" on the live page yet.

### Phase 1: gateway ownership

Goal: soltao becomes the canonical "what do I do with Solana TAO?" page.

Build/fix:
- better canonical TAO acquisition path from SOL/USDC;
- fresher history automation;
- shorter proof pack for partners;
- one-page "verify the route" page with hashes, tests, known real-funds routes, and current gaps.

### Phase 2: TAO DeFi v1 = validator hygiene

Use the existing managed-staking research. The cleanest DeFi product is not a vault yet; it is non-custodial position improvement:

- show whether a user's validator is underperforming;
- flag zero-paying validators;
- offer same-subnet `move_stake` to a better validator;
- claim root rewards only when fee-aware thresholds are met;
- keep all actions user-signed.

This turns soltao from a one-time bridge into a portfolio loop without taking custody or creating a new token.

### Phase 3: service payments

Chutes is the first proof. After one credited top-up:

- turn on Chutes only if the credit lands cleanly;
- pitch "Solana wallet -> Bittensor inference credit";
- then ask Hippius and Targon the exact billing question before building anything custom.

This is the strongest version of your thesis: Solana has the wallets, Bittensor has useful services, soltao is the pipe.

### Phase 4: only later, vaults or managed mode

Do not build a pooled vault, receipt token, or automated proxy strategy until there is evidence:

- at least 20 outside routes;
- at least 5 repeat users;
- at least 2 successful service payments;
- at least 1 partner willing to repeat a pilot;
- zero unresolved recovery incidents.

If those gates are met, the next serious product is a non-custodial `Staking` proxy strategy, not a pooled Solana vault.

## Positioning

Use this:

> soltao is the Solana front door to Bittensor: stake canonical TAO from a Solana wallet, manage the native Bittensor position, and bring it back. Next, the same pipe pays Bittensor services.

Avoid this for now:

> soltao enables TAO DeFi on Solana.

That can become true. Today, it is the destination, not the audited product.

## Immediate next actions

1. Refresh history and clear `npm run test:live`.
2. Run one real-funds Move and one real-funds Claim with explicit approval.
3. Run one credited Chutes top-up before pitching the AI services story harder.
4. Re-run full usage with a reliable archive RPC.
5. Contact one subnet and one Solana TAO holder cohort with a narrow pilot offer.

## Follow-up on 2026-10-10

- Ran `npm run history`; local `stake/history/index.json` now has `generatedAt` = `2026-10-10T07:00:05.243Z`, `missingDays` = `0`.
- Ran `npm run build`; executable hashes stayed the same: `stake.js?v=b6c4271f`, `return.js?v=049fc82b`, `stake.css?v=34b30b81`.
- Ran `npm test`; full suite passed.
- Ran `npm run test:live`; all checks passed except the known deployed-history freshness check. The live site still serves history that is 3.9 days old until the refreshed local history is deployed.

- Craig then said "railway up"; deployed with `railway up --ci`.
- Post-deploy `npm run test:live` passed all checks. The daily history check now reads `0.9 days old` with `91 points`.
- Code hashes stayed unchanged; the deploy was a history/data refresh, not an executable route-code change.

## Continued maintenance on 2026-10-10

- Recorded the deployed history and this audit in local commit `dedafe3`.
- Fixed the usage reporter's unbounded RPC waits: request deadlines include response-body reads,
  retries are bounded and honor `Retry-After`, and the entire scan has a configurable time budget.
- Tightened the metric to successful transactions with a direct canonical OFT `send` and a System
  Program fee transfer. Merely referencing the program, a quote instruction, or a CPI is insufficient.
  The JSON keeps its existing fields and adds an explicit metric name, history boundary and limitation.
- Corrected current README/handover usage wording: a Solana submission does not prove Bittensor
  completion. The historical 9 submissions / 7 wallets remain dated to the prior measurement.
- Empty or truncated history, missing timestamps/transactions, repeated pages and exhausted requests
  produce no count. RPC response bodies and authenticated URLs are not printed in network errors.
- Added offline regression coverage for those cases and prepared `docs/gateway-proof-runbook.md`.
- Changed the remaining README setup/test commands to `npm ci`.

This maintenance changes local reporting and documentation only. No served route code, feature
flags or fund-moving logic changed. Move, Claim and the other real-funds gaps remain open.

### Verification completed on 2026-10-11

- Collected the completed `npm test` result: all suites passed, including 16 new usage-reporting
  regressions and the mainnet Solana transaction simulation (507,133 / 650,000 compute units).
- `npm run test:return:metadata` passed against block 9,259,338. Move, Claim and root-unstake
  argument definitions match the client. Basket and swap simulation reads answered; the current
  root-claim minimum was 0.0005 TAO. This remains read-only evidence, not real-funds proof.
- The five-minute usage run reached its deadline under the public RPC's rate limits and correctly
  produced no report. A second since-launch run with a 15-minute budget found 545 candidate transactions,
  then stopped on repeated 10-second request timeouts after reading more than 200. Neither incomplete
  run produced a count. A fresh full usage total still needs a reliable archive RPC; the older published
  figures remain dated to 6 Oct and are not presented as newly verified.
- Added `docs/soltao-audit-next-2026-10-11.html` as the readable checkpoint. Desktop (1400 px) and
  mobile (390 px) renders were inspected; neither had horizontal overflow.
