# Stake route — handover

Living document. Whoever (human or LLM) picks this up next should be able to read this alone and
continue without re-deriving context. Keep it updated after every meaningful step — don't let it
go stale.

Last updated: 2026-09-24. **Live in production at `soltao.xyz`, nothing unreleased.** Latest deploy:
commit `9f22575` (the subnet directory, bug history item 14), `stake.js?v=d8f02947` +
`return.js?v=5f50824e`, `test:live` all passed. The deploy before it, `994f394` (Craig: "deploy once
you are happy"), `stake.js?v=412be73a` + `return.js?v=8406712c`: Served on the first poll; `/healthz` 200 (so the new nginx rules are valid);
`npm run test:live` 23/23 on the real domain, including both cache headers, both mirror redirects,
`return.js` served and the return option still disabled.

Live now: the cleanup; the review fixes (bug history item 11: price-limited subnet stakes, TAO/Alpha
wording, debounced subnet checks, mobile wallet links, cache headers, Solana priority fee, sealed
resume routes); both Codex P1 fixes (item 12); the roast fixes (validator picker, shareable links,
who-runs-this line, USD in the review, holdings view); plus the redesign, subnet staking, the Helius
switch and link previews from before.

**Shipped but switched off** (`CONFIG.returnLive` false; opens on local hosts only): the return to
Solana, and unstake/re-stake from the holdings view (item 13). Turning them on needs one small
real-funds run of each, with Craig's approval, then `returnLive: true`, a build and a deploy.
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
  keyless, ~6 batched requests per subnet, no names). The correctness gap it found (a subnet-blind
  hotkey check) was fixed and deployed (bug history item 10), and the keyless validator picker was
  built from the same scan (item 11 table). No taostats API key was ever created.
- `tools/stake/src/derive.js` — the signature -> wallet derivation (coldkey + transit key). Also
  defines the exact SIWS message text (`signInFields`, `derivationMessage`).
- `tools/stake/src/app.js` — browser controller: wallet connect, sign-in, route orchestration,
  localStorage resumption. `findProvider()` (~line 75) is wallet-detection; `sign()` (~line 157) is
  the sign-in flow (always goes through the real wallet, including on localhost — see standing
  constraints); `send()` is the Solana transaction; `runRoute()` drives the Bittensor half. It also
  runs the return direction, the holdings view and its stake moves, the validator picker and the
  subnet directory. The return and the stake moves are open only where `RETURN_OPEN` (local hosts,
  or `CONFIG.returnLive`, which is false), so production cannot reach them.
- `tools/stake/src/stake_moves.js` + `src/settle.js` — unstake / re-stake from the coldkey (item 13)
  and the shared settling of a signed coldkey extrinsic.
- `tools/stake/src/prices.js` — display-only USD prices from Dexscreener for the review.
- `tools/stake/usage.mjs` — `npm run usage`: completed routes counted on-chain from the fee wallet.
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
- `tools/stake/src/oft_return.js` — builds/quotes the canonical wTAO -> Solana OFT send for the
  return direction (rao/wei/6-decimal-dust conversions, funding math, live fee quoting). Pure.
- `tools/stake/src/return_route.js` — the resumable free-TAO return engine: coldkey funding -> wrap ->
  final fee re-quote/top-up -> canonical OFT send. Every mutation is signed, checkpointed (hash,
  nonce, signed bytes) and only then broadcast; a resume reconciles each saved one first (bug history
  item 12).
- `tools/stake/src/substrate.js` — the coldkey side of the return: offline-signed funding transfers,
  submit, account nonce, free balance. Signs with `@scure/sr25519` through a polkadot `Signer`, never
  polkadot's Keyring, because Keyring needs WebAssembly and the page CSP has no `wasm-unsafe-eval`.
- `tools/stake/src/return_entry.js` — entry for `stake/return.js`, the return bundle (~800 KB,
  polkadot's api). Loaded by the page only when the return direction is opened, by content hash
  (`__RETURN_BUNDLE__`, defined at build time). Built with polkadot's no-WebAssembly loader.
- `tools/stake/src/pending.js` — sealing for saved browser records: the forward resume route
  (`sealRoute`/`readRoute`) and the return checkpoints (`sealRecord`/`openRecord`, label "return").
- The return direction in the page (`app.js`, "the return direction") opens only where
  `RETURN_OPEN`: on local hosts, or when `CONFIG.returnLive` is true. **It is false.** Production
  shows the option disabled until one small real-funds return has been done with Craig's approval.
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
  `npm run test:return:mainnet`), plus `subnet.test.mjs` (mocked metagraph batching and lookup, part
  of `npm test`) and `subnet_live.test.mjs` (read-only mainnet, `npm run test:subnet:live`).
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
6. Once the hash is live, run `npm run test:live` from `tools/stake`. It is read-only (no wallet,
   nothing signed) and checks the real domain: served hash equals the local build, both RPC origins
   pass the live CSP from inside the page, the subnet/hotkey checks behave on mainnet in the
   deployed bundle, the return toggle is still disabled, and there are zero console or CSP errors on
   `/` and `/stake/`. Extend it whenever a deploy changes something it does not yet cover.

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
   shortcut anymore. The temporary `?debug` SIWS sweep panel used to chase this was removed on
   24 Sep 2026, along with `minimal-test.html` and `check-leaks.mjs`. The globals check the latter
   did lives on in `test/page.test.mjs` and `test/live.test.mjs`.

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

10. **Subnet stakes accepted for hotkeys that are not on the subnet.** `onHotkey()` checked
    `getDelegate(hotkey)`, which takes no netuid, so any delegate passed for any subnet, and any
    netuid number passed without checking the subnet exists. The zero-cost replay
    (`test/mainnet.test.mjs` scenario 5, 24 Sep 2026) showed the chain **accepts** the stake:
    Opentensor Foundation's hotkey holds no uid on subnet 1, yet 0.1 TAO became ~11.2 Alpha under it,
    earning nothing, with no revert for the stake-refusal fallback to catch. Fix: for netuid > 0 the
    page reads the subnet's metagraph (precompile `0x802`, `findOnSubnet()` in `src/bittensor.js`,
    ~6 batched requests, ~2.5-4.5 s) and refuses a nonexistent subnet, a hotkey with no uid there, and
    a hotkey with a uid but no validator permit. Changing the netuid re-checks the hotkey. Root keeps
    the original delegate check, which has real-funds proof. Covered by `test/subnet.test.mjs`
    (mocked), `test/subnet_live.test.mjs` (read-only mainnet) and new cases in `test/page.test.mjs`.
    **Fixed and deployed** (`292b68b`, `stake.js?v=65f935e0`), verified live by `npm run test:live`.

    Same session: the replay harness could report a **fake revert** when the public RPC hiccuped
    mid-replay. The page's retry re-broadcast the same signed unwrap, the harness recorded it twice,
    and the duplicate found no wTAO. The harness now treats a re-broadcast of the same hash as one
    transaction and retries rate limits. If scenario 4 ever "fails" at the unwrap step, suspect this
    class of problem before suspecting the route.

11. **Review-and-iterate pass, 24 Sep 2026.** Findings and what was done:
    - **High, fixed: subnet stakes had no price limit.** `addStake` on a subnet swaps TAO into its
      Alpha pool at whatever price holds when the transit account's public transaction lands. Now
      `route.js` sends `addStakeLimit(hotkey, amount, limit, false, netuid)` for any netuid > 0, with
      `limit = getAlphaPrice(netuid)` (precompile `0x808`, wei of TAO per Alpha) plus
      `CONFIG.subnetPriceToleranceBps` (2%), converted to rao. No partial fills. A refusal goes
      through the existing fallback and delivers the TAO free. Root stays `addStake`. Proven by
      `test/mainnet.test.mjs`: scenario 1b stakes on subnet 1 through `addStakeLimit` (83,195 gas of
      140,000), and scenario 6 shows a limit 50% under the pool price is refused and delivered free.
      `test/route.test.mjs` cases K and L cover the same in the mocked chain. The unit reading was
      checked: subnet 1's price 0.00682 TAO per Alpha matches the replay's 0.0765 TAO buying ~11.2
      Alpha. Open: a large stake on a thin pool can move the price more than 2% by itself and be
      refused; the review does not yet estimate that impact.
    - **Medium, fixed: the review said "Stake about 0.076 Alpha on subnet 1"** for what is 0.076
      TAO buying ~11 Alpha. It now states the TAO going in, that it buys the subnet's Alpha at the
      pool price, and the 2% limit.
    - **Medium, fixed: typing a subnet number scanned the metagraph per keystroke.** "128" scanned
      subnets 1, 12 and 128, about six requests each, against a rate-limited RPC. The check now
      waits 400 ms for typing to settle, drops the hotkey's approval immediately so a stale
      approval can never reach the review, and caches each subnet's hotkey list for 60 s.
    - **Low, fixed: phones had no way in.** A phone browser never has a wallet injected. With no
      provider on a phone, the page now offers Phantom's and Solflare's documented browse links,
      which reopen it inside the wallet app.
    - **Low, fixed: caching.** The hashed script is cached for a year, and the stake HTML for 5
      minutes, in both `deploy/nginx.conf.template` and `_headers`.
    - **Low, fixed: no Solana priority fee.** Under congestion the transaction could expire (item 6
      handled the aftermath, not the cause). `quotePriorityFee()` in `src/solana.js` takes the 75th
      percentile of recent fees on the TAO mint and OFT escrow, clamped to 5,000-200,000
      micro-lamports per unit, so at most 0.00013 SOL. The review shows it as "Solana priority fee"
      and the transaction carries exactly the quoted value. Live quote on 24 Sep 2026: 125,000,
      about 0.00008 SOL. Covered by `test/solana.test.mjs` and `test/page.test.mjs`.
    - **Low, fixed: the saved resume route was unauthenticated.** Anything that could write this
      origin's `localStorage` could have changed where a resume pays out. `src/pending.js` now seals
      the route with an HMAC keyed from the transit key (HKDF, `soltao.xyz/pending-route/v1`), which
      exists only in memory after signing. An edited, foreign or pre-sealing route is ignored, and
      the page falls back to finishing to the wallet on screen. Covered by `test/pending.test.mjs`.
    - Clean: key derivation, SIWS text, no HTML-injection sinks anywhere, strict CSP, no Polkadot
      code in the forward bundle (checked), secrets dropped on `pagehide`.

12. **Return route: recovery made exact, then wired into the page (24 Sep 2026, not deployed, gated
    off in production).**
    - *Pending mutations* (docs/codex-review-2026-09-24.md, P1). A resume only consulted the OFT send
      hash, so a page closed after broadcasting a funding transfer or wrap, but before inclusion,
      repeated it. Funding also returned a block hash, not the extrinsic's own, via a subscription an
      HTTP provider cannot serve. Now `evm.js` has `signTx`/`broadcast`/`txStatus`/`waitMined` and
      `substrate.js` has `prepareTransfer`/`submitSigned`/`accountNonce`; the engine signs, saves,
      then broadcasts, and reconciles saved work as mined, pending (re-broadcast the same bytes) or
      dead (nonce used elsewhere, or the 64-block mortal era expired). `test/return_route.test.mjs`
      simulates a mempool and counts applied mutations for pending funding, pending wrap, a send whose
      reply was lost, an expired transfer, a wrap whose nonce was taken, and a reverted send.
    - *WebAssembly under the CSP.* polkadot's Keyring (sr25519) and its crypto init both need
      WebAssembly; the page CSP blocks it (`script-src wasm-eval` violation seen in the browser), and
      the api then waited forever. Fixed without touching the CSP: signing goes through
      `coldkeySigner()` (`@scure/sr25519`), the return bundle uses polkadot's no-WebAssembly loader,
      and the api starts with `initWasm: false`. `test/substrate_quote_live.test.mjs` proves on the
      live runtime that the signature verifies under two sr25519 implementations and that the
      extrinsic is byte-identical to a Keyring-signed one outside the signature.
    - *Startup that never settles.* When the RPC refuses polkadot's startup (rate limit), it retries
      forever. `getApi()` now fails after 30 s with a plain error and starts afresh next call.
    - *First-time Solana token accounts.* Read from the wTAO contract on 24 Sep 2026:
      `enforcedOptions(30168, 1)` = executor lzReceive with 200,000 compute units and 2,039,280
      lamports, exactly a token account's rent; and the Solana OFT's `lzReceive` takes the Associated
      Token and System programs. So a recipient with no TAO account has its rent carried by every
      delivery. Inferred from both, not yet observed on a real delivery.
    - *The page.* The return direction reads the derived coldkey's free TAO, quotes the LayerZero fee,
      the funding transfer's fee and a gas reserve, states what arrives on Solana, runs the engine
      with sealed checkpoints saved before each broadcast, and tracks arrival by the Solana wallet's
      own TAO balance (baseline saved with the checkpoints). `test/page.test.mjs` run F covers it up
      to review on a local host, with the coldkey's account read answered as 2 TAO free.
    - Open before `returnLive`: one small real-funds return with Craig's approval; unstaking
      (Milestone 4); a way to abandon a return whose send reverted (today the page reports it on
      every sign-in); arrival detection is balance-based, so another deposit to the same wallet in
      that window could be mistaken for it.

13. **Stake moves from the coldkey: unstake and re-stake (Milestone 4), 24 Sep 2026, gated off in
    production with the return.** The holdings view in step 2 gives each position "Unstake" and free
    TAO "Stake" (to step 3's checked subnet and validator), for the derived coldkey only, where
    `RETURN_OPEN`. `src/stake_moves.js` records the position and free balance, signs the move offline
    (`prepareStakeMove()` in `substrate.js`: `removeStakeLimit`/`addStakeLimit` with a 2% limit from
    the swap runtime API's Alpha price on subnets, plain `removeStake`/`addStake` on root), saves it
    sealed (label "stake-move"), submits, settles it (`src/settle.js`, shared with the return's
    funding transfer), and judges the outcome from the position and free balance, because an included
    extrinsic can still fail to dispatch when the price limit is not met. The forward route's refusal
    message now points at this retry and at the return. Tests: `test/stake_moves.test.mjs` (mocked),
    `test/substrate_quote_live.test.mjs` (all four calls sign and decode on the live runtime; subnet
    1 Alpha price 6,818,232 rao, matching the EVM precompile), `test/page.test.mjs` run F (the Stake
    action's gating, quote and limits; not confirmed). Unstake is not exercised in the browser: a fresh
    test wallet has no position, and faking one means answering a SCALE runtime call. No real-funds
    move yet.

14. **Subnet directory (Milestone 5), 24 Sep 2026.** "Browse subnets" beside the subnet field lists
    all subnets from `subnetInfoRuntimeApi.getAllDynamicInfo` (`subnetDirectory()` in `substrate.js`,
    through the Bittensor-side bundle, on request, cached 5 minutes): name and symbol as registered
    (stored as `Vec<Compact<u8>>`, so decoded from the plain values, not raw bytes), the spot price
    implied by the pool's reserves (subnet 1: 0.006818 TAO per Alpha, within 1 rao of the swap
    runtime API) and the TAO in the pool. Search by name, symbol or number; sort by subnet number or
    by TAO in the pool (root left out: it has no pool), with the rule and read time stated on the
    page and names labelled as not endorsements. "Use" fills the subnet field and runs the usual
    check. Not live-gated: it only reads. Note it loads `return.js` (~800 KB) when opened.

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
- **`/stake/` only runs on `soltao.xyz` or a local host.** The SIWS message names `soltao.xyz`, and
  the GitHub Pages and Railway-generated mirrors serve no CSP, so `init()` redirects any other host
  to the canonical page. `test/live.test.mjs` checks both mirrors hand off.
- **Space out the live test runs.** `lite.chain.opentensor.ai` rate-limits per client over a 60 s
  window (`429`, `retry-after: 60`, `x-ratelimit-policy: http_60s`), and it limits requests that
  carry a browser `Origin` more readily than bare ones. Running the mainnet replay, the page test and
  the live check back to back tripped it on 24 Sep 2026. In the browser that shows up as "Failed to
  fetch", not as a CSP violation. Despite the 60 s header, a 2-minute pause was not enough that day
  and a 5-minute fully quiet pause was. Rerun after a quiet pause before suspecting the code.

## Product roast and usage, 24 Sep 2026

A deliberately harsh product critique (roast-my-product) ran alongside the code review in bug
history item 11. Full report, private to Craig: https://claude.ai/artifact/3ZEokBPmJqJGaZKv8huZWc

**Usage, read from chain.** The fee wallet's entire history (949 transactions) holds exactly one
completed route, meaning a transaction that both pays soltao's fee and calls the canonical TAO OFT
program: 23 Sep 2026, 00:23 UTC, Craig's own real-funds test, which paid the old 0.0075 SOL fee.
No outside user has completed a route. Re-count any time with `npm run usage` in `tools/stake`
(read-only, seconds). Correction to the first roast report: the ~940 other transactions on the fee
wallet all predate the stake page. Only 11 touch it since 21 Sep 2026, so revenue reads cleanly from
the launch date and a dedicated fee wallet is optional, not needed for measurement.

**Score: 55 / 110** ("needs significant work"). Value proposition 6 (x2), crypto necessity 9, target
user 5, first-time experience 4, core loop 2, moat 3, technical execution 8, naming 4, monetization
3, timing 5. The engineering is ahead of the product.

**Worst issues, and the plan for each:**

| Issue | Plan |
|---|---|
| Nobody has used it, and nothing measured that | Done: `npm run usage` counts routes on-chain from the fee wallet, since launch |
| It only opens one way: stake in, no return through soltao | Milestone 3: wire the built free-TAO return, then unstake and return (Milestone 4) |
| Subnet stakers must find a valid hotkey on taostats themselves | Done: "List subnet N's validators" reads the permit holders from the metagraph (`subnetValidators()`, ~13 requests, ~7 s on subnet 1), shows uid, take and last-epoch dividend share, states its one sort rule on the page, and choosing a row only fills the field, which is then checked as usual. No stake column: its unit was never confirmed. No names: not on-chain |
| The board, the stake route and the SOLTAO coin share one name; the stake page header says "Unofficial community reference" | Done: a line under the headline says who runs it, that keys never leave the browser, that the page's code is the trust point, and that the flat SOL fee is its only charge. Header now "Self-custody stake route" |
| Amounts are TAO and SOL only, never money | Done: the review adds "In dollars, roughly": the TAO amount and the SOL fees in USD from Dexscreener's deepest USD pool (already in the CSP), with the read time. Display only (`src/prices.js`), cached 60 s, hidden if the feed fails; nothing the route does uses it |
| No core loop: nothing to come back to (scored 2/10) | Started: "Show what this Bittensor wallet holds" in step 2 lists free TAO and every stake position (subnet, validator, amount) from the chain's StakeInfo runtime API, for the derived or a pasted coldkey. Read on request through `stake/return.js`. Next: actions per position (unstake and return, Milestone 4) |
| No shareable state | Done: `?netuid=` and `?hotkey=` prefill step 3 and run the normal checks; a checked validator offers "link to this choice" |

Sins flagged: phantom users, bridge to nowhere, jargon overload, and MEV bait (fixed in item 11).
Avoided: token-first thinking; the $SOLTAO gate was rejected and the conflict is disclosed.

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

**State after round three** (superseded by the later-session note below, which deployed `292b68b`):
local `main`, `origin/main`, and the live site were in sync at commit `0dc334b`, script hash
`stake.js?v=b5d4275d`. Verified directly against the live domain, not inferred: script
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

**Later session of 24 Sep 2026 (built and deployed).** Acted on that finding: bug history item 10.
The replay settled the open question (the chain accepts an off-subnet stake silently), the page now
checks the chosen subnet's metagraph, and the harness's fake-revert flake is fixed. Results:
`npm test` green, `npm run test:page` green including the new subnet cases, `test:subnet:live` green,
`test:mainnet` green. Pushed and deployed as `292b68b` / `stake.js?v=65f935e0` with Craig's explicit
go-ahead; the hash was serving on the first poll. Post-deploy: every served file byte-identical to
the repo, CSP on `/` and `/stake/` allows both RPC origins, new `npm run test:live` 16/16 on the real
domain, and `npm test`, `test:return:live`, `test:return:mainnet` and `test:return:metadata` all
green.

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
