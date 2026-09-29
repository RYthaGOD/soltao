// Solana send confirmation: a lagged RPC must not be treated as "nothing was sent".
// Kept out of solana.js so tests do not load the OFT SDK.

const landed = (st) => Boolean(st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"));

/**
 * Wait until `signature` is confirmed, failed, or its blockhash expires.
 *
 * A height past `lastValidBlockHeight` is not proof the transaction dropped: the RPC can lag the
 * slot. That case is `uncertain`, never "nothing was sent". Only `failed` (a chain error) is safe
 * to treat as a dead send.
 */
export async function confirmSignature(connection, signature, lastValidBlockHeight, {
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  lagMs = 4_000,
  pollMs = 2_000,
} = {}) {
  for (;;) {
    const [{ value: [st] }, height] = await Promise.all([
      connection.getSignatureStatuses([signature]),
      connection.getBlockHeight("confirmed"),
    ]);
    if (st?.err) return { ok: false, failed: true, why: `failed on Solana: ${JSON.stringify(st.err)}` };
    if (landed(st)) return { ok: true };
    if (height > lastValidBlockHeight) {
      await sleep(lagMs);
      const { value: [final] } = await connection.getSignatureStatuses([signature]);
      if (final?.err) return { ok: false, failed: true, why: `failed on Solana: ${JSON.stringify(final.err)}` };
      if (landed(final)) return { ok: true };
      return {
        ok: false,
        uncertain: true,
        why: "Solana did not confirm in time: waiting for the bridge in case it landed. Do not send again.",
      };
    }
    await sleep(pollMs);
  }
}

/**
 * Whether the page may drop a remembered Solana send and offer a new one.
 * `status` is one getSignatureStatuses value, or `undefined` if the read failed.
 * A signature with no RPC record is only forgettable after `sentAt` is older than a
 * blockhash lifetime plus lag (3 minutes): until then it may still land.
 */
export function mayForgetPending({ holds, sig, status, sentAt, now = Date.now() }) {
  if (holds) return false;
  if (!sig) return true;
  if (status === undefined) return false;
  if (status?.err) return true;
  if (status && (status.confirmationStatus === "processed" || status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return false;
  if (!status && sentAt && now - Number(sentAt) > 3 * 60_000) return true;
  return false;
}
