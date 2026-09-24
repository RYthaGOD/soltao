# soltao — Solana TAO Board

A one-page cheat sheet for the canonical Solana TAO mint. Built to be pasted into a CT reply
and settle the argument: which contract is real, how deep the book actually is, what the
look-alikes are, and which TAO-quoted coins exist.

**Canonical mint:** `taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY`
(A LayerZero V2 OFT listed by Sunrise, issued from Bittensor EVM, live since 5 May 2026.)

---

## Stack

The board is static HTML5 + CSS3 + vanilla ES6. No framework, no bundler, no npm install, no
backend, no wallet connection, no analytics. (The separate `/stake/` page does connect a wallet
and is bundled from `tools/stake/`; its built output is committed, so serving still needs no
build. See "/stake/" below.) Market data comes from the keyless
[Dexscreener REST API](https://docs.dexscreener.com/api/reference) straight from the browser,
cached in `localStorage` for 30 seconds.

```
index.html     layout and copy; the canonical mint is hardcoded here, not fetched
styles.css     design tokens and layout
app.js         fetch, cache, number formatting, rendering, the address checker
pairs.json     the curated registry — the only file you edit to keep the site current
og.html        source for the social card
og.png         1200×630 social card, rendered from og.html
favicon.svg    the logo, embedded so the one favicon path works everywhere
logo.webp      the logo master, as supplied
logo.png       180px crop of it: header mark and apple-touch icon (logo-512.png renders og.png)
tools/         maintenance scripts — optional, never needed to serve the site
stake/         the stake route page: its own HTML, CSS and one bundled script (built, committed)
tools/stake/   source, build and tests for stake/stake.js
```

### Why the mint is hardcoded

The one fact this site exists to deliver must survive a dead API, a failed `pairs.json`
fetch, and JavaScript being off entirely. It is written into `index.html` in three places and
repeated in the `<noscript>` block. Live numbers degrade; the address does not.

The same reasoning covers the look-alike list and the deepest TAO-quoted coin, which are
rendered from `pairs.json` at runtime and would otherwise leave two empty containers to a
reader with JavaScript off. They are written into `index.html` as static markup between
`<!-- fallback:notThis -->` and `<!-- fallback:pairs -->` markers, and `app.js` replaces them
once it has live data. Static copy drifts, so it is generated rather than typed:

```bash
node tools/fallback.js            # rewrite the blocks from pairs.json
node tools/fallback.js --check    # exit 1 if they are stale — run it after editing pairs.json
```

`app.js` also leaves those blocks standing when the registry or the Dexscreener feed fails,
and explains the degradation in the table footers instead of blanking the tables.

---

## Running it locally

It uses ES modules and `fetch('pairs.json')`, so `file://` will not work — serve the folder:

```bash
npx serve .          # or: python -m http.server 8000
```

Then open `http://localhost:3000`.

## Deploying

Any static host. There is no build step — point it at the repo root and publish.

Currently live on three hosts, serving byte-identical content. Only `soltao.xyz` serves the
security headers, and the stake page's sign-in message names `soltao.xyz`, so `/stake/` on either
mirror redirects to the canonical domain:

| | URL |
|---|---|
| Railway (custom domain) | <https://soltao.xyz/> — canonical |
| Railway (generated) | <https://soltao-production.up.railway.app/> — mirror |
| GitHub Pages | <https://rythagod.github.io/soltao/> — mirror |

| Host | Setup |
|---|---|
| GitHub Pages | Settings → Pages → deploy from branch, root folder |
| Railway | `railway up` — see below |
| Cloudflare Pages | Connect the repo. Build command: *(none)*. Output directory: `/` |
| Netlify | Drag the folder in, or connect the repo with no build command |
| Vercel | Import the repo, framework preset "Other", no build command |

### Railway

`Dockerfile` + `deploy/nginx.conf.template`, built remotely — nothing to install locally.

```bash
railway init --name soltao      # once
railway add --service soltao    # once
railway up --ci                 # deploy
railway domain                  # once, to get a public URL
```

Railway injects `PORT` at runtime. The official nginx image runs `envsubst` over
`/etc/nginx/templates/*.template` on boot, so the port lands in the config with no custom
entrypoint. `/healthz` backs the healthcheck in `railway.json`.

**The nginx trap worth knowing:** an `add_header` inside a `location` block silently discards
every `add_header` inherited from the `server` block. So the security headers are declared once
at server level and per-file caching uses `expires`, which is a different directive and does not
trigger that reset. If you add a header inside a location later, you must re-declare all of them
there too.

**Every host serves `rel="canonical"` and the OG tags pointing at `soltao.xyz`**, so the
mirrors do not compete with the primary in search or on social. That is six absolute URLs in
total — `link rel="canonical"`, `og:url`, `og:image` and `twitter:image` in `index.html`, the
`Sitemap:` line in `robots.txt`, and `<loc>` in `sitemap.xml`. If the home domain ever moves,
change all six together or the mirrors start competing with each other.

Relative URLs do not work for social cards; X and Telegram need the absolute path or the card
renders blank. That is why `og:image` is spelled out in full rather than left as `/og.png`.

### Regenerating the social card

`og.html` is the source. Render it at exactly 1200×630:

```bash
chrome --headless=new --no-sandbox --hide-scrollbars \
  --window-size=1200,630 --screenshot=og.png http://localhost:3000/og.html
```

---

## Keeping it current

Everything curated lives in `pairs.json`. Nothing else needs touching.

### `canonical`

The mint, its bridge, and `thinBookUsd` — the liquidity floor under which the thin-book alert
fires. Currently `300000`. Total TAO liquidity has been hovering just above that, so expect
the badge to come and go.

If you change the mint here, **also change it in `index.html`** (the hero block, the
"This one" panel, the three outbound links, and the `<noscript>` block). That duplication is
deliberate — see above.

### `notThis`

Look-alikes, one object each:

| Field | Meaning |
|---|---|
| `verdict` | `legacy` · `mislabeled` · `ticker-squat` — drives the badge colour |
| `claim` | What the token actually is, stated fairly |
| `why` | Why it is not the one you want |

Live liquidity for each is fetched and appended in brackets, so a dead wrapper visibly reads
as dead. Keep the wording factual: `wTAO` is a real VoidAI bridge token, not a scam — it is
simply not canonical and had about $170 of liquidity on 20 Sep 2026, which is the thing that will hurt you.

### `pairs`

TAO-quoted coins. `rewards` is `confirmed`, `unverified` or `self`:

- **`confirmed`** — the TAO dividend mechanic has been verified at the source. Only `$BUTT`
  qualifies today.
- **`unverified`** — the TAO-quoted pool is real and live, but nobody has confirmed the
  reward mechanic. The table says so out loud.

- **`self`** — this page's own coin, flagged with `"self": true`. It never renders in the
  verified green, however well it checks out, and it carries extra fields the renderer shows:
  `badge` (what the marker reads after "ours"), `disclosure` (printed under the name in the
  row), `verified` (what was actually read on-chain — and what was not), `onchain` (the mint
  account) and `pool` (why the live columns are empty, if they are).

Do not promote a coin to `confirmed` on the strength of its own marketing. That rule binds
hardest on the `self` row, which is why it cannot reach `confirmed` at all.

A `self` row is also exempt from the dead-liquidity filter in `app.js`. A disclosure that
vanishes behind a toggle is not a disclosure, so the row renders at zero liquidity, with every
live cell reading as no data, and says why in the badge tooltip.

`pairAddress` pins the row to one specific pool. Leave it `null` and the deepest TAO-quoted
pool wins automatically.

### The API's 30-pair cap

`/latest/dex/tokens/{mints}` silently returns **at most 30 pairs**, however many mints you
ask for. TAO alone returned 24 pairs on 20 Sep 2026, so one combined request quietly drops the small coins.

`app.js` therefore fetches TAO on its own and chunks everything else six mints at a time
(`CHUNK`). If you add a lot of tokens to `pairs.json`, the chunking scales automatically —
but if a coin's numbers ever come back empty while Dexscreener shows a live pool, the cap is
the first thing to suspect.

---

## /stake/ — the stake route

The one page on the site that connects a wallet, kept on its own URL so the board stays read-only.
It takes canonical Solana TAO home and stakes it, owned by a Bittensor wallet the user holds, in one
Solana transaction. There is no soltao contract anywhere on the route and no server: the page does
the Bittensor half itself, with a key derived from the user's own signature.

```
sign once ─► coldkey (sr25519, 12 words) + transit key (secp256k1, Bittensor EVM)
Solana tx: OFT send to the transit account, with a 0.001 TAO gas drop  +  soltao's flat SOL fee
Bittensor EVM, signed by the page with the transit key:
  wTAO.withdraw → addStake (root or a chosen subnet, chosen validator) → transferStake to the coldkey → transferAll the rest
```

**Subnets.** Root is the default. On any other subnet the stake mints that subnet's Alpha, and the
page checks the subnet's own metagraph before letting the user send: the subnet must exist and the
pasted hotkey must hold a uid with a validator permit there. A validator on one subnet is not one on
another, and the chain accepts a stake to a hotkey with no slot on the subnet, where it earns nothing
(tested against mainnet state, 24 Sep 2026). A subnet stake swaps TAO into the subnet's Alpha pool,
so it is sent as `addStakeLimit` with no partial fill, capped at 2% above the pool price read just
before sending. If the price has moved further by the time it lands, the chain refuses it and the TAO
arrives unstaked. Root has no pool and uses plain `addStake`.

**The keys.** The user signs a fixed Sign-In-With-Solana message. HKDF over that ed25519 signature
gives two independent keys: a 12-word phrase that is an ordinary sr25519 coldkey and imports into
btcli (checked against Substrate's published vectors), and a secp256k1 key for the **transit
account**, the Bittensor EVM address the bridge delivers to. The user can land the TAO in the
derived coldkey or paste one they already have; either way the transit key comes from the same
signature. If the wallet's signature does not verify as raw ed25519 (some hardware setups wrap the
message), the page says only that exact setup can recreate the keys.

**Why a transit account.** The OFT only delivers to an H160, and the staking precompile only acts
for the caller. So the bridge delivers wTAO to the user's own transit account, and the page then
sends up to four ordinary transactions from it: unwrap, stake as itself, hand the stake to the
coldkey with `transferStake`, and sweep what is left (the reserve and unused gas money) to the
coldkey as free TAO. They only call wTAO and the `0x…0805` staking and `0x…0800` transfer
precompiles, and only ever pay out to the coldkey. The runner (`src/route.js`) works from chain
state, so if the page closes midway the user signs the same message again and it picks up where it
stopped. The page remembers the unfinished route's settings (plan, validator, destination, amount;
never a key) in `localStorage` so it knows what to finish.

**Gas.** The gas drop pays for the unwrap; everything after is paid from the arriving TAO.
`transferStake` is only admitted with ~2.36M gas on hand, though it uses ~62k. A contract had to buy
that whole limit through LayerZero's compose option (≈0.05 SOL a route); a plain account only has to
*hold* limit × price and is charged for what it uses. The route costs about 0.0012 TAO of gas to
stake and 0.0004 TAO to deliver, at 5 gwei (21 Sep 2026). The LayerZero fee for 0.1 TAO, drop
included, was 0.0144 SOL the same day; the page quotes it live from the TAO program before signing.

**soltao's fee** is 0.003 SOL, a plain SOL transfer in the same transaction, shown in the review
with its receiving address before the wallet opens. With no contract, anyone can bridge to their
own address without the page and skip it; the fee pays for the page, not for access.

**What it trusts:** the canonical TAO program (upgradeable; its upgrade key and OFT admin are one
single key), wTAO on Bittensor EVM (immutable; bridge settings under a 3-of-4 Safe), LayerZero's DVNs
and executor (for the gas drop), Bittensor's precompiles, the chosen validator, and this page's
script. The footer of /stake/ says the same.

### Files

| Path | What |
|---|---|
| `tools/stake/src/derive.js` | The coldkey and transit key from one signature |
| `tools/stake/src/solana.js` | The Solana transaction: OFT send with the gas drop, plus the fee |
| `tools/stake/src/route.js` | The Bittensor half: unwrap, stake, hand over, sweep, resumable |
| `tools/stake/src/evm.js`, `bittensor.js` | Legacy EIP-155 signing, batched RPC, and the precompile reads it needs, including the subnet metagraph |
| `tools/stake/src/config.js` | Every address, gas limit and the fee, with where each was measured |
| `tools/stake/src/app.js` | The page controller |
| `tools/stake/src/oft_return.js`, `return_route.js`, `substrate.js`, `return_entry.js` | Free TAO back to Solana. Built into its own `stake/return.js`, fetched only when that direction is opened. Open on local hosts only until `returnLive` is set after a real-funds return |
| `tools/stake/src/pending.js` | Seals what the page saves in the browser (resume routes, return checkpoints) so edits are ignored |
| `tools/stake/usage.mjs` | `npm run usage`: counts completed routes on-chain from the fee wallet |
| `tools/stake/test/` | Derivation vectors, signing against ethers, the runner against a simulated chain, the Solana transaction simulated on mainnet, zero-cost mainnet replays, a headless-browser run under the production CSP, and a post-deploy check of the live domain |
| `tools/stake/HANDOVER.md` | Current state, bug history and the deploy procedure. Read it first |
| `stake/` | What is served: `index.html`, `stake.css`, `stake.js` and `return.js` (both built) and their licence notices |

The first design used an ownerless router contract on Bittensor EVM. It is retired, not deployed,
and kept only in the private `research/archive/`.

### Build and test

```bash
cd tools/stake && npm install
npm test                     # derivation, EVM signing, route runner, subnet lookup, return engine, build shim, Solana simulation
npm run test:mainnet         # the real route.js against live Bittensor mainnet state, in eth_call only
npm run test:page            # builds both bundles, then drives the page in Chrome under the production CSP
                             # (RUNS=B,F node test/page.test.mjs runs chosen runs; space heavy ones out)
npm run test:subnet:live     # the subnet/hotkey lookup against mainnet, read-only
npm run test:return:live     # bridge-back fee and transfer quotes, read-only
npm run test:return:metadata # bridge-back call shapes against the live runtime metadata
npm run test:return:mainnet  # bridge-back wrap and send, replayed in eth_call only
npm run test:live            # after a deploy: the real domain, read-only, no wallet
npm run serve                # the site on http://localhost:8788 with the production headers
```

None of it needs funds or sends anything. `test:mainnet` places `test/Replay.sol` at LayerZero's
endpoint and at the transit address inside a single `eth_call`, delivers through the real wTAO OFT,
and replays every transaction `route.js` signs, so each step runs on Bittensor's real runtime. What
it cannot show is LayerZero's executor delivering; LayerZero Scan's history for this path covers
that (78 of 78 Solana → Bittensor TAO messages delivered since 1 May 2026, median 81 s, and all three
earlier native drops succeeded, each to a plain address like the transit account).

The build fails if the bundle contains `eval` or `new Function`, so it can never need
`'unsafe-eval'`. The page added two origins to `connect-src`: `https://lite.chain.opentensor.ai`
(Bittensor) and the Helius Solana RPC set in `config.js`. They must be in **both** `_headers` and
`deploy/nginx.conf.template`; the two drifting apart once shipped a CSP bug.

### Status

Live on `soltao.xyz` since 23 Sep 2026. The fee wallet is
`BgGFMbwUtKLifQYZogbDorEXTXYp3UKVAZSH41xQ72Na`, checked on chain as an ordinary wallet, and the
Solana test decodes the fee instruction to confirm exactly 0.003 SOL goes to it. Root staking has
been routed end to end with real funds. Subnet staking is verified against real mainnet state at
zero cost but has not yet carried real funds. `tools/stake/HANDOVER.md` tracks exactly what has
which kind of proof, and how to deploy.

## Things this deliberately does not do

No wallet connect on the board; the stake route connects one on its own page. No backend or
database. No charts. No subnet, validator or dTAO analytics on the board —
[Taostats](https://taostats.io/) already does that and does it properly. The stake page reads only
the on-chain facts it needs to check a stake before it is sent, and ranks nothing. No swap
routing; Jupiter handles the swap and the link is prefilled.

## The conflict, and where it is disclosed

The person who runs this page also launched the **SOLTAO** coin on StonkFun —
`8P1XmDhzU8qR3oiXHd2YfmBpB92Rn4hwunMsMGdghvCn`, a Token-2022 mint with a 1% transfer tax, a
fixed 1,000,000,000 supply and no mint or freeze authority. The page's X and Telegram links are
that coin's accounts.

A reference page that grades other people's coins, run by someone who has a coin, only works if
it says so where a reader will see it. So the footer carries the disclosure in plain language,
and SOLTAO is **in** `pairs.json` rather than left out of it, flagged `"self": true` — a row
people can see and judge, marked `ours`, exempt from the dead-liquidity filter so it cannot
quietly disappear, and barred from ever reaching `confirmed`. "Unverified" next to everyone
else's coin and silence next to your own is exactly the thing that would discredit the rest of
the page.

Three things have to stay true of that row. It never renders in the verified green, however well
it checks out — the marker stays amber and leads with "ours", so a reader prices the conflict
before the claim. It never gets ranked above the others by anything but real liquidity — it sorts
on the same number as everyone else, which on 20 Sep 2026 put it last, because Dexscreener
indexed no book for it at all. And every claim in its `mechanic` is backed by a `verified` field
saying what was actually read on-chain and what was not; on 20 Sep 2026 that was TAO-quoting and
fee accrual read from sampled mainnet transactions, but not the pro-rata payout itself, which is
taken from StonkFun's published model exactly as it is for every other row.

## Accuracy notes

- **The slippage table is an upper bound, and a loose one.** `impact = size ÷ quote-side
  reserve` of the single deepest pool. That is a linear approximation, not constant-product
  maths, and it ignores every other pool. Jupiter splits across all of them and concentrated
  liquidity does better: spot-checked against a live Jupiter quote on 20 Sep 2026, the $25k
  row overstated the real impact by more than tenfold. It is sized to make thin books
  visible, not to quote you, and the caption now says so. If you want it to be a quote,
  fetch one from Jupiter — that needs `connect-src` updated in both header files.
- **"Canonical" is Sunrise's designation**, not a Bittensor Foundation endorsement.
- **The bridge is LayerZero, not Wormhole.** Sunrise is the listing venue; the transport under it
  differs per asset, and [its listed-assets table](https://docs.sunrise.xyz/resources/listed-assets)
  gives TAO as *Bittensor EVM · LayerZero*. That matches the chain: the mint authority
  `8vJKzz…jZdDg` is a LayerZero `OFTStore` (anchor discriminator `c3d76886b9c3f072`) naming the
  LayerZero V2 endpoint `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6`, with `ld2sd_rate` 1000 —
  9 local decimals against 6 shared, so cross-chain amounts quantise to 0.000001 TAO. It also
  matches the absence of Bittensor from Wormhole's chain registry, which is what made the earlier
  "Wormhole NTT" claim impossible to hold.
- **The exit route claims are researched, not live-fetched.** The route home is Sunrise's withdraw
  → Bittensor EVM (`H160`) → `btcli evm send-to-ss58` or a mirror-address deposit claim → SS58,
  per Bittensor's own
  [EVM money-flow guide](https://github.com/RaoFoundation/subtensor/blob/main/docs/guides/evm/index.mdx).
  Ethereum's `wTAO` bridge is a *different* door — closed source, single pseudonymous operator,
  manual withdrawal verification, ~$28M locked (DefiLlama, 20 Sep 2026; governance reported by
  [DL News](https://www.dlnews.com/articles/defi/wrapped-tao-on-ethereum-soars-to-82m-but-its-all-controlled-by-one-person/)) —
  and the page now says so instead of putting it on the ladder. The Bittensor EVM staking
  precompile interface is read from Opentensor's own
  [evm-bittensor](https://github.com/opentensor/evm-bittensor/blob/main/solidity/stakeV2.sol)
  examples; that V2 address answers on mainnet (view calls at runtime spec 467, read 21 Sep 2026),
  and the stake route depends on it. A Sunrise withdraw lands as **wTAO**, the OFT's ERC-20, not as
  native TAO: a simulated delivery credits wTAO to every kind of recipient, and Sunrise's docs list
  only MON, HYPE, AVAX and SUI as unwrapping on arrival.
  Allways (subnet 7, `SOL ↔ TAO` among its live pairs) is read from its
  [repository](https://github.com/entrius/allways) and is beta software by its own description.
  Re-check these before the next curation pass — they are the only numbers on the site that do
  not refresh themselves.
- **Bridged supply, decimals and the owning token program are read from the mint account**
  over `solana-rpc.publicnode.com`, not derived from Dexscreener. An earlier version used
  `fdv ÷ price` and was roughly 4x under the true supply. Never reintroduce that: a price
  feed is not an on-chain fact. The call fails closed to an em dash rather than to a guess.
- The 24h change and the quoted spot price come from the deepest pool; volume and liquidity
  are summed across every pool where TAO is the base token.

## Verification log

- **20 Sep 2026, second pass** — the bridge claim was wrong and is now corrected everywhere.
  The token is a **LayerZero V2 OFT**, not a Wormhole NTT deployment: Sunrise's listed-assets
  table gives TAO as *Bittensor EVM · LayerZero*, and the mint authority decodes as a LayerZero
  `OFTStore` pointing at the LayerZero V2 endpoint. The previous pass had already confirmed that
  Bittensor is absent from Wormhole's registry without noticing that this makes an NTT route
  impossible. Also in this pass: the exit ladder rebuilt around the route that actually exists
  (Sunrise withdraw → Bittensor EVM → `send-to-ss58`), Allways added as the no-wrapper
  alternative, Ethereum's `wTAO` demoted to a clearly-labelled aside, Tensorplex marked
  `closing` (Stake and the tTAO bridge are deprecated, manual withdrawals only), the dead
  `wormhole.com/products/ntt` link replaced, `docs.learnbittensor.org` swapped for
  `bittensor.com/docs` after it started redirecting, and the no-JavaScript fallback markup
  generated into `index.html`.

- **20 Sep 2026** — full pass. Verified on chain: decimals `9`, SPL Token program, live supply,
  and token-account rent at `1,488,440` lamports for 165 bytes. Verified against source: the
  DL News article (published 2024-02-11, $82M, the closed-source/one-operator/"at least once a
  day morning/night" claims), the `0x…0805` precompile and both `addStake` signatures in
  `stakeV2.sol`, and every StonkFun reward mechanic on stonkfun.xyz/rewards. Confirmed Bittensor
  is absent from the Wormhole SDK chain registry, and that the oldest TAO pool was created
  2026-05-05, corroborating "live since 5 May 2026". All seven TAO-quoted coins still have live
  TAO-quoted pools.
- Corrected in the same pass: the wTAO figure ($29M → $28M), the Bittensor base-chain figure
  ($522M → $495M), Bittensor EVM DeFi ($28K → $27K), an unsourced "~73 chains in Wormhole's
  registry", a `pump.fun` attribution on the BITTENSOR squat that the chain contradicts, a
  launch date on it that nothing supports, and a WinTAO entry that called it unrelated to the
  canonical mint when its pool is quoted in it.

## Licence

MIT. Fork it, change the mint, point it at a different asset.
