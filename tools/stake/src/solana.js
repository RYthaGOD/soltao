// Builds the one Solana transaction the page asks the user to sign:
//   1. compute budget
//   2. the canonical TAO OFT `send` to the user's own transit account on Bittensor EVM, asking
//      LayerZero's executor to drop a little native TAO there for gas
//   3. soltao's flat fee, a plain SOL transfer (only when configured)

import {
  Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram,
} from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey as umiKey, createNoopSigner } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { oft } from "@layerzerolabs/oft-v2-solana-sdk";
import { CONFIG } from "./config.js";

// Both read from chain, not recalled: the TAO mint's owner, and the ATA program itself.
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function createClients(rpcUrl = CONFIG.solanaRpc) {
  const connection = new Connection(rpcUrl, "confirmed");
  // The LayerZero SDK wants umi's RPC for account reads and a web3.js Connection for simulation.
  const rpc = Object.assign(Object.create(createUmi(rpcUrl).rpc), { connection });
  return { connection, rpc };
}

export function taoTokenAccount(owner) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(CONFIG.taoMint).toBuffer()],
    ATA_PROGRAM,
  )[0];
}

/**
 * The wallet's canonical TAO, read from its token account with getAccountInfo. The public RPC
 * refuses getTokenAccountBalance as an "indexed" call, so the SPL layout is decoded here:
 * mint 0..32, owner 32..64, amount u64 LE at 64. Anything that is not this wallet's TAO reads as 0.
 */
export async function getTaoBalance(connection, owner) {
  const info = await connection.getAccountInfo(taoTokenAccount(owner));
  if (!info || !info.owner.equals(TOKEN_PROGRAM) || info.data.length < 72) return 0n;
  const data = info.data;
  if (!new PublicKey(data.subarray(0, 32)).equals(new PublicKey(CONFIG.taoMint))) return 0n;
  if (!new PublicKey(data.subarray(32, 64)).equals(new PublicKey(owner))) return 0n;
  return data.readBigUInt64LE(64);
}

/** Trim to what the OFT can carry: multiples of 0.000001 TAO. */
export const removeDust = (amountLd) => amountLd - (amountLd % CONFIG.dustLd);

const hexBytes = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/.{2}/g), (x) => parseInt(x, 16));

/** An H160 as the 32-byte recipient the OFT and LayerZero expect. */
export function h160Bytes32(address) {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error("expected a 20-byte EVM address");
  const out = new Uint8Array(32);
  out.set(hexBytes(hex), 12);
  return out;
}

/** LayerZero type-3 executor options with one native drop of `dropWei` to `receiver`. */
export function lzOptions({ dropWei, receiver }) {
  const u128 = (v) => { const b = new Uint8Array(16); let x = BigInt(v); for (let i = 15; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
  const payload = [...u128(dropWei), ...h160Bytes32(receiver)];
  // worker 1 (executor), size (type byte + payload), option type 2 (native drop). The TAO program
  // adds its own enforced lzReceive gas (80k) for a plain send.
  return new Uint8Array([0x00, 0x03, 1, (payload.length + 1) >> 8, (payload.length + 1) & 0xff, 2, ...payload]);
}

function sendParams({ transit, amountLd }) {
  const amount = removeDust(BigInt(amountLd));
  return {
    dstEid: CONFIG.bittensorEid,
    to: h160Bytes32(transit),
    amountLd: amount,
    minAmountLd: amount, // an OFT does not slip; only dust is lost, and it was removed above
    options: lzOptions({ dropWei: CONFIG.gasDropWei, receiver: transit }),
  };
}

const programs = () => ({ oft: umiKey(CONFIG.taoOftProgram) });
const tokenAccounts = () => ({ tokenMint: umiKey(CONFIG.taoMint), tokenEscrow: umiKey(CONFIG.taoOftEscrow) });

/** The LayerZero fee in lamports, from a simulation of the TAO program's own quote instruction. */
export async function quoteNativeFee(clients, { user, transit, amountLd }) {
  const q = await oft.quote(clients.rpc, { payer: umiKey(user), ...tokenAccounts() }, { ...sendParams({ transit, amountLd }), payInLzToken: false }, programs(), [], umiKey(CONFIG.lookupTable));
  return q.nativeFee;
}

/** The unsigned transaction, ready for the wallet. */
export async function buildRouteTransaction(clients, { user, transit, amountLd, nativeFee, fee, computeUnits = CONFIG.computeUnits }) {
  const owner = new PublicKey(user);
  const send = await oft.send(
    clients.rpc,
    { payer: createNoopSigner(umiKey(user)), ...tokenAccounts(), tokenSource: umiKey(taoTokenAccount(user).toBase58()) },
    { ...sendParams({ transit, amountLd }), nativeFee },
    programs(),
  );

  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }), toWeb3JsInstruction(send.instruction)];
  if (fee?.wallet && fee?.lamports) {
    instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(fee.wallet), lamports: BigInt(fee.lamports) }));
  }

  const table = (await clients.connection.getAddressLookupTable(new PublicKey(CONFIG.lookupTable))).value;
  if (!table) throw new Error("LayerZero lookup table not found");
  const { blockhash, lastValidBlockHeight } = await clients.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message([table]);
  return { transaction: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
}
