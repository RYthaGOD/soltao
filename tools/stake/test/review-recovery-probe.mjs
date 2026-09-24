// Review-only reproducer, not a passing safety/regression suite.
// Success means the documented recovery gaps were reproduced. No network or real keys.
import assert from 'node:assert/strict';
import { finishFreeReturn } from '../src/return_route.js';
import { openRoute, sealRoute } from '../src/pending.js';

const key = new Uint8Array(32).fill(1);
const oldRoute = { plan: 'stake', coldkey: 'saved-destination', hotkey: '01'.repeat(32), netuid: '17', amountLd: '1000000000', reserveRao: '10000000', sig: 'prior-signature', at: 1 };
assert.equal(openRoute(oldRoute, key), null);
assert.equal(openRoute(sealRoute(oldRoute, key), key).netuid, '17');
console.log('REPRODUCED: existing unsigned routes lose their saved subnet/hotkey/destination at load.');

for (const stage of ['funding', 'wrapping']) {
  let mutations = 0;
  const stop = new Error('probe stopped before any actual transaction');
  const ops = {
    signerAddress: () => 'coldkey', transitAddress: () => 'transit', mirrorAddress: async () => 'mirror',
    // Original mutation is still pending: latest chain state does not reflect it yet.
    state: async () => ({ nativeWei: stage === 'funding' ? 0n : 2_000_000_000_000_000_000n, wtaoWei: 0n }),
    gasPrice: async () => 1n,
    quoteBridge: async () => ({ amountWei: 1_000_000_000_000_000_000n, amountRao: 1_000_000_000n, solanaAmountLd: 1_000_000_000n, nativeFee: 1n, lzTokenFee: 0n }),
    quoteFunding: async () => ({ address: 'coldkey', remainingRao: 2_000_000_000n }),
    fund: async () => { mutations++; throw stop; },
    wrap: async () => { mutations++; throw stop; },
  };
  await assert.rejects(finishFreeReturn({ mnemonic: 'test only', transitKey: key, solanaRecipient: 'test only', amountRao: 1_000_000_000n, progress: { stage }, ops }), (error) => error === stop);
  assert.equal(mutations, 1);
  console.log(`REPRODUCED: resume during pending ${stage} attempts that mutation again.`);
}
