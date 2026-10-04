# Codex review and completion handoff — 24 September 2026

> Historical snapshot at 28e646c. Later work addressed the two findings (acd2080 and 9f11bd6); focused regression suites passed on re-review at 8b4b664. See [the updated assessment](subnet-pilot-and-roast-2026-09-24.md) for the now-live return, real-funds evidence, remaining risks, and recommended pilot. The completion checklist below is no longer current.

## Scope and verified state

Reviewed README, gateway plan, stake handover, recent history, the uncommitted priority-fee and authenticated-resume changes, forward recovery, return engine, signing/transaction helpers, and existing recovery tests. This is a focused review, not an exhaustive security audit. No application files were changed, rebuilt, committed, or deployed by this review.

- Local HEAD: `28e646c`. Local cached `origin/main`: `32f70c3` (not fetched; do not treat this as current remote state).
- Direct production GET returned `stake.js?v=65f935e0`. Its CSP includes the configured Helius and Bittensor RPC origins. This confirms the documented older live bundle, not every production file's identity.
- Committed local changes include subnet price limits, corrected TAO/Alpha wording, debounced/cached subnet validation, mobile wallet entry links, mirror redirects, and cache changes. These are ahead of the observed live bundle.
- Uncommitted work includes priority fees, MAC-authenticated saved routes (`pending.js`), tests, handover edits, and marketing logo experiments. Preserve this work. The snapshot changed during inspection: `pending.js` appeared as a new file.
- Root real-funds success and subnet mainnet-state replay are recorded in HANDOVER; neither was independently repeated here.
- Return engine exists, but production return controls remain disabled. Full unstake-and-return is not implemented as a usable journey.

## Findings to resolve before the relevant release

### P1 — authenticated resume silently drops existing routes

Files: `tools/stake/src/pending.js` (`openRoute`), `tools/stake/src/app.js` (`loadPending`, `checkTransit`, `resume`), `tools/stake/src/route.js` (`transitState`).

The current production page saves unsigned route objects. The new loader returns null for all of them. `checkTransit` then asks for no hotkey and defaults to root; `transitState` reports zero stake when no hotkey is supplied. A route interrupted after subnet staking but before handover can therefore disappear from recovery when the remaining native balance is below the sweep threshold. If native funds remain, fallback recovery only delivers free funds and still does not hand over the undiscovered stake. A saved custom destination is also discarded. This does not destroy keys or funds, but breaks the promised in-page recovery.

Fix: distinguish absent, legacy, and invalid-MAC records. Never automatically trust or sign legacy storage. Present legacy destination/hotkey/netuid as untrusted recovery hints, validate them against chain state, and require explicit destination confirmation before sealing a migrated record. Provide a recovery path that discovers or accepts the original stake position rather than assuming root. Add a browser regression for a legacy subnet route with stake remaining and native funds below the sweep threshold, plus a custom-destination case.

### P1 — return resumes can repeat still-pending funding/wrapping

Files: `tools/stake/src/return_route.js` (`ensureFunding`, wrap block), `tools/stake/src/substrate.js` (`submit`), `tools/stake/src/evm.js` (`sendTx`).

Only `progress.sendHash` is consulted on resume. Funding and wrap checkpoints written before awaiting submission contain no transaction identity; their hashes are saved after completion. Closing the page after broadcast but before inclusion leaves unchanged latest balances. Resume then attempts funding or wrapping again. Funding can transfer more than the reviewed amount if both transfers eventually execute; a second wrap can consume excess native balance or fail and waste gas. Existing tests pre-populate already-settled balances and do not cover this window. The funding helper currently returns an inclusion block hash, not an extrinsic hash, so its `fundingHash` cannot directly identify the transaction.

Fix: persist signed transaction identity, nonce, route identity, and expected mutation before submission for every mutation; resolve pending/included/failed status before issuing another. For ambiguous transport outcomes, reconcile or rebroadcast identical signed bytes rather than creating a new transaction. This also closes the EVM send window where the RPC accepts a transaction but its response is lost before `onBroadcast` runs. Add pending funding, pending wrap, accepted-but-response-lost send, reverted/dropped transaction, and competing-tab tests. Do not expose the return controls until these cases and browser persistence are covered.

## Verification performed

Passed: `derive.test.mjs`, `keyring.test.mjs`, `oft_return.test.mjs`, `return_route.test.mjs`, `route.test.mjs`, `subnet.test.mjs`, and `shim.test.mjs` (run individually from `tools/stake`). These exercise deterministic derivation, signer identity, return calldata and units, settled recovery, forward route behavior and subnet price limits, metagraph lookup, and SDK shims.

Added `tools/stake/test/review-recovery-probe.mjs`. Run from `tools/stake` with `node test/review-recovery-probe.mjs`. It reproduces legacy-record rejection and repeat mutation attempts during pending funding/wrapping without network calls or real keys. Exit zero means the defects were reproduced, NOT that recovery is safe. Convert these scenarios into normal safety assertions when fixing them; do not add this reproducer unchanged to the passing regression suite.

Not run: full `npm test` (includes live RPC tests), browser suite, build, mainnet replays, or real-wallet transactions. Avoid rebuilding over another agent's active edits. Production validation here was limited to a read-only page/header request.

## Completion order and suggested split

1. Resolve authenticated-resume migration and in-flight transaction recovery. These are the most useful bounded correctness tasks for Codex to own while Claude continues UI work, after file ownership is coordinated.
2. Complete Milestone 3: authenticated browser checkpoints, explicit free-return quote/review, a separately loaded Polkadot bundle, and Solana arrival tracking tied to the specific bridge transfer. Cover existing and first-time destination token accounts; do not equate EVM send success with Solana arrival.
3. Complete Milestone 4: discover known root/subnet positions, select partial or full exit, quote fees/output, enforce subnet exit price protection, and resume unstake-to-return across every interruption.
4. Close the gateway plan's refused-price-limit flow: currently the forward route sweeps free TAO to the coldkey and directs users to another wallet; the plan calls for an in-product fresh quote or return choice. Build that choice around the actual account holding the funds.
5. Complete Milestone 5: subnet-filtered validator picker, portfolio and return actions, subnet directory with source timestamps/unavailable states. Keep ranking rules explicit. Marketing logo work is separate from these launch requirements.
6. On a stable snapshot, build, run the appropriate offline/browser/live-read tests, and check generated assets. Then perform the explicitly approved small real-funds return. Deployment still requires Craig's explicit fresh confirmation under HANDOVER; verify the serving hash and live checks after rollout.

Do not change the SIWS message/key derivation during this work. Preserve recovery compatibility, the no-WalletConnect constraint, and disabled production return controls until acceptance criteria are met. This handoff is local; no message has been sent to another Claude session.

## Assessment

Quality: B provisionally; strong module separation and meaningful existing tests, with pending-transaction coverage missing. Security/recovery: C provisionally for the reviewed proposed changes because the two high-priority recovery findings remain open. Full gateway launch readiness: false. This is not a judgment that the already-deployed forward-only product is wholly unusable.
