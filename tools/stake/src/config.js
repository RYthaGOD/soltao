// Everything the stake page trusts, in one place. Every address and limit here was read from chain
// or measured against it on 21 Sep 2026 (research/self-custody-route-research.md). No contract of
// soltao's is involved: the route uses the canonical TAO OFT, wTAO and Bittensor's precompiles only.

export const CONFIG = {
  solanaRpc: "https://joell-lsu6ge-fast-mainnet.helius-rpc.com",
  bittensorEvmRpc: "https://lite.chain.opentensor.ai",

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

  // soltao's fee: a plain SOL transfer inside the same Solana transaction, shown before signing.
  // The page refuses to send until the wallet is set. Wallet supplied by Craig on 21 Sep 2026; checked
  // on chain that day: an on-curve key owned by the System Program, so an ordinary wallet.
  fee: { wallet: "BgGFMbwUtKLifQYZogbDorEXTXYp3UKVAZSH41xQ72Na", lamports: 3_000_000n }, // 0.003 SOL

  // Kept unstaked in the user's wallet so they can pay for their own unstake later.
  defaultReserveRao: 10_000_000n, // 0.01 TAO
  // Subtensor's nominator minimum; smaller stakes can be swept back to free balance.
  minStakeRao: 20_000_000n, // 0.02 TAO
};
