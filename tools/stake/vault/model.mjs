// Offline specification model. Inputs are trusted simulated settlement events, NOT bridge proofs.
// No signing, RPC, mint authority, or production contract is implemented here.
const OFFSET = 1_000_000_000n;
const amount = (n) => {
  if (typeof n !== "bigint" || n <= 0n) throw Error("amount must be a positive BigInt");
  return n;
};
const key = (s) => { if (typeof s !== "string" || !s.trim()) throw Error("missing identifier"); return s; };
const fingerprint = e => JSON.stringify(Object.keys(e).sort().map(k => [k, typeof e[k] === "bigint" ? `${e[k]}n` : e[k]]));

export function createVault(domain = "root-tao-offline-v1") {
  return { domain: key(domain), active: 0n, liquid: 0n, staked: 0n, pending: 0n, reserved: 0n, quarantined: 0n,
    unclaimed: 0n, supply: 0n, incoming: 0n, payouts: 0n, refunds: 0n, expenses: 0n,
    losses: 0n, paused: false, balances: new Map(), deposits: new Map(), exits: new Map(), unstakes: new Map(), allocations: new Set(), events: new Map() };
}

export function assertConservation(s) {
  for (const n of [s.active, s.liquid, s.staked, s.pending, s.reserved, s.quarantined, s.unclaimed, s.supply,
    s.incoming, s.payouts, s.refunds, s.expenses, s.losses]) {
    if (typeof n !== "bigint" || n < 0n) throw Error("negative or invalid accounting balance");
  }
  if (s.active !== s.liquid+s.staked) throw Error("asset location mismatch");
  if ([...s.balances.values()].some(n => n < 0n) ||
      [...s.balances.values()].reduce((a,b) => a+b, 0n) !== s.supply) throw Error("share conservation failed");
  const pending = [...s.deposits.values()].filter(d => d.status === "pending").reduce((a,d) => a+d.amount, 0n);
  const reserved = [...s.exits.values()].filter(d => d.status === "reserved").reduce((a,d) => a+d.amount, 0n);
  if (pending !== s.pending || reserved !== s.reserved) throw Error("operation ledger mismatch");
  if (s.incoming !== s.active+s.pending+s.reserved+s.quarantined+s.payouts+s.refunds+s.expenses+s.losses) {
    throw Error("asset conservation failed");
  }
  return true;
}

export const previewDeposit = (s, assets) => amount(assets) * (s.supply + OFFSET) / (s.active + 1n);
export const previewExit = (s, shares) => amount(shares) * (s.active + 1n) / (s.supply + OFFSET);

// Atomic transitions: failures leave input untouched. Event IDs bind the full payload and domain.
export function applyEvent(previous, e) {
  assertConservation(previous);
  if (e.domain !== previous.domain) throw Error("wrong vault domain");
  key(e.id);
  const stamp = fingerprint(e);
  if (previous.events.has(e.id)) {
    if (previous.events.get(e.id) !== stamp) throw Error("event ID reused with different payload");
    return previous;
  }
  const s = structuredClone(previous);
  const balance = owner => s.balances.get(key(owner)) ?? 0n;
  const pricing = () => {
    if (s.paused) throw Error("pricing paused");
    if (s.unclaimed) throw Error("realize outstanding rewards before pricing");
    if (s.supply > 0n && s.active === 0n) throw Error("insolvent vault: recapitalization policy required");
  };
  switch (e.type) {
    case "depositReceived": {
      if (s.paused) throw Error("new deposits paused");
      key(e.owner); key(e.operation);
      if (s.deposits.has(e.operation)) throw Error("deposit operation already exists");
      amount(e.amount); amount(e.minShares);
      s.deposits.set(e.operation, { owner: e.owner, amount: e.amount, minShares: e.minShares, status: "pending" });
      s.incoming += e.amount; s.pending += e.amount;
      break;
    }
    case "depositAccepted": {
      pricing();
      const d = s.deposits.get(e.operation);
      if (!d || d.status !== "pending") throw Error("deposit is not pending");
      const shares = previewDeposit(s, d.amount);
      if (shares === 0n || shares < d.minShares) throw Error("minimum shares not met");
      s.pending -= d.amount; s.active += d.amount; s.liquid += d.amount; s.supply += shares;
      s.balances.set(d.owner, balance(d.owner)+shares);
      d.status = "accepted"; d.shares = shares;
      break;
    }
    case "depositRefunded": {
      const d = s.deposits.get(e.operation);
      if (!d || d.status !== "pending") throw Error("deposit is not refundable");
      s.pending -= d.amount; s.refunds += d.amount; d.status = "refunded";
      break;
    }
    case "rewardsObserved":
      s.unclaimed += amount(e.amount); break;
    case "rewardsRealized": {
      if (!s.unclaimed) throw Error("no outstanding rewards");
      // In this model observation equals eventual realization; valuation uncertainty is deferred.
      if (e.amount !== s.unclaimed) throw Error("reward reconciliation required");
      // Bittensor Root claims restake their proceeds, rather than paying free TAO.
      s.incoming += e.amount; s.active += e.amount; s.staked += e.amount; s.unclaimed = 0n; break;
    }
    case "stakeAllocated": {
      amount(e.amount); key(e.operation);
      if (s.allocations.has(e.operation)) throw Error("stake allocation already recorded");
      if (e.amount>s.liquid) throw Error("insufficient liquid assets");
      s.allocations.add(e.operation); s.liquid-=e.amount; s.staked+=e.amount; break;
    }
    case "unstakeRequested": {
      amount(e.amount); key(e.operation);
      if(s.unstakes.has(e.operation)) throw Error("unstake operation already exists");
      const inFlight=[...s.unstakes.values()].filter(u=>u.status==="pending").reduce((a,u)=>a+u.amount,0n);
      if(inFlight+e.amount>s.staked) throw Error("unstake exceeds uncommitted stake");
      s.unstakes.set(e.operation,{amount:e.amount,status:"pending"}); break;
    }
    case "unstakeRealized": {
      const u=s.unstakes.get(e.operation);
      if(!u || u.status!=="pending") throw Error("unstake is not pending");
      if(e.amount!==u.amount || e.amount>s.staked) throw Error("unstake reconciliation required");
      s.staked-=e.amount; s.liquid+=e.amount; u.status="realized"; break;
    }
    case "expensePaid":
    case "lossRecognized": {
      amount(e.amount);
      if (e.amount > s.active) throw Error("cannot consume reserved or pending assets");
      if(e.type==="expensePaid" && e.amount>s.liquid) throw Error("unstake assets before paying expense");
      // Losses remove liquid assets first; location-specific loss policies are future work.
      const liquidLoss=e.amount<s.liquid?e.amount:s.liquid;
      s.liquid-=liquidLoss; s.staked-=e.amount-liquidLoss;
      s.active -= e.amount;
      s[e.type === "expensePaid" ? "expenses" : "losses"] += e.amount;
      break;
    }
    case "donationReceived":
      s.quarantined += amount(e.amount); s.incoming += e.amount; break;
    case "sharesTransferred": {
      amount(e.shares); key(e.to);
      if (balance(e.owner) < e.shares) throw Error("insufficient shares");
      s.balances.set(e.owner, balance(e.owner)-e.shares);
      s.balances.set(e.to, balance(e.to)+e.shares); break;
    }
    case "exitReserved": {
      pricing(); amount(e.shares); amount(e.minAssets); key(e.operation);
      if (s.exits.has(e.operation)) throw Error("exit operation already exists");
      if (balance(e.owner) < e.shares) throw Error("insufficient shares");
      const assets = previewExit(s, e.shares);
      if (assets < e.minAssets || assets === 0n || assets > s.active) throw Error("minimum assets or available backing not met");
      if (assets > s.liquid) throw Error("unstake assets before reserving exit");
      // Models already-realized, segregated exit liquidity. It does NOT model an unstaking request.
      s.active -= assets; s.liquid -= assets; s.reserved += assets; s.supply -= e.shares;
      s.balances.set(e.owner, balance(e.owner)-e.shares);
      s.exits.set(e.operation, { owner: e.owner, amount: assets, status: "reserved" }); break;
    }
    case "exitPaid": {
      const exit = s.exits.get(e.operation);
      if (!exit || exit.status !== "reserved") throw Error("exit is not payable");
      s.reserved -= exit.amount; s.payouts += exit.amount; exit.status = "paid"; break;
    }
    case "pricingPaused": s.paused = true; break;
    case "pricingResumed": s.paused = false; break;
    default: throw Error("unknown event type");
  }
  s.events.set(e.id, stamp);
  assertConservation(s);
  return s;
}
