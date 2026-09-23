# Stake route — handover

Living document. Whoever (human or LLM) picks this up next should be able to read this alone and
continue without re-deriving context. Keep it updated after every meaningful step — don't let it
go stale.

Last updated: 2026-09-24. **Live in production at `soltao.xyz`, nothing unreleased.** The redesign,
subnet staking, the bridge-back scaffold, the Helius RPC switch with its matching CSP fix, and the
link-preview/SEO metadata are all deployed and verified against the real domain. The deployed
artifact is commit `0dc334b`, script hash `stake.js?v=b5d4275d`; any commit after that on `main` is
documentation only and changes nothing that is served.
See "Current state" for what has real-funds proof versus what shipped on zero-cost mainnet-state
verification plus Craig's own informed go-ahead.

An earlier version of this header warned about an unreleased CSP fix. That is resolved: the live
CSP on both `/` and `/stake/` now includes the configured Helius origin, confirmed by simulating
the page's own wallet-connect `fetch()` from inside the live page (200 OK, zero violations).

## What this is

A contract-free way to bridge canonical Solana TAO to Bittensor and stake it, using keys derived
entirely from one Solana wallet signature. No custody, no soltao-owned contract, nobody but the
user ever holds a key. Lives at `soltao.xyz/stake` (Railway-hosted, static site, separate from the
main "Solana TAO Board" page which stays no-wallet-connect).

### How it works

1. User connects a Solana wallet (Phantom, or anything exposing the standard `window.solana`
   interface — not Phantom-specific, see `findProvider()` in `src/app.js`).
2. User signs one fixed Sign-In-With-Solana (SIWS) message. The signature is deterministic
   (ed25519), so the same wallet always produces the same signature.
3. That signature is stretched (HKDF) into two independent keys, both belonging only to the user:
   - A **Bittensor coldkey** — ordinary 12-word sr25519 mnemonic, SS58 prefix 42. Imports into
     btcli or any Substrate wallet like any other wallet.
   - A **transit key** — secp256k1, giving a Bittensor EVM (H160) address. This is where the
     bridge delivers funds and where the page signs transactions on the user's behalf.
4. The Solana transaction bridges TAO via LayerZero OFT to the transit account, plus a small native
   TAO gas drop so the transit account can pay its own gas.
5. The page then signs up to 4 Bittensor transactions from the transit key: unwrap wTAO -> addStake
   (on the netuid the user chose — root by default, or any subnet) -> transferStake (to the user's
   coldkey, same netuid) -> transferAll (sweep any dust/leftover gas to the coldkey as free TAO).
6. Fully resumable: closing the tab loses nothing. Re-signing in and reading chain state picks up
   exactly where it left off. `localStorage` only remembers non-secret route settings (never keys).
7. If staking is refused by the network for any reason, funds fall back to arriving as free
   (unstaked) TAO in the user's coldkey — nothing gets stuck.

## Where things live

- `docs/gateway-plan.md` — the current product/milestone plan (root: soltao as a Solana<->Bittensor
  gateway, not just a one-way stake page). Read that before this doc for what's next; this file is
  about the code that already exists.
- `research/subnet-validator-data-research.md` — where subnet/validator data can come from, read
  24 Sep 2026: the taostats API (per-subnet validator lists and 1h/1d/7d/30d APY, key required, quota
  undocumented) versus the Bittensor metagraph precompile `0x802` (same validator lists free and
  keyless, ~6 batched requests per subnet, no names). Also records an open correctness gap it found:
  `onHotkey()`'s `getDelegate(hotkey)` check takes no netuid, so a hotkey that validates nowhere on
  the chosen subnet still passes as a "registered validator". Nothing implemented; no API key created.
- `tools/stake/src/derive.js` — the signature -> wallet derivation (coldkey + transit key). Also
  defines the exact SIWS message text (`signInFields`, `derivationMessage`).
- `tools/stake/src/app.js` — browser controller: wallet connect, sign-in, route orchestration,
  localStorage resumption. `findProvider()` (~line 75) is wallet-detection; `sign()` (~line 157) is
  the sign-in flow (always goes through the real wallet, including on localhost — see standing
  constraints); `send()` is the Solana transaction; `runRoute()` drives the Bittensor half. Also
  owns a "Bridge to Bittensor" / "Bridge to Solana" direction toggle in the page, but the reverse
  option is `disabled` in the HTML and `planReady` hard-gates on `direction === "forward"` — nothing
  live can reach the return code below yet.
- `tools/stake/src/route.js` — the 4-step Bittensor route logic (unwrap/stake/handover/sweep) for
  the forward direction, now netuid-aware (stakes and hands over on whichever subnet the user
  picked, root by default), including the stake-refusal fallback.
- `tools/stake/src/solana.js` — the LayerZero OFT bridge transaction + fee transfer + gas drop.
- `tools/stake/src/evm.js` — Bittensor RPC calls, retry/backoff, receipt polling.
- `tools/stake/src/bittensor.js` — precompile reads (delegate, stake, balance, wTAO, address map).
- `tools/stake/src/config.js` — addresses, the soltao fee wallet
  (`BgGFMbwUtKLifQYZogbDorEXTXYp3UKVAZSH41xQ72Na`). `solanaRpc` switched from a public shared
  endpoint to a dedicated Helius endpoint on 23 Sep 2026 — this is committed and public (visible in
  the shipped bundle to anyone), a deliberate tradeoff Craig accepted for reliability.
- `tools/stake/src/oft_return.js` — **new, not wired to the page.** Builds/quotes the canonical
  wTAO -> Solana OFT send for the bridge-back direction (rao/wei/6-decimal-dust conversions, funding
  math, live fee quoting). Pure functions only; nothing here sends a transaction.
- `tools/stake/src/return_route.js` — **new, not wired to the page.** The resumable free-TAO return
  engine: coldkey funding -> wrap -> final fee re-quote/top-up -> canonical OFT send. It records the
  EVM send hash immediately after broadcast and will only inspect that receipt on resume, preventing
  a duplicate bridge send. The production toggle remains disabled.
- `tools/stake/src/substrate.js` — **new, not wired to the page.** A `polkadot.js` coldkey signer for
  `removeStake`/`transfer`, for the bridge-back direction. Argument order against the live runtime is
  checked by `test/polkadot.test.mjs`, not assumed.
- `tools/stake/build.mjs` — esbuild bundler. Also stamps `stake/index.html`'s script tag with a
  content hash (`stake.js?v=<hash>`) so a new deploy can never be served stale from any cache layer.
  **Always run `npm run build` before deploying** — the hash must change for the fix to actually
  reach users.
- `tools/stake/test/` — `derive.test.mjs`, `evm.test.mjs`, `route.test.mjs` (now covers subnet
  staking and subnet-specific resume), `solana.test.mjs`, `shim.test.mjs`, `page.test.mjs`
  (headless-browser, CSP-compliant), `mainnet.test.mjs` (see below), plus the new
  `oft_return.test.mjs`/`keyring.test.mjs` (mocked/unit) and `oft_return_live.test.mjs` /
  `substrate_quote_live.test.mjs` / `polkadot.test.mjs` (live, read-only mainnet checks for the
  bridge-back foundation — run via `npm run test:return:live` / `test:return:metadata`), plus
  `return_route.test.mjs` (recovery state machine, part of `npm test`) and
  `return_mainnet.test.mjs` + `ReturnReplay.sol` (real wTAO/LayerZero zero-cost replay, run with
  `npm run test:return:mainnet`).
- `stake/index.html`, `stake/stake.js`, `stake/stake.css` — the built, committed output actually
  served in production. Never hand-edit `stake/stake.js`; it's generated by `npm run build` from
  `tools/stake/src/*`. `index.html`/`stake.css` are hand-edited directly (only the script version
  hash in `index.html` is rewritten by the build). As of 23 Sep 2026 this also carries a full visual
  redesign (PR #1 on GitHub, merged into the same page as the subnet-staking/direction-toggle work).

### The no-funds mainnet-replay test harness

`tools/stake/test/mainnet.test.mjs` + `tools/stake/test/Replay.sol` place test-only Solidity
contracts at real mainnet addresses (LayerZero's endpoint, the transit account) inside a single
`eth_call` with state overrides, and replay the exact signed transactions `route.js` produces
against live chain state — zero cost, no state change, but a real test against real mainnet
behavior (gas limits, precompile responses, revert conditions).

## Deploy process

This is **not** git-push-triggered. Steps, in order, every time:
1. `cd tools/stake && npm run build` — rebuilds `stake/stake.js` and re-stamps the version hash in
   `stake/index.html`.
2. `npm test` — full suite, should show all green, zero failures. (A `bigint: Failed to load
   bindings` line is harmless noise, not a failure.)
3. `git add`, commit, `git push origin main` (GitHub, for history — not what serves the site).
4. `railway up --ci` from the repo root (`D:\TAO`) — this is what actually deploys to `soltao.xyz`.
   Ask the user for explicit confirmation before running this each time.
5. Verify: `curl -s https://soltao.xyz/stake/ | grep -o 'stake\.js?v=[0-9a-f]*'` — confirm the hash
   matches what `npm run build` just printed. **`railway up --ci` exits before the rollout is
   live** — a zero exit code only means the build was accepted, and `railway status --json` can
   still show `BUILDING` afterwards. Poll the live URL until the change actually appears; do not
   report a deploy as done off the command's exit code. Verify the thing you changed, not just
   that the page loads: a page-load smoke test would not have caught the CSP bug in item 7,
   because the violation only fires once the wallet flow makes its first request.

## Bug history (chronological, all confirmed via live testing)

1. **Phantom "Unexpected error" on Connect.** Root cause: `window.process`/`window.Buffer` global
   pollution from the esbuild bundle. Fixed via `src/inject.js` + esbuild's `inject` option.
   **Confirmed fixed.**

2. **Swallowed revert in `evm.js`'s RPC retry logic.** Receipt-polling's try/catch was swallowing
   the deliberate "transaction reverted" throw. Fixed by separating transport-error tolerance from
   revert detection. **Fixed.**

3. **Phantom -32000 on Sign-In.** An em dash (U+2014) in the SIWS statement. Phantom enforces
   plain-ASCII SIWS text strictly. Fixed with a plain period in `src/derive.js`. Regression test
   in `test/derive.test.mjs`. **Confirmed fixed.**

4. **Phantom -32603 on localhost.** Phantom's SIWS parser rejects domains with ports
   (`localhost:8788`). Using `soltao.xyz` as the domain locally triggers a -32000 origin mismatch.
   **This is local-dev-only.** Production on `soltao.xyz` (no port, origin matches domain) works.
   `app.js` used to bypass the signature request on `localhost` and generate a deterministic fake
   signature from the public key. **That bypass was removed on 23 Sep 2026**: it meant localhost
   could derive a real, mainnet-capable wallet without any real wallet signature at all, which is a
   safety gap, not just a convenience. `sign()` now always goes through the real wallet, on every
   host. Local testing of the sign-in step needs a real wallet extension that tolerates the
   `localhost:<port>` origin (or a real domain via a local DNS/hosts-file override) — there is no
   shortcut anymore.

5. **"not sent" with no visible error after clicking Sign and Send.** Two issues:
   - (a) `gate()` was called after `send()` errors, which fired `requestQuote()` on a 350ms timer
     that overwrote the error message. Fixed by not calling `gate()` on non-rejection errors.
   - (b) After the error, `$("sign").disabled` stayed `true` and `step-status` stayed `active`,
     so the user could not retry without refreshing. Fixed by re-enabling the button and resetting
     the step state in the error handler. **Fixed.**

6. **"Send failed: expired before it landed" but tx actually landed.** Root cause: Race condition in 
   `confirm()`. The block height could exceed `lastValidBlockHeight` before the RPC nodes had indexed 
   the transaction signature status. Fixed by adding a 4-second delay and one final `getSignatureStatuses` 
   check after the block height deadline is passed, before declaring it truly expired. **Fixed.**

7. **Configured Helius RPC blocked by production CSP.** `config.js` was switched from PublicNode to
   Helius, but `_headers` and `deploy/nginx.conf.template` still allowed only PublicNode. The static
   page loaded without errors; the violation appeared only after wallet connection tried to read a
   Solana balance — exactly the kind of gap a page-load-only smoke check misses. Confirmed in the
   live response headers on 23 Sep 2026. Both CSP files now allow the exact configured Helius
   origin, and `test/page.test.mjs` completes the full wallet flow with zero CSP violations.
   **Fixed and deployed** — confirmed live on `soltao.xyz` (both `/` and `/stake/`) by simulating the
   actual `fetch()` the page's own wallet-connect code makes to the Helius endpoint from inside the
   real page, not just checking that the page loads.

8. **Review step active before a route was reviewable.** The gate made step 4 active on a fresh
   page and tied fee quoting to the destination acknowledgement. It now keeps steps 2-5 locked at
   startup, shows the live quote once the route fields are complete, and enables signing only after
   the user acknowledges the permanent destination. Covered by the headless browser flow.

9. **Link previews described the pre-redesign site, and `/stake/` had none at all.** The homepage's
   `og:`/`twitter:` title and description still said "which TAO is the real one" after the hero copy
   had moved to "Solana TAO is a bridged wrapper, not native TAO", so pasting the link produced a
   preview that did not match the page. `/stake/` had no Open Graph or Twitter Card tags whatsoever,
   so sharing it produced no card. Both fixed 24 Sep 2026: homepage tags rewritten from the actual
   on-page copy, `og.png` regenerated from `og.html` with the matching headline (still exactly
   1200x630; `og.html` already used the redesign's own teal/copper tokens, so no visual drift), and
   a full tag set added to `/stake/` reusing the shared `og.png`. **Fixed and deployed**, verified
   by reading the tags back off the live domain. Stale `sitemap.xml` lastmod dates bumped too.

## Link previews and SEO

`index.html` and `stake/index.html` each carry their own `og:`/`twitter:` block; they are hand-
maintained and do **not** update themselves when page copy changes. When you change a hero headline
or a page's positioning, change these too or the shared link silently starts lying:

- `og.png` is generated, not hand-drawn: edit `og.html`, then re-render it to exactly 1200x630 and
  overwrite `og.png`. A headless screenshot of `og.html` at that viewport is all it takes.
- Both pages point at the same `/og.png`. A dedicated card for `/stake/` would be a nice-to-have,
  not a gap.
- Platforms cache unfurls hard. After changing these, expect to force a re-scrape (or wait) before
  a previously-pasted link shows the new card.

## Standing constraints

- **No WalletConnect.** The bugs were inside Phantom's own signing logic, not transport-related.
- **No private keys in chat.** Anything pasted here is written to plaintext logs indefinitely.
- **Keep the SIWS statement plain ASCII.** Enforced by `test/derive.test.mjs`.
- **Always rebuild before deploying.** `stake/stake.js` is generated output.
- **Deploys need explicit fresh confirmation each time** — ask before every `railway up --ci`.

## Current state

### Deployed 23-24 Sep 2026 (three rounds)
Round one: the redesign, netuid-aware `route.js`, the direction-toggle scaffold, and the Helius RPC
switch were built, tested, committed, pushed, and deployed via `railway up --ci` with Craig's
explicit go-ahead. That deploy shipped a real bug — `config.js` pointed at Helius but the CSP
headers still only allowed PublicNode (bug history item 7) — caught by checking response headers
directly rather than trusting a page-load-only smoke test.

Round two happened separately and concurrently: another session/process (commit `a1de8dc`, "Build
resumable free-TAO return foundation") fixed the CSP gap, refined the review-step gating (bug
history item 8), and pushed further Milestone 3 work (`return_route.js`, resumable free-TAO
return), then deployed it.

Round three (24 Sep): the link-preview/SEO metadata fix (bug history item 9), deployed and verified.

**Current state:** local `main`, `origin/main`, and the live site are in sync at commit `0dc334b`,
script hash `stake.js?v=b5d4275d`. Verified directly against the live domain, not inferred: script
hash matches the local build, `og:title` on both pages returns the new copy, `og.png` is the
regenerated 170,825-byte file, and the CSP on `/stake/` includes the Helius origin. The Helius
endpoint was additionally exercised by running the page's own wallet-connect `fetch()` from inside
the live page (200 OK, zero CSP violations).

**Session of 24 Sep 2026 (research only, no deploy).** Looked at where the data for a subnet
directory and validator picker would come from — taostats' API versus Bittensor's own precompiles.
Nothing was implemented, no API key was created, `npm run build` was not run and nothing was
deployed. Findings are in `research/subnet-validator-data-research.md` (local only: `research/` is
gitignored) with the durable summary in `docs/gateway-plan.md` under Milestone 5. The one thing
worth acting on: the live hotkey check is subnet-blind, so the page can call a hotkey a "registered
validator" for a subnet it does not validate on. Verified at close that every served file
(`stake/stake.js`, `stake/index.html`, `stake/stake.css`, `index.html`, `app.js`, `styles.css`,
`_headers`, `deploy/nginx.conf.template`) is byte-identical between the deployed commit `0dc334b`
and HEAD, and that the live hash is still `stake.js?v=b5d4275d` — so every commit after `0dc334b`
is documentation and the live site is not behind.

**Note for whoever picks this up next:** at least one other agent/process was actively committing
and deploying to this same repo across 23-24 Sep, without coordinating through this session. It
overwrote parts of this document mid-session, including re-introducing a stale "unreleased CSP fix"
warning after the fix had shipped. Re-check `git log origin/main`, the live script hash, and the
live response headers before trusting any claim in here — including this one. `railway up --ci`
also exits before the rollout finishes, so a clean exit code does **not** mean the new build is
serving; poll the live site until the change actually appears.

### What has real-funds proof
- **Wallet connection, SIWS sign-in, wallet derivation, transit account/coldkey generation,
  transaction building/simulation/quote** — all exercised live on `soltao.xyz` before today.
- **Root-staking forward route** (unwrap -> addStake root -> transferStake -> sweep): a live
  production transaction was sent and routed successfully — SIWS sign-in succeeded, Phantom
  approved the Solana bridge tx, the bridge delivered wTAO + gas drop, the route unwrapped and
  swept to the coldkey, and it landed in Craig's Talisman wallet with the soltao fee correctly
  reaching the treasury wallet. Confirmed real by Craig on 23 Sep 2026 (predates subnet staking,
  the localhost-bypass removal, and the redesign).
- **Error recovery** — messages persist, UI recovers, background bridging resumes from chain state.

### What shipped on real-mainnet-state verification, not yet a real signed transaction
- **Subnet staking** (`route.js` addStake/transferStake now take a netuid). Covered by a mocked
  chain simulation (`route.test.mjs`, proving subnet resume never touches root stake) and by a
  zero-cost mainnet-replay extension added 23 Sep 2026: `test/mainnet.test.mjs` replays the real
  signed transactions through the real staking precompile against real subnet 1 (owner hotkey
  independently confirmed live to be a registered delegate). Across repeated runs, 0.1 TAO
  consistently converts to ~11.2 Alpha owned by the fresh coldkey, zero root-stake
  cross-contamination, `addStake` succeeding in 8 of 8 attempts (one run's *later* step hit the
  shared public Bittensor RPC's rate limit from our own repeated testing, not a revert). This is
  why Craig chose to ship without spending real subnet-stake funds first: the one thing a mock
  can't prove (real precompile behavior on a real, currently-registered subnet) is now proven, for
  free. What remains open — Phantom actually signing the real calldata cleanly, LayerZero's
  executor actually delivering — is the same class of risk the root-staking route already cleared,
  not something specific to subnets.
- **The visual redesign** (PR #1, merged 23 Sep 2026) — verified headless pre-deploy and again
  against the live production domain post-deploy (zero console/CSP errors both times), but not yet
  exercised by a real wallet signing a real transaction on it. Past bugs in this project (items 1,
  3, 4 above) were real-browser/real-domain issues headless testing would not have caught, so a
  real-wallet pass is still the highest-value thing left to do, at Craig's convenience — not a
  blocker, since it already shipped on his informed call.
- **Bridge-back foundation** (`oft_return.js`, `substrate.js`) — Milestone 3 in `docs/gateway-plan.md`,
  now includes the resumable `return_route.js` engine. Deliberately not reachable from the live page
  (disabled toggle, `app.js` gates on `direction === "forward"`). Its local recovery suite covers
  funding, wrapping, fee increases, partial returns, broadcast and pending-transaction resumes. A
  zero-cost mainnet-state replay wrapped 1 real canonical TAO and ran the real wTAO LayerZero send
  toward Solana: live fee 0.002859118 TAO, wrap 59,827/75,000 total gas, send
  246,363/650,000 total gas, zero wTAO left. Still missing browser checkpoint persistence, Solana
  arrival/ATA tracking, a lazy return-only bundle, and one small real-funds return. Confirmed on the
  live domain that the toggle remains inert.

**Bottom line:** live in production. Root staking has full real-funds proof. Subnet staking has
real-chain-state proof plus Craig's informed acceptance of the remaining gap. The redesign has
headless proof on the real domain. The bridge-back return engine's mocked recovery suite
(`return_route.test.mjs`, 11 assertions) and its zero-cost mainnet replay (`return_mainnet.test.mjs`
— live fee 0.002859118 TAO, wrap 59,827/75,000 gas, send 246,363/650,000 gas, 0 wTAO left) were both
independently re-run and confirmed this session, not just taken on the other session's word. The
standing deploy constraint above (explicit confirmation before every `railway up --ci`) was
followed for the deploy this session made, and still applies to the next one — including whichever
session makes it.
