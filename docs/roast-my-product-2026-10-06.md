# soltao roast — 6 October 2026

Lens: a Colosseum Crypto World's Fair judge, six days before the close. Concerns: demand, trust,
UX and story (Craig: "all the above"). Compared with the 30 Sep roast (70/110,
`docs/roast-my-product-2026-09-30.html`).

Evidence read today: `npm run usage` (6 Oct ~11:30 UTC), the mint's supply over api.mainnet-beta,
the live page (`stake.js?v=2771a2fd`, same bytes as the committed file), `research/colosseum/packet.html`,
the founder script, HANDOVER, and Colosseum Copilot (projects and archives, as of 2026-10-06).

## Verdict

Superb plumbing into a 10,000-TAO puddle, pitched as the pipe for an AI economy that hasn't sent a
single drop through it.

## Scorecard

| Dimension | Score | Justification |
|---|---|---|
| Value Proposition (2x) | 6/10 | "10,000 TAO on Solana, none of it stakeable" is crisp in the pitch. The landing page (since 2 Oct) opens on a subnet spreadsheet instead. |
| Crypto Necessity | 9/10 | Above 7 because the product is cross-chain settlement into native stake. Postgres can't do any of it. |
| Target User Clarity | 5/10 | "Canonical Solana TAO holders" is real. Both partner conversations stalled, and the AI-agent persona has zero routes. |
| First-Time UX | 5/10 | The no-funds judge path is good. Actually staking needs canonical TAO first (a Jupiter detour), 5 steps, 12 words and a tab kept open. |
| Core Loop | 4/10 | One outside wallet came back to route again. The round-trip proof is, read cold, a $45 stake that left the next day. |
| Competitive Moat | 3/10 | Copilot finds nothing like it in 5,400+ submissions, but being new isn't a moat. It's MIT-licensed, and a fee-free fork is an afternoon's work. |
| Technical Execution | 8/10 | Zero-cost mainnet replay, no contract, resume from chain state, strict CSP. Not 9 while Move and Claim are live without a real-funds run. |
| Naming & Messaging | 5/10 | The product, board, coin and socials share one name. The 1 Oct holder discount ties the coin back to the product. "I build pipes" works. |
| Monetization | 4/10 | 0.25% is live and collecting (0.369 SOL). If the entire Solana float routed once, it would pay about 26 TAO. |
| Market Timing | 6/10 | The float is growing (10,271.7 to 10,386.75 TAO, 4 to 6 Oct) and agent payments are a live theme. Agents buying from Bittensor via Solana is still a belief. |
| **Weighted total** | **61/110** | Needs significant work. Down 9 from 30 Sep. About a third of that comes from the judge doing the ceiling maths. The rest is real: no routes in three days, the coin tied back in, and a spreadsheet as the landing page. |

## The worst issues

### 1. Traction has flatlined in the final week

**What's wrong:** there are 9 routes from 7 wallets, re-counted on chain today. The last one was 3 Oct
16:30 UTC, nearly three days ago. Three of the nine routes are Craig's and one is a wallet he funded.
About 80% of the ~54 TAO came from one wallet (FH9zKY…, 43.05 TAO). Two of the "four not mine"
(9AEqMf…, cKR3xq…) are still unconfirmed, but the founder script says "four of them not mine" as a
fact.

**Why it matters:** Colosseum asks about demand directly, and the packet calls it the weakest part
of the entry. A judge reads "live since 23 Sep, 9 routes, nothing since 3 Oct" as launched and
stalled. If either wallet is Craig's, the recorded pitch states a false number. That is exactly what
the accuracy bar exists to prevent.

**What good looks like:** 5 or more new outside routes before 11 Oct, each with a one-line origin
(for example "found it on the board" or "the agent operator's first route"). Confirm both wallets
before the first take.

### 2. The pitch sells a thesis the product doesn't serve yet

**What's wrong:** the founder video and the deck say "AI will buy its own compute, storage and
inference; soltao is the pipe." Nothing AI has gone through it:
- the Chutes top-up is off (`chutesLive: false`);
- storage and compute aren't built;
- the one AI-agent operator held off.

What's live is a staking interface for people.

**Why it matters:** staking alone has a ceiling a judge can work out in their head. Solana holds
10,386.75 TAO (read today). 0.25% of all of it, once, is about 26 TAO, roughly $7.8k at 4 Oct's
$301.71. The thesis is the only way past that ceiling, and it's the part that's switched off. A judge
hears an AI x crypto pitch, clicks through, and lands on a 128-row subnet table.

**What good looks like:** one real top-up of at least 0.01 TAO to Craig's own Chutes account, with
the credit confirmed and the flag flipped, so the demo shows a Solana wallet paying for inference.
Otherwise, cut the thesis to one sentence and pitch the staking route honestly. Don't pitch both as
if both work.

### 3. The coin keeps costing the distribution soltao needs

**What's wrong:**
- The coin launched on 20 Sep, the same day as the first commit.
- The board's "soltao on X / Telegram" links are the coin's accounts.
- On 1 Oct the product added a fee discount for holding 10M or 50M $SOLTAO, so the product page now
  gives people a commercial reason to buy the coin.
- The builder is solo, behind a pixel-art PFP.

**Why it matters:** both partner conversations stalled on trust. The $BUTT community refused to send
users because soltao has a token, and the agent operator held off because they don't know Craig.
Distribution is the only moat available, and "the route doesn't need it" now comes with a footnote.
Because of the fee floors, the discount changes nothing under about 0.5 TAO, so it costs that trust
for almost no revenue. Copilot's archive puts it this way ("Before It Was Obvious", Alliance):
"Customers obsess over what they have to give up." What a user gives up here is trust in a stranger's
key derivation.

**What good looks like:** product socials that aren't the coin's (or point at @Moneybag_Fin), and
the discount parked until after judging. Also publish the check soltao already passes but never
mentions: the live `stake.js` sha256 begins `2771a2fd`, which matches the page's `?v=` and the
committed file (checked 6 Oct). One command in the README's "For judges" block turns "trust the
page" into "verify the page".

### 4. Live buttons that have never moved real funds, a week after the last roast flagged them

**What's wrong:** Move, Claim, stake-more and root unstake are live for everyone and have never moved
real funds. That was the #1 fix on 30 Sep. Since 1 Oct there have been 15 commits and 7 new video
renders in `marketing/video/out/`, but no Move or Claim run. Meanwhile `stake/index.html` says "real
funds" 10 times and "have not" three times.

**Why it matters:** a judge with a position who clicks Move is the first real test. The pile of
disclaimers reads as defensive.

**What good looks like:** one Move and one Claim at the minimum (a few dollars; a Claim's Bittensor
fee was about 0.008 TAO on 25 Sep), then cut the disclaimers to one line. Or hide those buttons until
they've run.

### 5. The first screen is a spreadsheet

**What's wrong:** since 2 Oct the subnet list has been the landing page. It reads "The list is the
choice", above columns for Alpha price, TAO in its pool, TAO added per day, take, last-epoch dividend
share and 30-day paid stakers, and it ends with "Nothing here is a recommendation." Doing anything
then means:
- holding canonical Solana TAO first (Jupiter, in a second tab);
- signing, and saving 12 words;
- reading about 13 fee rows;
- keeping the tab open for minutes.

**Why it matters:** a Solana judge who doesn't know dTAO faces 128 choices with nothing to steer
them. The "two minutes, no funds" path for judges is good, but it starts with a choice they can't
make yet.

**What good looks like:** lead with one path, "Stake on root: your TAO stays TAO", and put the table
second. Pay-with-SOL (flagged 28 Sep) would remove the Jupiter detour, after the deadline.

## Common sins detected

- **Phantom users (soft):** "7 wallets" counts two of Craig's and one he funded, and two
  unconfirmed wallets are presented as outside users.
- **Token-first (relapse):** the 1 Oct holder discount. It was avoided for the route itself, then
  brought back through the fee.
- **Bridge to nowhere (partial):** the route works. The packet's partner evidence is still dated
  27 Sep.
- **No retention loop:** FH9zKY… is the only outside wallet that routed twice. There's nothing to
  bring anyone back.
- **Jargon overload:** the landing table (Alpha, take, dividend share, netuid) and the transit
  account.
- Not detected: ornamental blockchain, governance theater, grant dependence. MEV bait was fixed:
  `addStakeLimit` caps at 2% and the quote comes from the chain's own simulation.

## UX red flags

- **Wallet before value:** passes. Subnets, charts and validators all show without a wallet.
- **Simulation and fees:** passes. The transaction is simulated against mainnet, and every fee is
  itemised in USD and as a share of the amount.
- **No onboarding for non-crypto users:** 12 words, a "transit account", and "Lose one, lose both."
- **Mobile:** it only works inside a wallet's browser. There are deep links to Phantom and Solflare,
  but no newcomer has been seen completing the flow on a phone.
- **Loading:** depends on public Bittensor RPCs that rate-limit within 60 s, and a 429 shows up as
  "Failed to fetch."
- **Long-running tab:** "Keep this page open until step 5 finishes." Resuming from chain state
  softens it.

## Fix these now

1. **Highest impact: 5 outside routes before 11 Oct.**
   - Today, send the agent operator the proof pack and offer to do their first route together on a
     call.
   - Send the subnet draft in `docs/subnet-pilot-and-roast-2026-09-24.md` to one subnet.
   - Post the 1 Oct round trip, with transaction links, from @Moneybag_Fin rather than the coin's
     account.
   - Re-run `npm run usage` right before recording and say the real number, even if it's still 9.
2. **Easiest win: two 10-minute jobs tonight.**
   - Confirm whether 9AEqMf… and cKR3xq… are Craig's, and fix the founder script if either is.
   - Add the sha256 check to the README's "For judges" block. It costs nothing and turns "built to
     be checked" from a claim into a demo.
3. **Existential: make the services pipe real.** Top up Craig's own Chutes account with at least
   0.01 TAO, confirm it's credited, and flip `chutesLive`. Then show it in the demo. Without that,
   soltao is a staking widget with a market of about 26 TAO in fees, and the AI thesis has nothing
   behind it.

## Sources

- `npm run usage`, 6 Oct 2026 ~11:30 UTC: 9 routes, 7 wallets, 0.368833032 SOL; last route
  2026-10-03T16:30 (cKR3xq…).
- `getTokenSupply` for the canonical TAO mint, 6 Oct: 10,386.752 TAO. The 4 Oct figure (10,271.7)
  and the $301.71 price (Dexscreener, display only) are from the packet.
- Live `https://soltao.xyz/stake/stake.js?v=2771a2fd`: its sha256 matches the committed
  `stake/stake.js` (2771a2fd03bd…).
- Colosseum Copilot, 6 Oct:
  - Project searches ("Bittensor TAO staking from Solana wallet", "bridge Bittensor TAO to Solana
    subnet stake"): the top matches are `stakes` (Renaissance, Mar 2024, 0.054) and
    `solana-bridge-bot` (Radar, Sep 2024, 0.048), with no Bittensor project.
  - Winners only: AI-agent winners (`forge-ai`, `xaam`, `project-plutus`, Breakout, Apr 2025),
    none on Bittensor.
  - Accelerator only: no cross-chain staking overlap.
  - Archives: Galaxy Research "Decentralized AI Training", and Alliance "Before It Was Obvious".
  - This is based on the corpus available, not proof that no one else is building it.
