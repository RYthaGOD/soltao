# soltao — Solana TAO Board

A one-page cheat sheet for the canonical Solana TAO mint. Built to be pasted into a CT reply
and settle the argument: which contract is real, how deep the book actually is, what the
look-alikes are, and which TAO-quoted coins exist.

**Canonical mint:** `taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY`
(Wormhole Native Token Transfers, issued through Sunrise, live since 5 May 2026.)

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
```

### Why the mint is hardcoded

The one fact this site exists to deliver must survive a dead API, a failed `pairs.json`
fetch, and JavaScript being off entirely. It is written into `index.html` in three places and
repeated in the `<noscript>` block. Live numbers degrade; the address does not.

---

## Running it locally

It uses ES modules and `fetch('pairs.json')`, so `file://` will not work — serve the folder:

```bash
npx serve .          # or: python -m http.server 8000
```

Then open `http://localhost:3000`.

## Deploying

Any static host. There is no build step — point it at the repo root and publish.

Currently live on two hosts, serving byte-identical content:

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
simply not canonical and has roughly $200 of liquidity, which is the thing that will hurt you.

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
ask for. TAO alone has 26 pools, so one combined request quietly drops the small coins.

`app.js` therefore fetches TAO on its own and chunks everything else six mints at a time
(`CHUNK`). If you add a lot of tokens to `pairs.json`, the chunking scales automatically —
but if a coin's numbers ever come back empty while Dexscreener shows a live pool, the cap is
the first thing to suspect.

---

## Things this deliberately does not do

No wallet connect. No backend or database. No charts. No subnet, validator or dTAO
analytics — [Taostats](https://taostats.io/) already does that and does it properly. No swap
routing; Jupiter handles the swap and the link is prefilled.

## Accuracy notes

- **The slippage table is an upper bound.** Constant-product maths (`impact = size ÷
  quote-side reserve`) against the single deepest pool. Jupiter splits across every pool and
  concentrated liquidity does better, so the real fill is usually cheaper. It is sized to
  make thin books visible, not to quote you.
- **"Canonical" is Wormhole's designation**, not a Bittensor Foundation endorsement.
- **The exit route claims are researched, not live-fetched.** Wormhole does not list Bittensor as
  a supported chain, so the only Bittensor↔Ethereum door is the `wTAO` bridge — closed source,
  single pseudonymous operator, manual withdrawal verification, ~$29M locked (DefiLlama, Sep 2026;
  governance reported by [DL News](https://www.dlnews.com/articles/defi/wrapped-tao-on-ethereum-soars-to-82m-but-its-all-controlled-by-one-person/)).
  The Bittensor EVM staking precompile interface is read from Opentensor's own
  [evm-bittensor](https://github.com/opentensor/evm-bittensor/blob/main/solidity/stakeV2.sol)
  examples; whether that V2 address is live on mainnet is **not verified** and the page says so.
  Re-check these before the next curation pass — they are the only numbers on the site that do
  not refresh themselves.
- **Bridged supply** is derived from Dexscreener's FDV ÷ price rather than an RPC call, to
  keep the page dependency-free. It is approximate.
- The 24h change and the quoted spot price come from the deepest pool; volume and liquidity
  are summed across every pool where TAO is the base token.

## Licence

MIT. Fork it, change the mint, point it at a different asset.
