# soltao — Solana TAO Board

A one-page cheat sheet for the canonical Solana TAO mint. Built to be pasted into a CT reply
and settle the argument: which contract is real, how deep the book actually is, what the
look-alikes are, and which TAO-quoted coins exist.

**Canonical mint:** `taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY`
(A LayerZero V2 OFT listed by Sunrise, issued from Bittensor EVM, live since 5 May 2026.)

---

## Stack

Static HTML5 + CSS3 + vanilla ES6. No framework, no bundler, no npm install, no backend,
no wallet connection, no analytics. Market data comes from the keyless
[Dexscreener REST API](https://docs.dexscreener.com/api/reference) straight from the browser,
cached in `localStorage` for 30 seconds.

```
index.html     layout and copy; the canonical mint is hardcoded here, not fetched
styles.css     design tokens and layout
app.js         fetch, cache, number formatting, rendering, the address checker
pairs.json     the curated registry — the only file you edit to keep the site current
og.html        source for the social card
og.png         1200×630 social card, rendered from og.html
favicon.svg
tools/         maintenance scripts — optional, never needed to serve the site
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

Currently live on three hosts, serving byte-identical content:

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

TAO-quoted coins. `rewards` is `confirmed` or `unverified`:

- **`confirmed`** — the TAO dividend mechanic has been verified at the source. Only `$BUTT`
  qualifies today.
- **`unverified`** — the TAO-quoted pool is real and live, but nobody has confirmed the
  reward mechanic. The table says so out loud.

Do not promote a coin to `confirmed` on the strength of its own marketing.

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

## Things this deliberately does not do

No wallet connect. No backend or database. No charts. No subnet, validator or dTAO
analytics — [Taostats](https://taostats.io/) already does that and does it properly. No swap
routing; Jupiter handles the swap and the link is prefilled.

## The conflict, and where it is disclosed

The person who runs this page also launched the **SOLTAO** coin on StonkFun —
`8P1XmDhzU8qR3oiXHd2YfmBpB92Rn4hwunMsMGdghvCn`, a Token-2022 mint with a 1% transfer tax, a
fixed 1,000,000,000 supply and no mint or freeze authority. The page's X and Telegram links are
that coin's accounts.

A reference page that grades other people's coins, run by someone who has a coin, only works if
it says so where a reader will see it. So the footer carries the disclosure in plain language,
and SOLTAO is **not** in `pairs.json`. If it is ever listed there, the footer line has to change
and the row needs its own marker — "unverified" next to everyone else's coin and silence next to
your own is exactly the thing that would discredit the rest of the page.

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
  examples; whether that V2 address is live on mainnet is **not verified** and the page says so.
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
