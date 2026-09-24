import { ApiPromise, HttpProvider, Keyring } from "@polkadot/api";
import { ss58Encode } from "./derive.js";

let _api = null;
export async function getApi() {
  if (!_api) {
    const provider = new HttpProvider("https://lite.chain.opentensor.ai");
    _api = await ApiPromise.create({ provider, noInitWarn: true });
  }
  return _api;
}

export async function disconnectApi() {
  if (!_api) return;
  const api = _api;
  _api = null;
  await api.disconnect();
}

export function coldkeyPair(mnemonic) {
  const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
  return keyring.addFromUri(mnemonic);
}

const destination = (value) => value instanceof Uint8Array ? ss58Encode(value) : value;

async function submit(extrinsic, pair) {
  return new Promise(async (resolve, reject) => {
    let unsubscribe = () => {};
    const done = (fn, value) => { try { unsubscribe(); } finally { fn(value); } };
    try {
      unsubscribe = await extrinsic.signAndSend(pair, (result) => {
        if (!result.status.isInBlock) return;
        if (!result.dispatchError) return done(resolve, result.status.asInBlock.toHex());
        if (!result.dispatchError.isModule) return done(reject, new Error(result.dispatchError.toString()));
        const decoded = extrinsic.registry.findMetaError(result.dispatchError.asModule);
        done(reject, new Error(`${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`));
      });
    } catch (error) {
      done(reject, error);
    }
  });
}

/** Read-only fee and balance check for the coldkey -> EVM-mirror funding transfer. */
export async function quoteTransfer(mnemonic, toAddress, amountRao) {
  const amount = BigInt(amountRao);
  if (amount <= 0n) throw new Error("transfer amount must be positive");
  const api = await getApi();
  const pair = coldkeyPair(mnemonic);
  const extrinsic = api.tx.balances.transferAllowDeath(destination(toAddress), amount);
  const [payment, account] = await Promise.all([extrinsic.paymentInfo(pair), api.query.system.account(pair.address)]);
  const feeRao = payment.partialFee.toBigInt();
  const freeRao = account.data.free.toBigInt();
  return { address: pair.address, freeRao, feeRao, amountRao: amount, remainingRao: freeRao - amount - feeRao };
}

export async function removeStake(mnemonic, hotkey, netuid, amountRao) {
  const api = await getApi();
  const pair = coldkeyPair(mnemonic);

  // Runtime metadata (spec checked by test/polkadot.test.mjs): hotkey, netuid, amount.
  const extrinsic = api.tx.subtensorModule.removeStake(hotkey, netuid, amountRao);
  return submit(extrinsic, pair);
}

// ── resumable transfers: sign, save, submit, reconcile ──────────────────────
// signAndSend() waits on a subscription, which an HTTP provider cannot serve, and it only yields a
// block hash. A resumable route instead signs offline (so the extrinsic hash and nonce are known and
// can be saved first), submits the exact bytes, and later reads the account nonce to learn whether
// that nonce was used. Mortal for ~64 blocks, so a lost transfer provably expires rather than lingering.
const MORTAL_BLOCKS = 64;

/** A signed funding transfer that has not been sent: { id, signed, nonce, address }. */
export async function prepareTransfer(mnemonic, toAddress, amountRao) {
  const api = await getApi();
  const pair = coldkeyPair(mnemonic);
  const nonce = (await api.rpc.system.accountNextIndex(pair.address)).toBigInt();
  const extrinsic = api.tx.balances.transferAllowDeath(destination(toAddress), BigInt(amountRao));
  await extrinsic.signAsync(pair, { nonce, era: MORTAL_BLOCKS });
  return { id: extrinsic.hash.toHex(), signed: extrinsic.toHex(), nonce: String(nonce), address: pair.address };
}

/** Submits signed bytes. "Already imported" means it is in the pool: pending, not an error. */
export async function submitSigned(signedHex) {
  const api = await getApi();
  try {
    return { state: "submitted", id: (await api.rpc.author.submitExtrinsic(signedHex)).toHex() };
  } catch (e) {
    const m = String(e?.message || e);
    if (/already imported|AlreadyImported|Priority is too low|1013|1014/i.test(m)) return { state: "submitted" };
    return { state: "rejected", reason: m }; // stale, expired, or invalid: this extrinsic can never land
  }
}

/** The account's on-chain nonce: a saved transfer with a lower nonce has been included. */
export async function accountNonce(address) {
  const api = await getApi();
  return (await api.query.system.account(address)).nonce.toBigInt();
}

export async function transfer(mnemonic, toAddress, amountRao) {
  const api = await getApi();
  const pair = coldkeyPair(mnemonic);

  const extrinsic = api.tx.balances.transferAllowDeath(destination(toAddress), amountRao);
  return submit(extrinsic, pair);
}
