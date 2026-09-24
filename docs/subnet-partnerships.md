# Subnet partnership research

Last updated: 2026-09-24

What soltao can offer a subnet: **a Solana entry point**. Someone holding canonical TAO in a
Solana wallet can reach Bittensor through soltao with a single wallet signature and no Bittensor
wallet of their own. Today that ends in root or subnet stake. The partnerships below make that
same route end in something the subnet wants, such as a paid account, stake in its Alpha, or
liquidity.

Some claims here were checked against source code, and those are marked **verified**. The rest
come from press and aggregators and are marked as such. The sandbox this was written in could not
reach the Bittensor RPC, taostats or chutes.ai, so there are no live emission or pool numbers
here. Pull them from the `/stake/` subnet directory before any outreach.

---

## 1. Chutes (SN64): the lead candidate

**What they are:** serverless AI inference (and now training) run on Bittensor miners. It is one
of the highest-usage subnets and a large OpenRouter provider. Users pay by topping up a USD credit
balance with TAO or fiat. X: [@chutes_ai](https://x.com/chutes_ai), 11.7K followers.

### How a Chutes top-up works (verified in `chutesai/chutes-api`, commit `3b5609f`, 3 Sep 2026)

- Every Chutes user gets their own **SS58 payment address** (`generate_payment_address` in
  `api/user/router.py`).
- `api/payment/watcher.py` scans every block and credits the user's USD balance, valued at the
  TAO fair-market price at that moment, when it sees either of these:
  - a **`Balances.Transfer`** of TAO to that address, or
  - a **`SubtensorModule.StakeTransferred`** with that address as the destination coldkey. This
    means stake on any subnet can be handed straight to Chutes as payment, credited at its TAO
    value.
- `api/autostaker.py` then **stakes the TAO into SN64 and burns the Alpha**. Alpha that arrives on
  a different subnet is moved to SN64 first, then burned. The constants are `MIN_STAKE_TAO = 0.1`
  and a dust floor of 0.01 TAO.
- Agent registration (`/users/agent_registration`) also takes payment in TAO sent to a payment
  address, with a default threshold of $50 (`AGENT_REGISTRATION_THRESHOLD`).

### Why it fits soltao

soltao's route already produces both events Chutes listens for:

| soltao step (`tools/stake/src/route.js`) | Emits | Chutes credits it? |
|---|---|---|
| `transferStake(coldkey, hotkey, netuid, netuid, amount)` | `StakeTransferred` | Yes, if the destination is a Chutes payment address |
| `transferAll(coldkey)` sweep | Balance transfer from the transit account | Should be `Balances.Transfer`. **Confirm with one small real deposit** |

So "pay Chutes from a Solana wallet" is a small change to a route that already works, not a new
product.

### The pitch to Chutes

1. **A new source of paying users.** Solana developers and AI builders can fund a Chutes account
   from Phantom or Solflare with the TAO they already hold. They don't need a Bittensor wallet,
   `btcli` or a centralised exchange.
2. **Every top-up buys SN64.** Chutes' autostaker converts each TAO payment into SN64 Alpha and
   burns it, so Solana-sourced revenue is buy pressure on their token. That comes from their own
   code, so it is a claim you can make without overselling.
3. **No work on their side.** Payments land through the path Chutes already runs. What we'd ask
   for is recognition: a "Top up from Solana" link on their billing page and docs, plus a
   co-announcement.
4. **We already route real funds.** soltao has carried real-funds root stakes and a real-funds
   return to Solana (see `tools/stake/HANDOVER.md`).

### Built: "Top up Chutes" on `/stake/` (switched off on the live site until one real test top-up)

Beside the free TAO in the holdings view, with the user's Chutes payment address pasted or taken
from a `soltao.xyz/stake/?chutes=5…` link. See item 18 in `tools/stake/HANDOVER.md`. The notes
below are the design it follows.

### Original design notes

- A **"Top up Chutes" destination** on `/stake/`. The user pastes their Chutes payment address,
  shown on their Chutes account page. The route lands TAO in the user's own derived coldkey as it
  does now. A separate, clearly labelled step, signed by that coldkey, then sends it to the Chutes
  address.
  - This keeps the rule stated at the top of `route.js`, that nothing in the route can send funds
    anywhere but the user's own coldkey. Paying a third party becomes a second, explicit action
    the user takes, not something hidden inside the route.
- A **real-funds test deposit** (≥0.1 TAO) to confirm that the credited USD amount matches.
- Optional: an "attribution" field, if Chutes wants to track Solana-sourced users (ask them).

### Open questions for the Chutes team

- Is the payment address on the account page stable per user, and is it safe for a third party to
  display it?
- Do they want a referral or attribution mechanism, and would they list soltao in their docs?
- Would they co-announce, from their account and soltao's?
- Fiat top-ups: is Solana USDC on their roadmap? If so, we could route USDC directly instead.

---

## 2. Hippius (SN75): decentralised storage

**What they are:** decentralised cloud storage, with IPFS pinning and S3-compatible object
storage, built by The Nerve Lab. It runs on its own Substrate chain ("thebrain") bridged to
Bittensor. X: [@hippius_subnet](https://x.com/hippius_subnet). Billing uses prepaid credits
(1 credit = $1), topped up with TAO or fiat (Stripe) in the web console, with Alpha "coming soon"
according to press guides. That TAO top-up happens off-chain in their console backend, which isn't
open source, so how it works has to come from their team.

### The Alpha bridge (verified in `thenervelab/thebrain`, commit `3187525`, 9 Sep 2026)

- The Bittensor-side contract is `contracts/bridge`. Its `deposit(amount, hotkey)` locks **SN75
  Alpha stake** by moving it from the caller to the contract. The caller must first add the
  contract as a proxy. The minimum deposit is 1 Alpha.
- Guardians watch Bittensor and mint **hAlpha on Hippius** to the **same account** that made the
  deposit (`pallets/alpha-bridge`). The `credits` pallet has a `ConvertedToCredits` event and
  tracks an `alpha_price`. From that, hAlpha appears to be what turns into storage credits. **Ask
  them to confirm.**
- Withdrawals go the other way: burn hAlpha on Hippius and get Alpha released on Bittensor.

### Why it fits soltao

- soltao can already take TAO from Solana and stake it into **SN75 Alpha** under the user's
  derived coldkey. That is exactly what the Hippius bridge needs as its input.
- The derived coldkey is an ordinary 12-word sr25519 mnemonic that imports into any Substrate
  wallet (`tools/stake/HANDOVER.md`). The Hippius account it credits is therefore one the user can
  open in Hippius directly, with no third-party address involved.
- Possible product: **"Solana → Hippius storage credits"**, meaning stake SN75, then deposit to
  the bridge, in one flow. Because the funds stay with the user's own key throughout, this also
  keeps the rule that the route pays only the user's coldkey. Only the proxy grant to Hippius's
  contract is new, and it should be shown to the user explicitly.

### The pitch to Hippius

1. They get a Solana audience for a product that competes with S3. Solana projects need storage for
   NFTs, app assets and AI datasets, and IPFS pinning is already familiar to them.
2. Every Solana top-up enters through **SN75 Alpha**, which is buy pressure on their token, not TAO
   sold off-chain.
3. It sits alongside their fiat path: a crypto-native top-up for people who won't use Stripe.

### Open questions for the Hippius team

- The console's "pay with TAO": does it credit a plain TAO transfer to a per-user address, the way
  Chutes does? If so, soltao can ship that first. It's simpler than the proxy-plus-bridge flow.
- Is hAlpha → credits the intended path for third-party integrations, and is the Alpha top-up now
  live?
- Is the bridge contract address on Bittensor mainnet published, and is it audited?
- Would they list "Top up from Solana" in the console or docs, and co-announce?

---

## 3. Targon (SN4): confidential compute

**What they are:** confidential (TEE) GPU compute and inference from Manifold Labs, which has
raised a $10.5M Series A. Press reports it as the **highest-revenue subnet, at around $10.4M
annualised** (unverified). Manifold also makes **tao.xyz**, a Bittensor wallet and terminal, and
the Sybil search product.

### What could and couldn't be verified

- `manifold-inc/targon` (commit `ee52c6b`, 23 Sep 2026) is the miner, validator and CLI stack.
  **Customer billing isn't in the public code**, and nothing public says whether customers can top
  up in TAO or to what address. That is the first question to ask.

### Why it fits soltao, and the caveat

- If Targon takes TAO for credits, it is the same play as Chutes: the highest-revenue subnet
  getting a Solana payment rail.
- If it doesn't, the fallback is **"Stake SN4 from Solana"**. That gets Solana holders into
  Targon's Alpha, and soltao already supports it.
- **Caveat:** tao.xyz is Manifold's own wallet, so they may see a Solana on-ramp as something they
  would rather build in-house. Frame soltao as complementary: soltao brings Solana holders in, and
  tao.xyz can be where they manage the position afterwards, since soltao's coldkey is a standard
  mnemonic that imports anywhere.

### Open questions for Manifold

- Does Targon billing accept TAO, or Alpha as Chutes does? If so, is there a per-user deposit
  address?
- Would tao.xyz import soltao-derived coldkeys, or link out to soltao for Solana deposits?

---

## 4. Other candidates

Ranked by fit with "Solana entry point". Revenue figures come from press and are unverified.

| Subnet | What they do | Why they'd care about soltao | Fit |
|---|---|---|---|
| **Allways (SN7)**, entrius | Trustless cross-chain swaps; BTC↔TAO live, SOL and subnet Alpha pairs (sol↔sn7, sol↔sn74) being added | Already on soltao's board as the no-wrapper exit. Cross-listing both ways fits naturally: they cover swaps, soltao covers bridge and stake | High, as a mutual referral |
| **Ridges (SN62)** | Marketplace for autonomous coding agents; high mindshare | Consumer- and developer-facing, with an audience that overlaps Solana developers | Medium |
| **Gradients (SN56)**, Rayon Labs | Model training as a service | Paid by developers. Rayon also runs SN19 (inference) | Medium, one intro reaches both subnets |
| **Score (SN44)** | AI football analytics | Consumer brand, with an audience that overlaps the Solana memecoin and sports crowd | Low to medium |
| **VoidAI (SN106)** | wTAO/wAlpha bridge plus Solana liquidity incentives | **Be careful.** soltao's board lists VoidAI's wTAO as `legacy`, with a dead book. They compete on Solana TAO and cooperate only if they migrate to the canonical mint | Low. Handle it diplomatically |

The strongest general angle for any subnet: **a "Stake on SN-X from Solana" deep link**
(`/stake/?netuid=X`). That gives a subnet a way to get Solana holders into its Alpha. Offer it to
any subnet team that wants a Solana audience. Check first that the page supports that query
parameter, and add it if it doesn't.

---

## Suggested order

1. **Chutes.** Build the top-up destination, do one real test deposit, then DM @chutes_ai with a
   working demo and the three-line pitch above.
2. **Hippius.** Ask how TAO top-ups work in the console. If they use a per-user address, it is the
   same build as Chutes. If not, propose the SN75 stake → Alpha bridge flow.
3. **Targon.** Ask about TAO billing first. If there isn't any, lead with "Stake SN4 from Solana"
   and position soltao next to tao.xyz rather than against it.
4. **Allways.** Cross-listing, low effort.
5. Stake deep links for whichever subnet teams want Solana reach.

Chutes, Hippius and Targon make one story: **compute, storage and confidential compute, all
payable from a Solana wallet**. Pitch each of them on the others being in, once they are.

## Sources

- `chutesai/chutes-api` on GitHub: `api/payment/watcher.py`, `api/autostaker.py`,
  `api/user/router.py`, `api/config/__init__.py` (read 24 Sep 2026)
- [Chutes payments](https://chutes.ai/app/research/payments) and [SN64 on taostats](https://taostats.io/subnets/64/chart)
- [Crypto Briefing: subnet annualised revenue](https://cryptobriefing.com/bittensor-subnets-annualized-revenue/)
- [Own Your Mind: verified revenue rankings](https://ownyourmind.ai/tokenomics/bittensor-subnets-where-the-revenue-is/)
- `thenervelab/thebrain` on GitHub: `contracts/bridge/src/lib.rs`, `pallets/alpha-bridge`,
  `pallets/credits` (read 24 Sep 2026); `thenervelab/hippius-sdk`
- [Hippius](https://hippius.com/), [SimplyTao: guide to Hippius SN75](https://simplytao.ai/blog/your-simple-guide-to-hippius-sn75)
- `manifold-inc/targon` on GitHub (read 24 Sep 2026); [Manifold Labs](https://www.manifold.inc/)
- [entrius/allways](https://github.com/entrius/allways) and [PR #708 (SN7/SN74 pairs)](https://github.com/entrius/allways/pull/708)
- [v0idai/SN106](https://github.com/v0idai/SN106)
