// Everything the stake page trusts, in one place. Every address and limit here was read from chain
// or measured against it on 21 Sep 2026 (research/self-custody-route-research.md). No contract of
// soltao's is involved: the route uses the canonical TAO OFT, wTAO and Bittensor's precompiles only.

export const CONFIG = {
  solanaRpc: "https://solana-rpc.publicnode.com", // Helius (joell-lsu6ge) answers 403 since the plan lapsed, 25 Sep 2026
  // Browser Origin: https://soltao.xyz, measured 29 Sep 2026. PublicNode's two hostnames both return
  // 200; api.mainnet-beta.solana.com and Helius 403. Helius stays in both CSPs for a plan restore.
  solanaRpcs: [
    "https://solana-rpc.publicnode.com",
    "https://solana.publicnode.com",
  ],
  bittensorEvmRpc: "https://lite.chain.opentensor.ai",
  // Lite first (what the page tests intercept); archive when lite 429s or times out.
  bittensorEvmRpcs: [
    "https://lite.chain.opentensor.ai",
    "https://archive.chain.opentensor.ai",
  ],

  // Canonical Solana TAO: LayerZero V2 OFT, SPL Token, 9 decimals, 6 shared.
  taoMint: "taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY",
  taoOftProgram: "tao3RyGP8XiiWQKmBzkiULmPoMewWjq65b46H4rTAQQ",
  taoOftEscrow: "FeiTZPe7uJYJLux1CahrQnU94SjSXQ6zsdgobLm658LN",
  // LayerZero's address lookup table on Solana mainnet; the send does not fit a transaction without it.
  lookupTable: "AokBxha6VMLLgf97B5VYHEtqztamWmYERBmmFvjuTzJB",
  bittensorEid: 30374,
  decimals: 9,
  // ld2sd = 1000: amounts below 0.000001 TAO do not cross and must be trimmed before sending.
  dustLd: 1000n,
  // The OFT send measured 506k compute units in simulation; LayerZero's ULN alone ~379k.
  computeUnits: 650_000,
  // Solana priority fee, in micro-lamports per compute unit: the 75th percentile of recent fees paid
  // on the TAO program's own writable accounts, clamped. At the cap, 650k units cost 0.00013 SOL; at
  // the floor, 0.00000325 SOL. Without it a busy slot can drop the transaction until it expires.
  priorityFee: { minMicroLamports: 5_000n, maxMicroLamports: 200_000n },

  // wTAO on Bittensor EVM: the OFT's other end. Deliveries arrive as this ERC-20.
  wtao: "0x134f59E8B8637FD70ae12f263492B1dc73A25D1e",

  // Native TAO LayerZero's executor drops on the transit account with the delivery, so it can pay
  // for its first transaction (the unwrap). 0.001 TAO covers a 60k-gas unwrap up to ~16 gwei.
  gasDropWei: 1_000_000_000_000_000n,

  // Gas limits for the transit account's transactions, each ~1.4x the minimum measured on mainnet.
  gasLimit: {
    unwrap: 60_000n,        // measured minimum 43,181
    addStake: 140_000n,     // 100,637
    // transferStake is refused unless ~2.36M gas is on hand (its declared weight), though it uses
    // ~62k. A plain account pays only for gas used, but must hold limit x price up front.
    transferStake: 2_450_000n, // 2,357,280
    sweep: 45_000n,         // transferAll: 27,545
  },
  // Gas each step actually uses, from the same measurements. Only this is charged; the page shows it
  // as the route's Bittensor cost, paid in TAO on arrival.
  gasUsed: { unwrap: 43_181n, addStake: 100_637n, transferStake: 62_000n, sweep: 27_545n },

  // soltao's fee (src/fees.js): 0.25% of what an action moves, on everything. The route pays it in SOL, a
  // plain transfer to `wallet` inside the same Solana transaction, never less than 0.0035 SOL (the TAO
  // valued at the Orca TAO/SOL pool's price). Bittensor actions pay it in TAO to `bittensor`, batched with
  // the action, never less than 0.001 TAO. Shown before signing. The page refuses to send until `wallet`
  // is set. Both addresses supplied by Craig: `wallet` on 21 Sep 2026 (an on-curve key owned by the System
  // Program, so an ordinary wallet); `bittensor` on 28 Sep 2026 (a valid SS58 coldkey, not a hotkey).
  // Until 29 Sep 2026 the route fee was a flat 0.003 SOL (0.0075 SOL at launch).
  fee: {
    wallet: "BgGFMbwUtKLifQYZogbDorEXTXYp3UKVAZSH41xQ72Na",
    bittensor: "5Cvj3sq8RU2m6vFQmz2jFVix8sqBfWcuqyGKaCnMXyf9QG94",
    bps: 25n,
    minLamports: 3_500_000n, // 0.0035 SOL
    minRao: 1_000_000n, // 0.001 TAO
  },
  // The pool the route's fee values TAO at (src/orca.js): the deepest canonical TAO/SOL pool on Solana.
  orca: { program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", pool: "BM1KpngQa9efH9k6cDvRGatGqE95xbZdLKJHdFKcmBMC" },

  // A subnet stake swaps TAO into the subnet's Alpha pool, and the transit account's transaction sits
  // in a public mempool. So it is sent as addStakeLimit, refusing any fill worse than this much above
  // the pool price read just before sending. A refusal delivers the TAO unstaked, as any other refusal.
  // Root has no pool, so root stakes stay plain addStake.
  subnetPriceToleranceBps: 200n, // 2%

  // The Bittensor -> Solana return, with unstake/stake from the holdings view. Switched on in production
  // on 24 Sep 2026 at Craig's explicit request, before its first real-funds run (wallets refuse the
  // sign-in on localhost, so that run has to happen on the live page).
  returnLive: true,

  // "Top up Chutes" in the holdings view (src/payments.js): free TAO from the coldkey to a pasted
  // Chutes payment address. Off in production until one small real-funds top-up has been credited by
  // Chutes; local hosts open it for testing.
  chutesLive: false,

  // Kept unstaked in the user's wallet so they can pay for their own unstake later.
  defaultReserveRao: 10_000_000n, // 0.01 TAO
  // Twice subtensor's nominator minimum (NominatorMinRequiredStake, 0.01 TAO read 26 Sep 2026): smaller
  // stakes can be swept back to free balance, so this leaves room for the Alpha price to move.
  minStakeRao: 20_000_000n, // 0.02 TAO
};

export const solanaRpcs = () => CONFIG.solanaRpcs ?? [CONFIG.solanaRpc];
export const bittensorRpcs = () => CONFIG.bittensorEvmRpcs ?? [CONFIG.bittensorEvmRpc];
