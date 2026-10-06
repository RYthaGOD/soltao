# Stake route — handover

Living document. Whoever (human or LLM) picks this up next should be able to read this alone and
continue without re-deriving context. Keep it updated after every meaningful step — don't let it
go stale.

Last updated: 2026-10-07 (item 43 live). **Live on soltao.xyz:** commit `e33b99e` (deployed 7 Oct),
`stake.js?v=b6c4271f`, `return.js?v=049fc82b`, `stake.css?v=34b30b81`. The hero leads with "Stake on root" and
one "Done with real funds on mainnet" strip, and the footer says how to verify the script (item 43). The subnet
list sits under the hero; its figures, and an open validator or holdings list, re-read every minute (items
40–41). The holdings still say Move and Claim have not moved real funds. No subnet is named.
**Real funds through the live page:** root and subnet stakes; the free-TAO return; and, from an outside wallet
on 1 Oct, a subnet Unstake with the batched Bittensor fee, chained into a return that landed on Solana (item 42).
**Not yet with real funds:** Move, Claim, staking more from holdings, a root unstake (plain `removeStake`),
Top up Chutes (still off, `chutesLive: false`), and a first-time Solana token-account arrival.
**Next:** one small real-funds Move and Claim. Not a new feature. Do not name a subnet.

Usage on 6 Oct 2026 (`npm run usage`, unchanged since 4 Oct; the last route was 3 Oct 16:30 UTC): 9 completed routes from 7 wallets since 21 Sep, 0.368833032 SOL in fees.
Three routes are Craig's (`CVXTu5…`, `3hfdqA…` twice) and one wallet he funded (`GfoFSM…`). About 54 TAO has gone
in, almost all from `FH9zKY…` (43.05 TAO on 1 Oct) and `cKR3xq…` (9.60 TAO on 3 Oct).

### Deploy log (newest first)

Every deploy below was served on the first poll after `railway up --ci` unless it says otherwise. Bug history
items carry the detail.
- **7 Oct** `e33b99e` (item 43 is `c445a46`; the daily history to 6 Oct), `stake.js?v=b6c4271f`,
  `stake.css?v=34b30b81`, at Craig's go-ahead. `npm test` passed; page runs A, B, C and E passed, and run F passed
  everything up to the Chutes card's fee quote ("Failed to fetch", as on 5 Oct). Served within two polls; the live
  `stake.js` hashes to `b6c4271f…`. `test:live` all passed.
- **5 Oct** `33609bb`, `stake.js?v=2771a2fd` (built in `b201f16`), at Craig's go-ahead: item 42's copy and the
  daily history to 4 Oct. `npm test` passed; page runs B and C passed, and run F passed every copy and holdings
  quote check before Bittensor's public RPC failed it on the Chutes card. `test:live` all passed (35 checks,
  history 0.8 days old).
- **2 Oct** `7f2f93c` (Cursor), `stake.js?v=fd7a03ad`: item 41. Served before it was pushed or recorded here;
  pushed and recorded on 4 Oct.
- **2 Oct** `bbcc861` (Cursor): item 40. Not recorded here at the time.
- **1 Oct** `24de4e1`, `stake.js?v=10e815f0`, `stake.css?v=50bdc3d0`: item 39. `test:live` all passed.
- **1 Oct** `13a64c8`, `stake.js?v=3d1eb62c`, `return.js?v=cc30346f`: item 38, the $SOLTAO holder discount.
- **30 Sep** `29cca29` (`stake.js?v=e3bec6b6`, `stake.css?v=1c83d7a1`): item 37. `5738c89`: item 36 (copy only).
  `754e8a1` (`stake.js?v=fb9b5ffc`, `return.js?v=9d4c32fb`): item 35. `b8bdaf2` (`stake.js?v=b8533f54`): item 34.
  `bd1ad57` (`stake.js?v=f5b87523`, `stake.css?v=25a3abdb`, `return.js?v=7ac428cd`): items 32–33.
- **29 Sep** `fc4b204` (`stake.js?v=a683574c`): item 31. `830ac26` (`stake.js?v=629349d7`): items 29–30; `npm test`
  and page runs A, A2 and C passed, and `test:live`'s two failures were Bittensor's public RPC busy on the subnet-64
  card. `bf510de`: items 25–28 (profiles, trading, the 0.25% fee), merged from `stake-trading`.
- **25 Sep** `d50a180` (`stake.js?v=d20813dc`): item 21 and the `31cafeb` polish; `npm test`, page runs A, E and F,
  and `test:live` (28 checks) passed. `1e3c803` (`stake.js?v=3f2ee7a4`): the front page redirects to `/stake/`, the
  board moves to `/board/`, nginx `absolute_redirect off`. `77a17cb` (`stake.js?v=77617c90`, `return.js?v=a211b567`):
  the Solana RPC back on PublicNode after Helius began answering 403.
- **24 Sep** `477bde3` (`stake.js?v=cd93f703`, `return.js?v=c15e5834`): **`CONFIG.returnLive` true**, at Craig's
  explicit request before any real-funds run (wallets refuse the sign-in on localhost, since the message names
  soltao.xyz). `ad1161c` (`stake.js?v=1e178c2d`): item 15. `9f22575` (`stake.js?v=d8f02947`): item 14. `994f394`
  (`stake.js?v=412be73a`, Craig: "deploy once you are happy"): the review, Codex P1 and roast fixes; `test:live`
  23/23. `292b68b`: item 10.
- **23–24 Sep** three rounds: see "Historical" at the end. An old header warned about an unreleased CSP fix; that
  was resolved and confirmed from inside the live page (bug history item 7).

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
  subnet directory. The return and the stake moves are open where `RETURN_OPEN` (local hosts, or
  `CONFIG.returnLive`, which has been true since 24 Sep 2026).
- `tools/stake/src/stake_moves.js` + `src/settle.js` — unstake / re-stake from the coldkey (item 13)
  and the shared settling of a signed coldkey extrinsic.
- `tools/stake/src/payments.js` — "Top up Chutes" (item 18): free TAO from the coldkey to a pasted
  Chutes payment address, signed, sealed (label "chutes-pay") and settled like a stake move. Gated by
  `CONFIG.chutesLive` (false) on soltao.xyz; open on local hosts.
- `tools/stake/src/subnet_profile.js` — the arithmetic behind a subnet profile (item 25): ranges, changes,
  deregistration standing, chart geometry. `stake/subnet-profiles.json` holds the summaries and
  `stake/history/` the daily history (`npm run history`).
- `tools/stake/src/prices.js` — display-only USD prices from Dexscreener for the review.
- `tools/stake/src/fit.js` — how much of an unstake's freed TAO a chained return can send (item 15).
- `tools/stake/usage.mjs` — `npm run usage`: completed routes counted on-chain from the fee wallet.
- `tools/stake/src/route.js` — the 4-step Bittensor route logic (unwrap/stake/handover/sweep) for
  the forward direction, now netuid-aware (stakes and hands over on whichever subnet the user
  picked, root by default), including the stake-refusal fallback.
- `tools/stake/src/solana.js` — the LayerZero OFT bridge transaction + fee transfer + gas drop + priority fee.
- `tools/stake/src/confirm.js` — wait for the Solana signature. A lagged RPC is `uncertain`, never
  "nothing was sent"; `mayForgetPending` refuses Forget while the signature might still land.
- `tools/stake/src/evm.js` — Bittensor RPC calls, retry/backoff, receipt polling.
- `tools/stake/src/bittensor.js` — precompile reads (delegate, stake, balance, wTAO, address map, metagraph).
- `tools/stake/src/config.js` — addresses, the soltao fee wallet
  (`BgGFMbwUtKLifQYZogbDorEXTXYp3UKVAZSH41xQ72Na`) and Bittensor fee coldkey. `solanaRpc` is
  PublicNode (`https://solana-rpc.publicnode.com`) after Helius began answering 403 on 25 Sep 2026.
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
- The return direction in the page (`app.js`) opens where `RETURN_OPEN`: local hosts, or
  `CONFIG.returnLive`. **It is true** since 24 Sep 2026; a real-funds return landed the same day
  (bug history item 17). A subnet Unstake, the return after it and the batched Bittensor fee carried real
  funds on 1 Oct 2026 (item 42). Move and Claim have not.
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
  of `npm test`) and `subnet_live.test.mjs` (read-only mainnet, `npm run test:subnet:live`), plus
  `confirm.test.mjs` (mocked Solana confirm/forget, part of `npm test`).
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
0. `cd tools/stake && npm run history` — refreshes the subnet charts' daily history in `stake/history/`
   (item 25). Reads only the days since the last run.
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
   deployed bundle, the return toggle is enabled (`CONFIG.returnLive`), and there are zero console or CSP errors on
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
    - Open before `returnLive`: one small real-funds return with Craig's approval. Arrival detection
      is balance-based, so another deposit to the same wallet in that window could be mistaken for
      it. (Unstaking is item 13; a reverted send now offers "Send it again", item 15.)

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
    action's gating, quote and limits; not confirmed). Since item 15, run F also answers the StakeInfo
    runtime call with the chain's real reply for subnet 1's owner, so Unstake is quoted in the browser
    too (still never confirmed). No real-funds move yet.

14. **Subnet directory (Milestone 5), 24 Sep 2026.** "Browse subnets" beside the subnet field lists
    all subnets from `subnetInfoRuntimeApi.getAllDynamicInfo` (`subnetDirectory()` in `substrate.js`,
    through the Bittensor-side bundle, on request, cached 5 minutes): name and symbol as registered
    (stored as `Vec<Compact<u8>>`, so decoded from the plain values, not raw bytes), the spot price
    implied by the pool's reserves (subnet 1: 0.006818 TAO per Alpha, within 1 rao of the swap
    runtime API) and the TAO in the pool. Search by name, symbol or number; sort by subnet number or
    by TAO in the pool (root left out: it has no pool), with the rule and read time stated on the
    page and names labelled as not endorsements. "Use" fills the subnet field and runs the usual
    check. Not live-gated: it only reads. Note it loads `return.js` (~800 KB) when opened.

15. **Polish before the real-funds runs, 24 Sep 2026.**
    - *Unstake, then return.* An Unstake in the holdings view offers "Then bring the TAO this frees
      back to my Solana wallet" (off by default, hidden while an earlier return is unfinished). When
      ticked, the quote adds the live LayerZero fee before anything is signed. After the unstake lands,
      `returnAfterUnstake()` in `app.js` re-reads the free balance and sends what the unstake freed
      (`freed` from `runStakeMove`, net of its fee), shrunk by `fitReturnAmount()` (`src/fit.js`) until
      the return's own costs leave 0.001 TAO free for later fees; then it switches to the return
      direction and runs the normal, checkpointed return, with the tracker's "Unstake" row marked done.
      The choice is saved with the stake-move record, so a resumed unstake still chains. If the unstake
      is refused on price, nothing is returned. Tests: `stake_moves.test.mjs` (freed amount; four
      fitting cases), `page.test.mjs` run F (offered, off by default, priced; not confirmed).
    - *A reverted send.* It used to stop the return on every sign-in with no way forward.
      `finishFreeReturn({ retryReverted: true })` now marks it dead and carries on from chain state,
      which re-quotes and reuses the wTAO still on transit (no second wrap). The page shows "Send it
      again" with a link to the refused transaction; it never retries by itself, since a lasting cause
      would spend gas each time. Test: `return_route.test.mjs` (retry sends once, no new wrap; a later
      resume sends nothing).
    - *Directory emissions.* A "TAO added per day" column and sort: `taoInEmission` from
      `getAllDynamicInfo` (the TAO the chain put into that pool in the last block) times 7,200 blocks,
      labelled as that on the page. Read 24 Sep 2026: all pools together 0.161 TAO per block; subnet 1
      63,114 rao per block (0.45 TAO a day). Validator take stays in the picker: it is per validator,
      not per subnet.

16. **"Finish it" did nothing: a reaped transit account replayed its own old transaction (24 Sep
    2026, first real-funds use with the return live, deployed as `6b55d72`).** Craig ran two "Just
    deliver it" routes. The first (0.002 TAO) unwrapped (nonce 0) and swept with `transferAll(coldkey,
    false)` (nonce 1, `0xec3c44…`), which emptied the transit account; Bittensor reaped it and its EVM
    nonce went back to 0. The second (0.01124 TAO) unwrapped at nonce 0 again, then its sweep at nonce 1
    was byte-for-byte the first route's sweep (same key, same coldkey, same 45,000 gas, same flat 5 gwei,
    deterministic signing). The node called it "already known", `waitMined` found the OLD receipt, the
    page reported success, and 0.01214 TAO stayed on transit; every "Finish it" repeated this. Fix:
    `signTx()` (`evm.js`) now looks up a receipt for the hash it just signed; a receipt for a nonce not
    yet used can only be such a copy, so it re-signs with the gas limit one higher (up to 16 tries).
    Covers the forward route and the return (both sign through `signTx`). Test: `evm.test.mjs`.
    (a) and (b) closed by item 20: the sweep now keeps the transit account alive, so it is never
    reaped again. Before that: (a) the sweep's second argument was presumably keep-alive but
    unverified; (b) after a reap, anyone could re-broadcast an old transaction of this account at a
    reused nonce (an old addStake could stake transit TAO to an earlier route's hotkey).
    Still open: (c) `evm.test.mjs` sees the public RPC answer "already known" for a fresh, unfunded transaction
    from a random key, so "already known" is not proof a transaction is in the pool.

17. **First real-funds return to Solana: landed (24 Sep 2026).** After item 16's fix, "Finish it" swept
    the stuck 0.01214 TAO to the coldkey, then Craig returned 0.0025 TAO from the live page: wrap
    `0x9037e199…` and LayerZero send `0x92dcf3cb…` (native fee 0.002859118 TAO) at 10:29:12 UTC, to
    Solana wallet `3hfdqAw3…nAE3` (recipient decoded from the calldata, dstEid 30168). Delivered by
    Solana tx `2aC7Uv8A…` at 10:32:27 UTC, about 3 minutes 15 seconds later: the TAO account went from
    0.030002593 to 0.032502593, exactly the amount. The existing token account was used, so the
    first-time rent path is still unobserved. Still to do with real funds: unstake / stake moves.

18. **Top up Chutes (subnet 64) from the holdings view, 24 Sep 2026, built, not deployed, gated off
    in production (`CONFIG.chutesLive: false`).** Partnership groundwork (`docs/subnet-partnerships.md`).
    Free TAO in the derived coldkey gets a "Top up Chutes" action beside "Stake": paste the account's
    Chutes payment address (or arrive with `?chutes=5…`, which only pre-fills it), enter an amount,
    tick an acknowledgement, send. It is a `balances.transferAllowDeath` from the coldkey, batched with
    the tag below (`runPayment()` in `src/payments.js`, through `prepareCall`/`settleSigned`), never part of the
    route, so the route's own rule (it pays only the user's coldkey) is unchanged.
    - *What Chutes does with it* (read in `chutesai/chutes-api` at `3b5609f`, 3 Sep 2026): its payment
      watcher credits a `Balances.Transfer` to a user's payment address at the TAO price of that block
      and ignores anything under 0.01 TAO as dust (`DUST_THRESHOLD_RAO`), so the page refuses less.
      Its autostaker then stakes the TAO into SN64 and burns the Alpha. Chutes' own setup text: "The
      payment address accepts both TAO and subnet alpha tokens to top up your balance."
    - *The "via soltao" tag (added the same day):* each top-up is one `utility.batchAll` of the
      transfer and `system.remarkWithEvent("soltao.xyz:chutes-topup:v1")`, all or nothing
      (`paymentCall()`), so top-ups through soltao can be counted from the chain alone. Every one emits
      `System.Remarked` with hash `0x0f0d95b0ed710d56d26bcf41bea776f5ca2dee9f4de60b0995538a30fb321cc4`
      (blake2-256 of the tag; the runtime's `Hashing` is `BlakeTwo256`). The live runtime allows
      `batch_all` of these calls (it only refuses nested batches, `NoNestingCallFilter`, subtensor
      `923fd1f`). Chutes' watcher reads every event in the block, so the transfer inside the batch is
      credited as before. **Confirm on the real-funds run**: Chutes credits it, and the extrinsic
      shows the remark.
    - *Counting them:* `npm run usage:chutes -- --from <block>` (`chutes_usage.mjs`, read-only). It
      reads each block's raw `System.Events` in batched JSON-RPC calls (50 blocks a call), searches
      the bytes for the tag hash, and decodes only matching blocks (`src/topups.js`: the Remarked
      event, the Transfer from the same sender in the same extrinsic, ExtrinsicSuccess). Totals count
      completed top-ups at or above 0.01 TAO, with payer wallets and Chutes accounts. Progress and
      finds are kept in `tools/stake/.chutes-usage.json` (gitignored), so later runs read only new
      blocks; the first run needs `--from`, the block the feature went live at. Defaults to
      `https://archive.chain.opentensor.ai`, since old blocks' events need an archive node (the lite
      node prunes them); `--rpc` overrides. Waits out 429s. Tests: `test/topups.test.mjs` (in
      `npm test`). **Never run against a real node yet** (the building session had no network): the
      first real run should be checked against the real-funds top-up's block.
    - *Checks:* SS58 with checksum, not the wallet's own address, at least 0.01 TAO, at most the free
      balance less the 0.01 TAO reserve, and the live network fee must fit. The page cannot know an
      address is Chutes'; it says so, and the send button stays shut until that is acknowledged.
    - *Tests:* `test/payments.test.mjs` (in `npm test`; resumes never pay twice, pending transfers are
      finished not re-signed, dust/over-balance/own-address refused before signing, a failed dispatch
      is reported as not made). `test/page.test.mjs` run F now covers the panel up to an enabled
      send (not confirmed). The page test was first run on 25 Sep 2026, when this merged into
      `main`: runs A–E passed, and run F (28 checks, the panel included) passed after its payee
      address was corrected (it had copied `derive.test`'s deliberate checksum typo, `…KutQZ`).
    - *Before `chutesLive: true`:* one small real-funds top-up (≥0.01 TAO, say 0.02) to a real Chutes
      account from the live page, confirming Chutes credits it, with Craig's approval. Then flip the
      flag, build, deploy.

19. **Staking is the front page; plainer wording (24 Sep 2026, not deployed).** After the product roast
    ("the product is hidden behind a warning"): `soltao.xyz/` now answers 302 → `/stake/` (nginx
    `location = /`; `_redirects` for Cloudflare/Netlify; the root `index.html` is a meta-refresh fallback
    for GitHub Pages), and the board moved to `/board/` (`board/index.html`, assets via `../`, `app.js`
    fetches `pairs.json` relative to itself, `tools/fallback.js` and the Dockerfile follow it, canonical
    and `og:url` now `/board/`). The stake page itself did not move, so its relative asset paths and the
    SIWS message (`uri: https://soltao.xyz/stake/`, unchanged) are untouched: **every user's derived
    wallet is the same as before.** Copy: each step says one short thing; the long explanations are kept,
    lightly reworded in places, behind `<details class="info">` toggles (an "i" icon, native HTML, no script), and
    the trust section is collapsed. Every element id is unchanged. Checked: the real nginx config serves
    `/` 302 (query kept), `/board` 301, `/board/`, `/stake/`, `/pairs.json` 200; headless loads of
    `/`, `/stake/` (desktop and phone) and `/board/` show no errors, and the board loads `pairs.json`.
    `test/live.test.mjs` now checks the redirect and the board at `/board/`.

20. **Second review pass, 25 Sep 2026 (built, not deployed).** Re-run report (same artifact as the
    first roast): 61/110. Fixed from it:
    - *The transit account is never reaped.* The sweep sends `transferAll(coldkey, true)`. Verified in
      subtensor's `precompiles/src/balance_transfer.rs`: the bool is `pallet_balances::transfer_all`'s
      `keep_alive`. The live existential deposit is 500 rao (`balances.existentialDeposit`, read
      25 Sep), left on the transit account once per wallet; later routes reuse it. The EVM balance
      reports only what is spendable, so it reads 0 wei there, and `sweepFloor` is unaffected.
      `test:mainnet` asserts exactly 500 rao is kept (deliver plan) and every rao is accounted for;
      `route.test.mjs`'s mock models the flag. An account reaped before this (Craig's) is simply
      kept alive from its next sweep on.
    - *`npm run usage` no longer undercounts silently.* PublicNode returned only 8 signatures for the
      fee wallet (oldest 24 Sep 07:35 UTC), so it reported 2 routes, not 3. The script now reads
      `api.mainnet-beta.solana.com` by default (958 signatures, full history), takes `--rpc`, and
      exits 2 when history ends after `--since` or a transaction cannot be read. Count on 25 Sep:
      3 routes from 2 wallets, 0.0135 SOL, all Craig's tests.
    - *Fees as a share of the amount.* The review shows "Fees, as a share of what you send" in both
      directions (forward: SOL fees in USD over the TAO in USD, both from Dexscreener; return: the
      bridge fee plus the funding transfer fee over the amount, in TAO), and from 10% a warning that
      the fees are mostly flat. `showShare()` in `app.js`; page-test assertions in runs B and F.
    - *A way in from plain SOL.* A connected wallet with no canonical TAO gets a Jupiter SOL→TAO link
      by mint, the mint's short form to check, and "Check again". Page-test assertion in run A.

21. **Root rewards and subnet pages, 25 Sep 2026 (built, not deployed).** For the Colosseum pitch
    ("earn staking yield without leaving your Solana wallet"), which was not true for root until this:
    - *Root rewards are not in the root stake.* On the live runtime (spec 470, read 25 Sep) root
      dividends accrue as the coldkey's shares of each validator's basket, an escrowed fund of subnet
      Alpha, and **nothing claims them automatically**: subtensor's `block_step.rs` says "Beta baskets are
      redeemed on-demand by stakers via `claim_root`; no auto-swap". So a root stake made through soltao
      earned rewards the page could neither show nor collect. `claim_root_with_hotkey(hotkey)` sells the
      coldkey's slice and stakes the TAO on root under the same hotkey (`claim_root.rs`, verified). A claim
      paying under `RootClaimableThreshold(0)` (500,000 rao = 0.0005 TAO, read 25 Sep) is accepted,
      charged, and pays nothing.
    - *The holdings view shows and claims them.* `rootRewards()` (`BetaBasketRuntimeApi
      .get_root_basket_positions`, checked against three real stakers: per-validator payouts match
      `get_basket_payout`), `rootClaimMinRao()`, `quoteRootClaim()` and `prepareRootClaim()` in
      `substrate.js`; `runRootClaim()` in `stake_moves.js` (sign, seal, submit, settle like a stake move;
      outcome judged by the root stake under that hotkey rising). Each root row shows "+ X in rewards to
      claim" and a Claim button; rewards with a validator the wallet no longer stakes to get their own
      row; the total counts them; the note says where each kind of yield lands. Under the minimum the
      Claim is explained and not offered. The claim's fee is large: `paymentInfo` put it at about
      0.00825 TAO on 25 Sep (its declared weight covers a scan of the whole basket; the chain charges
      the work actually done, which can be less, per subtensor's `docs/tx/claim-root.mdx`). So the
      quote warns when the reserved fee is at least the payout. Tests: four cases in `stake_moves.test.mjs`; call shape, basket
      reads and the minimum in `polkadot.test.mjs` (`test:return:metadata`); page-test run F serves a
      0.003 TAO basket position and checks the row, the note and the priced Claim (nothing signed).
    - *Subnet pages.* `/stake/?netuid=N` (optionally `&hotkey=5…`) opens with a card for that subnet:
      its registered name, symbol, description, website and GitHub (https only, `rel=noopener
      nofollow`), Alpha price, TAO in its pool, TAO added per day, and the linked validator, all from
      the directory's SubnetInfo read (shared cache), labelled as the owner's words, not endorsed. The
      tab title names the subnet. Page-test run E (a subnet 1 link) and run A (no card on the plain page).
      Not built: a per-subnet "TAO staked through soltao" total. The Solana transaction does not record
      the netuid (1,184 of 1,232 bytes used, so a memo would barely fit), and the Bittensor side needs an
      indexer; `evm.taostats.io` answers a Blockscout API, so a counting script over the transit
      accounts' transactions is the likely route.

22. **"Did it land?" now trusts the chain's own event, not just a balance moving, 25 Sep 2026 (built,
    not deployed).** Every action that signs an extrinsic — a stake move, a root claim, a Chutes
    top-up — used to decide whether it landed by reading a balance or stake before and after. That
    reading can be fooled: TAO arriving from anywhere else in the same block looks identical to the
    move succeeding, or masks a real failure, and either way a user closing the tab and reopening
    could sign the same payment twice.
    - `extrinsicOutcome(id, fromBlock)` (`substrate.js`) reads the block the extrinsic actually landed
      in, finds it by hash, and reads its own `System.ExtrinsicSuccess` / `ExtrinsicFailed` event —
      the runtime's own verdict, not an inference from state. It scans from the block it was signed at
      (recorded now in every `prepareCall` record as `fromBlock`) to the end of its mortal era (64
      blocks), and returns `null`, not a guess, if the hash isn't found there or the node has pruned
      those blocks' events (a public lite node keeps only recent history).
    - `dispatchResult()` (`settle.js`) wraps that lookup; `runStakeMove`, `runRootClaim` and
      `runPayment` now call it first and use it as the verdict whenever it answers, falling back to
      the balance/stake comparison only when it comes back `null`. A root claim under the minimum
      still needs the state check (a successful call can pay nothing), so the event only rules a
      *failed* claim out there; everywhere else it decides outright.
    - Tests: `stake_moves.test.mjs` and `payments.test.mjs` each gained a case where TAO arrives in
      the same block as the move (masking a real success or a real failure) and a case with events
      switched off, so the balance fallback is exercised too. `npm test` all green.
    - Verified against the live chain, not just the simulated one: `extrinsicOutcome` on a real
      recent extrinsic's hash returned "success" matching its actual `ExtrinsicSuccess` event, and on
      a made-up hash returned `null` rather than a false positive.
    - Not yet run against a real signed transaction from the live page (needs no real funds to build,
      but the actual proof is a live stake move or Chutes top-up settling through this path). Do that
      alongside the next real-funds test.

23. **The first route from a new wallet fell under the staking minimum, 25-26 Sep 2026 (built, not
    deployed).** At 15:12 UTC on 25 Sep, `GfoFSMtQ3oYbY529swRJ84KdGhesC84VKfCRRySFXFP9` (not one of
    Craig's two known wallets; ownership unconfirmed) bought TAO on Jupiter at 15:08 and sent 0.01661 TAO
    (about $5.02) with "Just deliver it": Solana `2iWArJQT…`, LayerZero delivered at 15:13, transit
    `0xc3e0f4f1…64c2` unwrapped (nonce 0) and swept with `transferAll(coldkey, true)` (nonce 1, the
    first real-chain run of item 20's keep-alive sweep). Coldkey `5D5CVnJdhiBFPuZcmPWGUdM4DAs4pRQ9BoSgGrYPQuZtXVbK`
    holds 0.017198 TAO free, no stake. It paid about $2.25 of fees (45%). The staking minimum (about
    0.044 TAO) only appeared after an amount was typed. `npm run usage` now counts 4 routes from 3 wallets.
    Craig (26 Sep): GfoFSM is **not his**; it belongs to someone he has been talking to, and he sent
    them the funds to use the route (at least 0.033 SOL from `3hfdqA…` at 02:16 UTC on 26 Sep;
    `5PsB7jYt…` also sent 0.03 TAO and 0.05 SOL at 01:35). So this is the first route by someone other
    than Craig, but a hand-held, Craig-funded one: evidence that another person can complete the flow,
    not of demand or of anyone paying their own way. By 02:20 GfoFSM held 0.040509 TAO, just under the
    0.044 minimum at the default 0.01 reserve; no second route had landed.
    Craig also tried to stake and ran into not having enough. Fixed:
    - *The minimum up front.* `stakeMinRao()` (the route's `minStakeAmount` at today's gas price and the
      reserve on screen). Connecting a wallet with no TAO now says how much staking needs (with USD) next
      to the Jupiter link; a wallet holding less than that is told so, with the link and "Check again";
      step 3 states it (`#amount-hint`) before anything is typed. The gas price is read on connect for this.
    - *A stronger fee warning.* `showShare()` now says the fees and the amount in money (forward) or TAO
      (return), and from what amount the same fees fall under 10%. From 25% (`SHARE_ACK_PCT`) it turns
      red and signing stays shut until "I accept fees of about N% of what I send" is ticked, which holds
      only for that exact amount (`state.shareAckAmount`); `send()` refuses while it is not. The forward
      quote now awaits the prices before it opens signing. A failed price feed does not block.
    - *Small balances in the holdings view.* Free TAO under 0.03 (0.02 to stake plus 0.01 kept for fees)
      gets a line saying what staking here needs, that later routes land in the same wallet, and that it
      can go back to Solana. A holdings stake under 0.02 TAO is now refused before signing (it was not).
    - `minStakeRao`'s comment corrected: the chain's `NominatorMinRequiredStake` read 0.01 TAO on 26 Sep,
      so 0.02 is twice it, not equal to it.
    - Tests: page-test runs A (the minimum in the no-TAO note), B (the step 3 hint), C (0.01 TAO: 73%,
      signing shut, opens on accepting, 0.1 TAO needs nothing), F (a holdings stake under 0.02 refused).
      The small-free holdings line has no page test (run F's wallet holds 2 TAO).

24. **A SOLTAO → TAO swap in step 1: built, then removed on 28 Sep 2026 at Craig's request** ("remove
    soltao token payments"). It swapped straight against SOLTAO's Raydium CPMM pool, and its quote matched the
    program to the unit. The code is in commit `0db1758` if it is ever wanted again. The page no longer
    mentions SOLTAO outside the footer disclosure and the header note.

25. **Subnet profiles: what a subnet does, its price chart, the numbers, the risks, 28 Sep 2026 (built,
    not deployed).** Craig asked that people "see everything so they can make informed decisions when
    trading alpha".
    - *Where it shows:* on a subnet's page (`?netuid=N`, under the existing card) and in step 3 as soon as
      a subnet is chosen ("About subnet N", a `<details>` open by default). Holdings positions get a
      "Profile" button that opens it in step 3.
    - *What it shows:*
      - soltao's one- or two-sentence summary of what the subnet provides, with its source link and the
        read date, and "soltao has not used or tested it". Where there is none, the owner's on-chain line
        is shown, labelled as theirs.
      - A price chart in TAO (7, 30 or 90 days; the change over the range; a crosshair by pointer or
        arrow keys; the same prices in a table).
      - Price changes over 7, 30 and 90 days.
      - TAO traded in the pool over the last full day.
      - All its Alpha at today's price.
      - A 10 TAO buy quoted from the chain's own swap simulation, with fee and price impact.
      - The registration date and age.
      - Where it stands for deregistration.
      - A risk box.
    - *Summaries:* `stake/subnet-profiles.json` covers the 21 subnets with the most TAO in their pools on 28
      Sep 2026, minus subnet 5 (Hone), whose sources disagree. Each was written from that subnet's own
      registered site, docs or GitHub, read that day. It is served from soltao's origin and can be
      edited without a build.
    - *History:* `npm run history` (`history.mjs`) reads one block a day for 90 days (plus one earlier day
      for volume) from `wss://archive.chain.opentensor.ai`.
      - Each day is one `queryMulti` of SubnetTAO, SubnetAlphaIn, SubnetAlphaOut and SubnetVolume for every
        netuid, plus the timestamp. Newest days are read first.
      - It writes `stake/history/<netuid>.json` and `index.json`, cached in `.history-cache.json`
        (gitignored), so a rerun reads only new days.
      - The archive meters "historical work" (-32004 `budget_exhausted`). The script waits that out as
        long as it takes and paces 1.5 s between days. The first full run took over an hour; later runs
        are a few new days.
      - `WRITE_ONLY=1` writes the files from the cache without reading.
      - Points from before a netuid's current registration are dropped. The page also drops the lot if
        the netuid re-registered since.
    - *Facts behind the copy, all checked:*
      - The price is the pool ratio, TAO in ÷ Alpha in. It equalled `swapRuntimeApi.currentAlphaPrice` to
        the rao on six subnets on 28 Sep.
      - Volume is SubnetVolume's daily change. It counts TAO in on buys plus TAO out on sells
        (`staking/stake_utils.rs`, subtensor `c004ceb`).
      - Deregistration removes the non-immune subnet with the lowest *moving* price; the earliest
        registration loses a tie (`coinbase/root.rs get_network_to_prune`). The immunity period is
        864,000 blocks (about 100 days). There are 128 slots, all taken on 28 Sep.
      - On deregistration, stakers are paid from the pool's TAO, split by Alpha value, and newer subnets
        also count Alpha in the pool (`staking/remove_stake.rs destroy_alpha_in_out_stakes`). Hence "can
        be well under the Alpha's market value".
    - *New reads (return bundle):* `chainInfo()` (head, immunity, subnet limit, total networks) and
      `simulateSwap()` (`simSwapTaoForAlpha` / `simSwapAlphaForTao`). The directory rows now carry Alpha
      in and out, the registration block, the moving price bits and Discord.
    - *Chart:* inline SVG built with DOM calls. It is CSP-clean: classes only, plus CSSOM for the tooltip
      position. It follows the dataviz rules: a 2px line with a 10% wash, an end dot ringed in the
      surface colour, hairline grid, no legend for one series, text in ink tokens, a table view and
      keyboard readout. The line colour, `--green` on `--panel`, passes the 3:1 contrast check.
    - *Tests:* `test/subnet_profile.test.mjs` (in `npm test`) and page-test run H. Run H covers the
      summary with its source, the ranges, the aria label, every stat, the simulated buy, the keyboard
      readout, the table, no overflow at 320 and 768px, and the step 3 box opening for 51 and closing
      for root.
    - *Deploy step added:* run `npm run history` before `npm run build` and commit `stake/history/`, or the
      charts show old history; the page says when it is over 3 days old.

26. **Alpha trading from the holdings view, 28 Sep 2026 (built, not deployed; gated with the return).**
    - *Exact quotes:* Stake (buy) and Unstake (sell) are now quoted from the chain's own swap simulation:
      what it gets, the pool fee and the price impact, instead of spot price × amount.
    - *Size warning:* from 1% simulated impact the quote warns that the chain may refuse the trade at
      the 2% limit, since a trade moves the pool's price about twice its average impact. On 28 Sep,
      moving a real 273,906 Alpha subnet-1 position showed 7.33%.
    - *Move:* a new button on every position moves it to step 3's checked subnet and validator in one
      extrinsic (`runStakeSwitch` in `src/stake_moves.js`).
      - On the same subnet it is `move_stake`: a validator switch, no swap and no limit.
      - Across subnets it is `move_stake_limit(origin_hotkey, destination_hotkey, origin_netuid,
        destination_netuid, amount, limit, false)`. The limit is the origin price ÷ destination price in
        rao, less 2%, which is the ratio `get_max_amount_move` compares (`staking/move_stake.rs`). Root
        counts as 1 TAO.
      - The chain charges one pool fee on a move; the destination leg's fee is waived.
      - A move of less than 0.02 TAO worth is refused before signing, because the chain would leave it as
        free TAO rather than restake it.
      - Signed, sealed, submitted and settled like a stake move, with resume. The outcome is the
        extrinsic's own event, or failing that the origin shrinking and the destination growing.
    - *Verified:*
      - Mocked chain (`test/stake_moves.test.mjs`): lands once, a price past the limit is refused whole,
        a same-subnet move has no limit, bad inputs are refused before signing, a page closed after
        submitting finishes on resume without a second move, and the no-event fallback works.
      - Live runtime (`test:return:metadata`, `test:return:live`): the move calls' argument order, and
        both signed moves decode to the intended call.
      - Page-test run F: the Move button, the same-subnet quote, the move-to-root quote and the impact
        warning.
      - **Not yet with real funds.** (4 Oct 2026: Unstake now has, item 42. Move still has not.)

27. **Validators' 30-day record, directory changes, and the review's Alpha quote, 28 Sep 2026 (built, not
    deployed).**
    - *What each validator paid its stakers.* `npm run history` now also reads every validator-permit
      holder on every subnet (1,432 on 28 Sep) at the latest daily block and 30 days before. The measure
      is one share of its stake pool: TotalHotkeyAlpha ÷ TotalHotkeySharesV2 (else V1), the vault
      research's measure. The change is what it passed on after its take, in the subnet's Alpha. Adding
      or removing stake mints or burns shares at the current value, so only earnings move it.
      - A pool whose `AlphaSharePoolEpoch` changed in the window was reset and gets no figure. That
        storage did not exist 30 days ago; it reads as 0 there.
      - Output: `stake/history/validators/<netuid>.json`, `[hotkey, bps | null, stake in Alpha]`.
      - On 28 Sep, 212 of 1,301 validators with stake paid their stakers nothing over 30 days, and 96 had
        reset pools. Subnet 64's paid 2.3–2.8%.
    - *Where it shows:*
      - A "Paid stakers, 30 days" column in step 3's validator list, with its rule stated.
      - A line on each subnet position in the holdings: "paid stakers X% in 30 days; the best here Y%".
        The note adds that a same-subnet Move swaps nothing. This is the "validator hygiene" step agreed
        on 28 Sep.
      - A profile stat: the middle and best validator, and how many paid nothing.
    - *Directory:* "Browse subnets" has 7-day and 30-day change columns (today's price against the daily
      readings in `stake/history/summary.json`), a 30-day sparkline, and a sort by 7-day change with its
      rule stated: "a past move says nothing about the next one".
    - *Forward review:* a subnet stake from Solana now adds what it buys today from the chain's own
      simulation ("Today that buys about X Alpha: a pool fee…"), plus the size warning when it applies.
    - *Tests:* page-test runs E (picker column and rule; directory change columns, sparklines and sort),
      F (holdings line) and H (profile stat), and run B (review quote).

28. **soltao's fee on everything: 0.25%, 29 Sep 2026.** Craig's decision: "everything carries the
    protocol fee". It is 0.25% of what an action moves (`src/fees.js`, `CONFIG.fee`), and it replaces the
    flat 0.003 SOL per route.
    - *Route from Solana:* paid in SOL, the same plain transfer to `CONFIG.fee.wallet` in the same
      transaction, never less than 0.0035 SOL.
      - The TAO sent is valued at the on-chain price of the deepest TAO/SOL pool, Orca Whirlpool
        `BM1Kpng…BMC`, about $196k deep (`src/orca.js`). The price is decoded from the pool's
        `sqrt_price`; the layout was checked against the live pool on 28 Sep, with wSOL as mint A and
        TAO as mint B.
      - It is read with the bridge quote. The review shows the fee, the rule, the price used and where
        it goes. `send()` signs exactly the fee the review showed.
      - If the pool can't be read, signing stays shut instead of guessing.
      - No TAO account is needed for the fee wallet.
      - `npm run usage` now counts any fee transfer of at least 0.003 SOL alongside the OFT program.
    - *Bittensor actions:* paid in TAO to `CONFIG.fee.bittensor`, `5Cvj3sq8…QG94`. That is Craig's
      address; checked on 28 Sep as a valid SS58 coldkey, not a hotkey, holding 0.0066 TAO. The floor is
      0.001 TAO.
      - `withFee()` in `src/substrate.js` sends the action and a `balances.transferKeepAlive(fee)` as one
        `utility.batchAll`, so a refused action (a price limit, say) pays no fee. The runtime's call
        filter only refuses nested batches (`NoNestingCallFilter`, subtensor `c004ceb`), so this is
        allowed.
      - Stake: the fee is on the TAO staked, and "all" leaves room for it.
      - Unstake: on the TAO value at the pool price, paid from what it frees. It is refused if it would
        free no more than the fee.
      - Move: on the origin value, paid from free TAO. It is refused before signing if free TAO can't
        cover it.
      - Root claims: on the payout, from free TAO.
      - Chutes top-ups: on the amount, as the third call in its existing batch.
      - Return to Solana: on the amount, riding once in the batch of the first funding transfer
        (`feePaid` in its progress), so a top-up funding or a resume never charges it twice.
      - Every quote states the fee, its rule and that a refused action pays none. The return review has a
        "soltao fee (0.25%, TAO)" row.
    - *Page copy:* the hero trust line, "who runs this", the return's fee note and the footer now describe
      the 0.25% fee.
    - *Verified:*
      - Route: a mainnet simulation of the route with the percentage fee (`test/solana.test.mjs`: 0.0035
        SOL floor on 0.1 TAO, 1,184 of 1,232 bytes, 506k CU).
      - Page-test run C decodes the transaction handed to the wallet: the fee signed equals the fee the
        review showed.
      - Mocked chains: fees on every stake move, claim, top-up and return. The return charges once,
        including with a top-up funding and after a page closed mid-funding.
      - Live runtime: a stake move with the fee signs and decodes as `utility.batchAll([removeStakeLimit,
        transferKeepAlive(5Cvj…, fee)])`, and the runtime prices the batch.
      - Page-test run F: every holdings quote states the fee.
      - **The batched Bittensor fee has not carried real funds yet.** (It has since: two 0.001 TAO fees landed
        at `5Cvj…` on 1 Oct 2026, item 42.)
    - *Deploy:* merged from `stake-trading`, together with items 24 (removed), 25, 26 and 27.

29. **An unconfirmed Solana send must not unlock a second send (29 Sep 2026).**
    After the wallet signs, `confirm()` used to treat a blockhash past `lastValidBlockHeight` as
    "expired before it landed: nothing was sent, try again", clear the pending route, and re-enable
    Sign. If the RPC had only lagged, the first OFT send could still land and the user could sign a
    second. Fix: `src/confirm.js` returns `failed` only on a chain error, and `uncertain` when the
    deadline passes with no status. `send()` keeps the sealed pending route, waits for the bridge,
    and does not offer a second send. Forget is refused while the signature is processed/confirmed,
    while the RPC read fails, or while a missing record is younger than 3 minutes. Covered by
    `test/confirm.test.mjs` (in `npm test`). Bundled as `stake.js?v=629349d7`.

30. **First-time / core-loop copy (29 Sep 2026).** The roast's remaining UX lifts that do not need
    outside users: the hero and holdings name the way back; the review has a "To get it back" row
    (`#r-later`) with a live-quoted return later; a subnet `?netuid=` page says the same link is the
    way in and back; step 1 always offers Jupiter and tells people to keep the tab; step 2 says the
    signature is what later unstakes and sends TAO home; the board's stake CTA says 0.25%, not a
    "flat SOL fee". Holdings stay fetch-on-click (no extra RPC on sign-in). Chutes stays off.

31. **RPC fallbacks, confirm cap, honest arrival (29 Sep 2026).** Zero-cost engineering so the
    page survives a busy public RPC and does not lie about what it measured.
    - Bittensor reads walk `CONFIG.bittensorEvmRpcs` (lite, then archive). Measured 29 Sep 2026
      under Origin `https://soltao.xyz`: both answer `eth_chainId` and Substrate `system_health`
      with `access-control-allow-origin: *`. `getApi()` tries the same URLs, 30 s each. EVM
      `fetch` aborts at 20 s so a hung lite node actually reaches archive.
    - Solana reads try both PublicNode hostnames (`solana-rpc.publicnode.com`, then
      `solana.publicnode.com`). Same Origin probe: both return 200 with ACAO `*`.
      `api.mainnet-beta.solana.com` 403 "Access forbidden", Helius 403 on the lapsed plan.
      Listing those as fallbacks only delayed a failed read. Helius remains in both CSPs so
      restoring the plan is a one-line `solanaRpcs` change. Signed Solana sends never retry
      another URL. Umi quotes use the same 30 s `timedFetch` as `Connection`.
    - SIWS `domain` / `uri` are frozen to `soltao.xyz` / `https://soltao.xyz/stake/` (no caller
      override). The signature bytes are wiped after HKDF. Sign-in errors log name/message/code,
      not the wallet result object.
    - Holdings copy says Unstake / Move / Stake have been checked against Bittensor's runtime at
      zero cost and have not carried real funds through this page.
    - `assertReturnCreatesAta()` re-reads `enforcedOptions(30168,1)` and fails if 200,000 CU or
      2,039,280 lamports drop out of the wTAO contract.
    - `confirmSignature` returns `uncertain` after 120 s if height never advances; `processed` is
      still in-flight, never landed.
    - A finished return says the Solana TAO balance rose, and that LayerZero Scan is the bridge
      record. `#r-later` no longer quotes a stale 0.003 TAO.
    - `test:live` retries subnet 64 on a busy RPC and checks configured RPC origins against the live CSP.
    - Built as `stake.js?v=a683574c` / `return.js?v=7ac428cd`. Live as `fc4b204`.
      `test:live` all passed (both PublicNode hosts 200, archive CSP, holdings copy, subnet 64).
    - Chutes stays off. Still not done with real funds: Move, batched Bittensor fee, unstake, a
      subnet stake through the live page, first-time ATA.

32. **Quote errors, RPC parse proof, live ATA check (30 Sep 2026).** Zero-cost follow-up after item 31.
    - The forward review's Alpha quote (`quotePlanAlpha`) no longer swallows a failed `simulateSwap`:
      it appends that today's Alpha could not be quoted, and that the 2% limit still applies.
    - `evm.test.mjs` only treats `insufficient funds` as proof the public RPC parsed a fresh
      unfunded tx. `already known` retries with a new key/nonce (up to 4); it is not a pass.
    - The return review reads whether the connected Solana wallet already has a canonical TAO
      token account (`taoAccountExists`). First-time rent is still unobserved; the copy says so
      when the account is missing.
    - Live as `bd1ad57` with item 33, `stake.js?v=f5b87523`. `test:live` all passed.

33. **Copy and hit-target polish before deploy (30 Sep 2026).** Gate on items 31–32 going live.
    - Holdings: short prompt, disclosure in `#holdings-limits`. Holdings note no longer repeats the
      lawyerly runtime-checked sentence; it still says Unstake/Move/Stake/Claim have not carried
      real funds through this page.
    - Return review: amount stays on `#r-receive`; `#r-ata` is whether the Solana TAO account is
      already open. Arrival copy is shorter; reverse hops say "in your wallet".
    - 40px hit targets on `.btn-sm`, holdings/pick/range buttons, info summaries, wallet pill.
      Subnav/feed/social stay compact so the board topbar still fits "Stake route →".
      Review prose rows wrap (`.kv-prose`). An open "How it works" takes the full row.
      `prefers-reduced-motion` drops button and step transitions.
    - `evm.test` posts the unfunded parse check once (not through `rpc()` retries, which turned a
      first `insufficient funds` into `already known`).
    - Live as `bd1ad57` / `stake.js?v=f5b87523` / `stake.css?v=25a3abdb` / `return.js?v=7ac428cd`.
      Served on the first poll. `npm test`, page-test runs C and F, and `test:live` all passed.

34. **Confirm and forget stay on the primary Solana RPC (30 Sep 2026).** Review finding: mixed
    failover reads could pair height from one PublicNode host with status from the other.
    `createClients()` now exposes `primary`; `confirmSignature`, the pending-forget status read, and
    `getLatestBlockhash` for the signed OFT send use it. Signed sends were already bound to the first
    URL. Reads still walk the pool. Built as `stake.js?v=b8533f54`. CSS and `return.js` unchanged.
    Served on the first poll as `b8bdaf2`. `npm test` all passed. `test:live` matched the hash, CSP,
    return toggle, and subnet-1 checks; it then timed out waiting on Bittensor (hotkey-note / subnet
    64 navigation) — public RPC, not a missed deploy.

35. **Helius as a same-origin Solana fallback (30 Sep 2026).** Craig supplied a working mainnet
    Helius key. It is **not** in `config.js` or the bundle (the page is public). nginx on
    `soltao.xyz` proxies `POST /solana-rpc` to Helius with `HELIUS_API_KEY` from Railway. Only
    requests whose `Origin` is `https://soltao.xyz` are forwarded, so the path is not a public
    faucet. `solanaRpcs` is PublicNode, PublicNode's second host, then `https://soltao.xyz/solana-rpc`.
    Signed sends still never leave the first URL. Both CSPs list the proxy URL. The Helius plan is
    **free**, so it stays last and `npm run usage` does not use it (a full signature scan would burn
    the monthly credits). Pass `--rpc` if you explicitly want Helius for a count.
    Built as `stake.js?v=fb9b5ffc` / `return.js?v=9d4c32fb`. CSS unchanged. Live as `754e8a1`.
    Served on the first poll. `test:live` all passed, including `https://soltao.xyz/solana-rpc 200`
    from inside the page.

36. **Say real funds have moved; do not promo a subnet (30 Sep 2026).** A stranger completed a
    subnet stake through the live page (30 Sep 2026, Solana `FXNTL46d…`, `addStakeLimit` on netuid 4)
    and posted the route in public. Craig did not know them. Policy: subnets come to us; we do not
    feature one for clout. The stake page now says real funds have moved (hero trust line, who-runs,
    holdings disclosure). It still says Unstake, Move, Claim, and staking more from holdings have
    not. No subnet is named on the page. JS bundle unchanged (`stake.js?v=fb9b5ffc`). Live as `5738c89`
    on the first poll.

37. **Subnet browse is a tappable list (30 Sep 2026).** The first outside subnet staker (`@breakb0nes__`)
    typed the number themselves and said the mobile subnet picker was a wide table. Browse subnets
    is now one row per subnet: number, name, 7-day move, then price, pool, TAO added per day, and
    the 30-day move with its sparkline. Tapping the row fills the subnet field and runs the same
    check. Search and the four sort orders are unchanged. No subnet is featured. The row whose
    number matches the subnet field stays marked. Live as `29cca29` (`stake.js?v=e3bec6b6`,
    `stake.css?v=1c83d7a1`, `return.js` still `9d4c32fb`). A phone-width browser check showed the
    rows stacked with no sideways scroll; tapping subnet 2 filled the field and marked that row.
    Page-test run E passed. Served on the first load after `railway up --ci`.

38. **$SOLTAO holder discount on the 0.25% fee — written, not shipped (30 Sep 2026; polished 1 Oct).** Craig's decision,
    after rejecting a 1m–1.5m / 5m ladder as too cheap at this price. The percentage drops and the floors
    do not. 10 million $SOLTAO or more takes 25% off (0.1875%). 50 million or more takes half (0.125%).
    None is required. The balance is the connected Solana wallet's associated token account for mint
    `8P1XmDhz…vCn` (Token-2022), read with `getAccountInfo` when a fee is quoted and again before the
    signature. A failed read charges the full 0.25%. If the balance changed tier since the quote, the
    page shows the new fee and does not sign the old one. A second click during that re-read does not
    start a second sign, and a quote that moved (amount, price, or a newer return fee) is not signed.
    The return publishes its fee only after that quote is still current. An already-signed Bittensor
    action is not repriced on resume. The stake page (who-runs, fee note, footer) and the board's route
    callout say the discount. Built and live 1 Oct 2026 as commit `13a64c8`, `stake.js?v=3d1eb62c`,
    `return.js?v=cc30346f`. `npm test` passed. `test:live` matched the hash, the return bundle, CSP, and
    the return toggle. A page-test the same morning passed the fee quote and the who-runs sentence; its
    holdings run died on `lite.chain.opentensor.ai` answering the browser with no CORS header, the usual
    busy-RPC failure, before it reached the move quotes.

39. **Choosing a subnet opens its chart (1 Oct 2026).** Browse subnets sits above the steps, so the
    list is readable before sign-in. Tapping a row fills the subnet field and opens that subnet's
    summary, Alpha price chart, and pool figures above the list. Root gets a short note and no chart.
    Step 3 points at that panel instead of drawing the same profile twice. No subnet is featured.
    Live as `24de4e1` (`stake.js?v=10e815f0`, `stake.css?v=50bdc3d0`, `return.js` still `cc30346f`).
    Served on the first poll after `railway up --ci`. `test:live` all passed. Daily history was 1.9
    days old, inside the three-day check.

40. **The subnet list is the stake page; its figures re-read every minute (2 Oct 2026, a Cursor session).**
    The page opens on Browse subnets. Picking a row opens that subnet's chart, pool figures and validators
    there, and the choice fills step 3. Nothing on the list is a recommendation. While the tab is open the
    pool price, emission, the dollar price and a connected wallet's balances re-read every 60 s
    (`LIVE_REFRESH_MS`). A failed refresh keeps the last good rows on screen, and an open chart stays up until
    the new figures are ready. The README and the link card (`og.html`, `og.png`) now lead with the stake
    page. Daily history ran through 2 Oct. Live as `bbcc861`; it was not recorded here at the time.

41. **Open validator and holdings lists join the refresh (2 Oct 2026, a Cursor session).** An open validator
    list and an open holdings list re-read on the same tick (`openPicker` / `showHoldings` with `quiet`). A tick
    only refreshes a list already on screen, never one a click is already reading. The commit also added
    "Unstake has not yet moved real funds through this page" to the reverse lede, the subnet card, the review's
    `#r-later` and the finished-route notes. That was already untrue by then (item 42). Live as `7f2f93c`
    (`stake.js?v=fd7a03ad`, `stake.css?v=eb438146`, `return.js?v=049fc82b`). It was served before it was pushed;
    pushed on 4 Oct.

42. **An outside wallet's subnet Unstake and return carried real funds (1 Oct 2026, found 4 Oct).** Read from
    Bittensor's archive node and from Solana, nothing signed:
    - 30 Sep, 05:25 UTC: `FXNTL46d…` staked 0.15 TAO onto a subnet through the page (item 36).
    - 1 Oct, 12:38 UTC, block 9,187,979: coldkey `5D5cC13N…` (its first extrinsic, nonce 0) signed
      `utility.batchAll([removeStakeLimit(2.3826 Alpha, allow_partial false), transferKeepAlive(5Cvj…, 0.001 TAO)])`.
      Events: `StakeRemoved` (0.1224 TAO freed), `ItemCompleted` twice, `BatchCompleted`, `ExtrinsicSuccess`.
    - Block 9,187,980, 12 s later (nonce 1): `batchAll([transferAllowDeath(5EUsPH5t…, 0.1278 TAO),
      transferKeepAlive(5Cvj…, 0.001 TAO)])`. That is the return's first funding transfer with its fee riding once
      (item 28), the "unstake, then return" chain of item 15.
    - 1 Oct, 12:42 UTC: an OFT `LzReceive` (Solana `4bfZ69rq…`) raised `FXNTL46d…`'s TAO account from 0.04365 to
      0.164343 TAO (+0.120693). The account already existed, so the first-time rent path is still unobserved.
    - The fee coldkey `5Cvj…` went from 0.006593908 to 0.008593908 TAO in those two blocks. Bisecting its balance
      from block 9,150,000 to 9,210,128 found no other change.

    So a subnet Unstake (`removeStakeLimit`), "unstake, then return" and the batched Bittensor fee now have
    real-funds proof, from a wallet that is not Craig's. Still not proven: Move, Claim, staking more from
    holdings, a root unstake (plain `removeStake`), Chutes, and a first-time token account.
    - *Page copy*, with no subnet named: the hero proof line, the reverse lede, the subnet card, who-runs, the
      holdings prompt, `#holdings-limits`, the holdings note, `#r-later` and the finished-route note now say
      Unstake and the return have moved real funds, and Move and Claim have not. The tests that quote that copy
      are updated (`evm`, `page` runs C and F, `live`). Built as `stake.js?v=2771a2fd`; CSS and `return.js`
      unchanged. Deployed 5 Oct 2026 at Craig's go-ahead (`33609bb`); `test:live` all passed.
    - *`npm run usage` crashed:* a version-1 Solana transaction reached the fee wallet by 4 Oct, and
      `@solana/web3.js` 1.95.8 cannot parse one, even with a higher `maxSupportedTransactionVersion`. The script
      now reads transactions over plain JSON-RPC (`jsonParsed`, `maxSupportedTransactionVersion: 1`) and retries
      network errors. The page never calls `getTransaction`, so it was not affected. Count on 4 Oct: 9 routes from
      7 wallets since 21 Sep, 0.368833032 SOL.
    - *Simulation holder drift:* `test/solana.test.mjs` and page run C borrowed `E7wd…`, which fell to 0.088 TAO,
      under the 0.1 TAO they simulate. Both now take the first of four holders that still has 0.1 TAO, some SOL
      and no $SOLTAO discount (`SIM_HOLDER` pins one). `npm test` all passed.

43. **The 6 Oct roast's page fixes (6 Oct 2026).** From `docs/roast-my-product-2026-10-06.md` (61/110,
    judge's lens), on Craig's "do it all":
    - *Hero:* leads with "Stake your Solana TAO on Bittensor" instead of "Pick a subnet". Its first move is
      "Stake on root" (`#cta-root`: clears a subnet picked from the list, then scrolls to step 1) beside
      "Browse subnets". A subnet's own page (`?netuid=N`) hides it. The subnet list and "Send it" copy say
      root is the default.
    - *Real-funds copy:* the page said "real funds" 10 times. The hero now shows one "Done with real funds on
      mainnet" strip (root stake 23 Sep, subnet stake 30 Sep, unstake + return 1 Oct). The repeats are cut
      from the trust line, who-runs, the reverse lede, the subnet card, `#r-later` and the finished-route
      note. The holdings prompt and `#holdings-limits` still say Move and Claim have not moved real funds.
    - *Verify this page:* the footer (`#verify`) names the running build (`#build-name`, from the script
      tag) and how to check it. The `?v=` is the start of the SHA-256, the file is committed, and a rebuild
      from the committed source gave the same bytes (checked 6 Oct). The README's "For judges" has the
      commands.
    - *Bug fixed:* on a subnet's own page, choosing another subnet from the list threw "Cannot set
      properties of null (setting 'hidden')". `renderProfile` replaced `#dir-profile`'s children while the
      validator picker sat in its slot, which took `#pick-wrap` out of the page. Every replace now parks the
      picker first. Live on `2771a2fd` as well; page run E caught it.
    - *Phone list fixed:* the subnet rows were held at the 64 px of the list's grid track on a phone, so a
      row's second and third lines (sparkline, 30-day change, emission rank) spilled under the next row.
      The list is now a flex column whose rows keep their own height. Desktop looks the same.
    - *Test:* run E's 7/30-day check no longer needs a 30-day figure on the top three movers. A subnet
      registered under 30 days ago has none (subnet 108 on 6 Oct), and the page rightly shows "—".
    - *Board:* its header and footer links are the builder (@Moneybag_Fin) and the repo. The coin's X and
      Telegram are linked only from its disclosure.
    - *Not done:* parking the $SOLTAO discount, and a way to run one real Chutes top-up through the live
      page. Both wait for Craig's own decision. The discount and its disclosures are unchanged.
    - Built as `stake.js?v=b6c4271f`, `stake.css?v=34b30b81`; `return.js` unchanged. `npm test` all
      passed; page runs A, B, C and E passed. Run F passed every check up to the Chutes card, then its fee
      quote failed with "Failed to fetch", twice, the second time after a 5-minute quiet pause. It failed in
      the same place on 5 Oct, before these changes, and nothing here touches `payments.js`. Chutes is off
      in production, but look at this before any real Chutes top-up.

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
- **The Solana RPC is PublicNode, then a same-origin Helius proxy (30 Sep 2026).** Direct Helius
  in the browser 403'd on the old joell-lsu6ge plan. The new key is Railway `HELIUS_API_KEY`, not
  git. Helius is a **free** plan: it stays last in `solanaRpcs` and `npm run usage` does not use it.
  `solanaRpcs` is both PublicNode hostnames plus `https://soltao.xyz/solana-rpc`. Every URL in
  `solanaRpcs` / `bittensorEvmRpcs` must be in **both** CSPs. Do not put the Helius API key in
  `config.js` (scrapers would burn the free quota in hours).
- **Space out the live test runs.** `lite.chain.opentensor.ai` rate-limits per client over a 60 s
  window (`429`, `retry-after: 60`, `x-ratelimit-policy: http_60s`), and it limits requests that
  carry a browser `Origin` more readily than bare ones. Running the mainnet replay, the page test and
  the live check back to back tripped it on 24 Sep 2026. The page now falls through to
  `archive.chain.opentensor.ai`; `test:live` retries the subnet-64 card. In the browser a 429 still
  shows up as "Failed to fetch", not as a CSP violation. Despite the 60 s header, a 2-minute pause
  was not enough that day and a 5-minute fully quiet pause was. Rerun after a quiet pause before
  suspecting the code.

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
3, timing 5. The engineering is ahead of the product. Re-runs: 65 / 110 later on 24 Sep (`docs/subnet-pilot-and-roast-2026-09-24.md`), then 70 / 110 on
30 Sep (`docs/roast-my-product-2026-09-30.html`), up on the fee model and loop copy, not on users. The 30 Sep
code review (`docs/review-and-iterate-2026-09-30.html`) graded the client B (83).

**Worst issues, and the plan for each:**

| Issue | Plan |
|---|---|
| Nobody has used it, and nothing measured that | Done: `npm run usage` counts routes on-chain from the fee wallet, since launch |
| It only opens one way: stake in, no return through soltao | Milestone 3: wire the built free-TAO return, then unstake and return (Milestone 4) |
| Subnet stakers must find a valid hotkey on taostats themselves | Done: "List subnet N's validators" reads the permit holders from the metagraph (`subnetValidators()`, ~13 requests, ~7 s on subnet 1), shows uid, take and last-epoch dividend share, states its one sort rule on the page, and choosing a row only fills the field, which is then checked as usual. No stake column: its unit was never confirmed. No names: not on-chain |
| The board, the stake route and the SOLTAO coin share one name; the stake page header says "Unofficial community reference" | Done: a line under the headline says who runs it, that keys never leave the browser, that the page's code is the trust point, and that the flat SOL fee is its only charge. Header now "Self-custody stake route" |
| Amounts are TAO and SOL only, never money | Done: the review adds "In dollars, roughly": the TAO amount and the SOL fees in USD from Dexscreener's deepest USD pool (already in the CSP), with the read time. Display only (`src/prices.js`), cached 60 s, hidden if the feed fails; nothing the route does uses it |
| No core loop: nothing to come back to (scored 2/10) | Started: "Show what this Bittensor wallet holds" in step 2 lists free TAO and every stake position (subnet, validator, amount) from the chain's StakeInfo runtime API, for the derived or a pasted coldkey. Read on request through `stake/return.js`. Done since (gated with the return): Unstake and Stake per position, and "unstake, then return" in one confirm (items 13 and 15) |
| No shareable state | Done: `?netuid=` and `?hotkey=` prefill step 3 and run the normal checks; a checked validator offers "link to this choice" |

Sins flagged: phantom users, bridge to nowhere, jargon overload, and MEV bait (fixed in item 11).
Avoided: token-first thinking; the $SOLTAO gate was rejected and the conflict is disclosed. A holder discount (item 38) is optional and does not gate the route. It is live as of 1 Oct 2026.

## Current state

**As of 5 Oct 2026.** Production is `33609bb` / `stake.js?v=2771a2fd` / `stake.css?v=eb438146` /
`return.js?v=049fc82b` (items 40–42). `chutesLive` stays false. Do not feature a subnet unless they asked.

**Next, in order.** (1) One small real-funds Move and Claim. (2) Leave Chutes off until one ≥0.01 TAO top-up
is credited.

### What has real-funds proof
- Wallet connect, SIWS, derivation, quotes, simulation.
- Root-staking forward route (23 Sep 2026).
- Free-TAO return to Solana (24 Sep 2026, item 17): wrap + LayerZero send landed, existing token account.
- Error recovery / resume from chain state.
- One hand-held third-party "Just deliver it" route (item 23). Keep-alive sweep (item 20) on that run.
- More routes from wallets outside Craig's known two: `FH9zKY…` (29 Sep and 1 Oct, 43.05 TAO), `9AEqMf…`
  (30 Sep), `cKR3xq…` (3 Oct, 9.60 TAO).
- Subnet stake through the live page (30 Sep 2026, stranger, `addStakeLimit`).
- Subnet Unstake with the batched 0.25% Bittensor fee, then a return that landed on Solana (1 Oct 2026, the same
  stranger, item 42).

### Live on soltao.xyz, not yet with real funds
- Move, Claim, and staking more from holdings (items 26, 21, 13). A root unstake (plain `removeStake`).
- Subnet directory, profiles, validator 30-day record (items 14, 25, 27): read-only, nothing to prove with funds.

### Built, gated off (`chutesLive: false`)
- Top up Chutes (item 18). Needs one ≥0.01 TAO real top-up credited by Chutes before flipping the flag.

### Still open (not a deploy, needs Craig)
- First-time Solana token-account rent path on a return (inferred, never observed). The return
  review now reads whether this wallet already has a TAO token account and says so.
- A large subnet stake that moves the pool more than 2% by itself can still be refused; the
  review quotes the chain's own swap simulation and warns from 1% simulated impact.

The 23–24 Sep deploy narrative below is historical. Trust the header and this section over it.
`railway up --ci` exits before rollout; poll the live script hash.

### Historical: deployed 23-24 Sep 2026 (three rounds)
Round one shipped a CSP/Helius mismatch (bug history item 7). Round two deployed the return
foundation. Round three fixed link previews. Item 10 (subnet-aware hotkey check) deployed later
the same day as `292b68b`. Concurrent sessions overwrote this document more than once; re-check
`git log origin/main` and the live hash before trusting any commit id here.
