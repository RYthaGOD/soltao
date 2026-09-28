// A real wallet holding at least `min` SOLTAO (6 decimals) and some SOL, found among the SOLTAO pool's
// recent swaps, for the tests that simulate or open the page as one. Read-only; nothing is signed.

import { PublicKey } from "@solana/web3.js";
import { CONFIG } from "../src/config.js";
import { getSoltaoBalance } from "../src/soltao_swap.js";

export async function findSoltaoHolder(connection, min) {
  const sigs = await connection.getSignaturesForAddress(new PublicKey(CONFIG.soltao.pool), { limit: 40 });
  for (const { signature, err } of sigs) {
    if (err) continue;
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    for (const b of tx?.meta?.postTokenBalances || []) {
      if (b.mint !== CONFIG.soltao.mint || !b.owner || BigInt(b.uiTokenAmount.amount) < min) continue;
      const owner = new PublicKey(b.owner);
      if (!PublicKey.isOnCurve(owner.toBytes())) continue; // a program's vault, not a wallet
      const [bal, lamports] = await Promise.all([getSoltaoBalance(connection, b.owner), connection.getBalance(owner)]);
      if (bal >= min && lamports > 10_000_000) return b.owner;
    }
  }
  return null;
}
