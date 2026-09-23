# Stake route — handover

Living document. Whoever (human or LLM) picks this up next should be able to read this alone and
continue without re-deriving context. Keep it updated after every meaningful step — don't let it
go stale.

Last updated: 2026-09-23. Forward root-staking route is live-verified (see below). Subnet staking
and the redesign are new since the last live test and have NOT themselves been through a real
funded production transaction yet — see "Current state" before assuming anything beyond root
staking is production-proven.

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
  (`BgGFMbwUtKLifQYZogbDorEXTXYp3UKVAZSH41xQ72Na`).
- `tools/stake/src/oft_return.js` — **new, not wired to the page.** Builds/quotes the canonical
  wTAO -> Solana OFT send for the bridge-back direction (rao/wei/6-decimal-dust conversions, funding
  math, live fee quoting). Pure functions only; nothing here sends a transaction.
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
  bridge-back foundation — run via `npm run test:return:live` / `test:return:metadata`, not part of
  the default `npm test`).
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
   matches what `npm run build` just printed.

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

## Standing constraints

- **No WalletConnect.** The bugs were inside Phantom's own signing logic, not transport-related.
- **No private keys in chat.** Anything pasted here is written to plaintext logs indefinitely.
- **Keep the SIWS statement plain ASCII.** Enforced by `test/derive.test.mjs`.
- **Always rebuild before deploying.** `stake/stake.js` is generated output.
- **Deploys need explicit fresh confirmation each time** — ask before every `railway up --ci`.

## Current state

### What's live-verified (real funds, production, before subnet staking existed)
- **Wallet connection** (Phantom, Solflare, any standard provider)
- **SIWS sign-in and wallet derivation** (production path works seamlessly on `soltao.xyz`)
- **Transit account and coldkey generation**
- **Transaction building, simulation, and quote**
- **Root-staking forward route** (unwrap -> addStake root -> transferStake -> sweep) — confirmed by
  Craig via a real funded transaction on `soltao.xyz`, per the "Final Verification" note below
  (date not recorded here; treat as sometime on/before 22 Sep 2026, root netuid only).
- **Error recovery** — messages persist, UI recovers, and background bridging picks up exactly where
  it left off via deterministic local state.

### Final Verification (root staking, pre-subnet-staking build)
A live production transaction was successfully sent and routed on the root-staking forward route:
1. SIWS sign-in on `soltao.xyz` succeeded.
2. Phantom approved the Solana bridge transaction.
3. Bridge delivered wTAO + gas drop to the transit account.
4. Route successfully unwrapped and swept to the user's coldkey.

Confirmed real by Craig on 23 Sep 2026. This predates subnet staking, the localhost-bypass removal,
and the redesign — none of those three have had a real funded production run yet.

### Built since that verification, NOT yet live-tested with real funds
- **Subnet staking** (`route.js` addStake/transferStake now take a netuid). Covered by a mocked
  chain simulation (`route.test.mjs`, including a case that proves subnet resume never touches root
  stake) and, as of 23 Sep 2026, by the same zero-cost mainnet-replay approach as the original
  route: `test/mainnet.test.mjs` now has a subnet-staking scenario that replays the real signed
  transactions through the real staking precompile against real subnet 1 (owner hotkey confirmed
  live to be a registered delegate). Result across repeated runs: 0.1 TAO consistently converts to
  ~11.2 Alpha, owned by the fresh coldkey, zero root-stake cross-contamination, every time addStake
  itself ran (7 of 8 runs clean; the one miss was the shared public Bittensor RPC rate-limiting
  under our own repeated testing, not a reverted transaction — addStake succeeded even in that run).
  **What's still missing:** an actual real signed transaction with real funds through the live page.
  The eth_call replay proves the precompile logic is correct against real state; it can't prove
  Phantom signs the resulting calldata cleanly or that LayerZero's executor actually delivers.
- **The visual redesign** (PR #1, merged 23 Sep 2026) — verified headless (zero console/CSP errors,
  screenshot-checked) but not yet exercised with a real wallet on the real domain. Past bugs in this
  project (items 1, 3, 4 above) were all real-browser/real-domain issues that headless testing
  would not have caught, so don't skip a real-wallet pass just because the automated checks are
  green.
- **Bridge-back foundation** (`oft_return.js`, `substrate.js`) — Milestone 3 in `docs/gateway-plan.md`,
  in progress. Deliberately not reachable from the live page (disabled toggle, `app.js` gates on
  `direction === "forward"`). Not a release blocker; just not a thing to enable yet.

**Not ready for a "ship it" recommendation as a whole.** The root-staking path has real-money proof;
subnet staking and the redesign do not yet, and the standing deploy constraint above (explicit
confirmation before every `railway up --ci`) still applies for exactly this reason.
