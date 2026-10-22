import { ApiPromise, HttpProvider } from "@polkadot/api";
import { emissionSnapshot } from "./etao.mjs";

const args = process.argv.slice(2);
if (!args.length || args.some(v => !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) || args.length > 128) {
  console.error("Usage: node etao-inspect.mjs <netuid> [netuid ...] (1–65535; max 128)");
  process.exitCode = 1;
} else {
  // polkadot HTTP initialization can retry indefinitely. Bound the entire operator command.
  const watchdog = setTimeout(() => { console.error("eTAO read timed out after 60s; no snapshot emitted"); process.exit(1); }, 60_000);
  let api;
  try {
    api = new ApiPromise({ provider: new HttpProvider("https://lite.chain.opentensor.ai"), noInitWarn: true, initWasm: false });
    await api.isReadyOrError;
    console.log(JSON.stringify(await emissionSnapshot(api, args.map(Number)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    try { await api?.disconnect(); } finally { clearTimeout(watchdog); }
  }
}
