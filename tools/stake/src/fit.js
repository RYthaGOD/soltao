// How much of the TAO an unstake freed can go to Solana in a chained return. The return's own costs
// (bridge fee, gas held on transit, the funding transfer's fee) come out of the same free balance, so
// the amount is shrunk until what they leave free is at least `keep`. Funding grows one rao per rao
// returned, so one correction lands it; a second pass confirms against a fresh quote.

/**
 * `leftAfter(amount)` resolves to the coldkey's free rao after a return of `amount`, fees included.
 * `floor(amount)` rounds down to what the bridge carries. Returns 0n when nothing worthwhile fits.
 */
export async function fitReturnAmount({ freed, free, keep, min, floor, leftAfter }) {
  let amount = floor(freed < free ? freed : free);
  for (let i = 0; i < 3 && amount >= min; i++) {
    const left = await leftAfter(amount);
    if (left >= keep) return amount;
    amount = floor(amount - (keep - left));
  }
  return 0n;
}
