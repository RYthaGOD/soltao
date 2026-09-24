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

### What to build before reaching out (a proposal, not built yet)

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

## 2. Other candidates

Ranked by fit with "Solana entry point". Revenue figures come from press and are unverified.

| Subnet | What they do | Why they'd care about soltao | Fit |
|---|---|---|---|
| **Targon (SN4)**, Manifold Labs | Confidential GPU compute and inference; reported as the highest-revenue subnet (~$10.4M annualised) | Same shape as Chutes if they accept TAO top-ups. **Check** whether their billing takes TAO to an SS58 address | High, if TAO billing exists |
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
2. **Allways.** Cross-listing, low effort.
3. **Targon.** Confirm TAO billing, then run the same play as Chutes.
4. Stake deep links for whichever subnet teams want Solana reach.

## Sources

- `chutesai/chutes-api` on GitHub: `api/payment/watcher.py`, `api/autostaker.py`,
  `api/user/router.py`, `api/config/__init__.py` (read 24 Sep 2026)
- [Chutes payments](https://chutes.ai/app/research/payments) and [SN64 on taostats](https://taostats.io/subnets/64/chart)
- [Crypto Briefing: subnet annualised revenue](https://cryptobriefing.com/bittensor-subnets-annualized-revenue/)
- [Own Your Mind: verified revenue rankings](https://ownyourmind.ai/tokenomics/bittensor-subnets-where-the-revenue-is/)
- [entrius/allways](https://github.com/entrius/allways) and [PR #708 (SN7/SN74 pairs)](https://github.com/entrius/allways/pull/708)
- [v0idai/SN106](https://github.com/v0idai/SN106)
