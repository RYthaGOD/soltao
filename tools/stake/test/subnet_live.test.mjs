// Read-only mainnet check of the subnet-aware hotkey lookup. Nothing is signed or sent.
//   node test/subnet_live.test.mjs
import { findOnSubnet, getDelegate, getUidCount } from "../src/bittensor.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
// Opentensor Foundation's hotkey: a delegate that held no uid on netuid 1 on 24 Sep 2026.
const FOUNDATION = bytes("0x84d83d08ca89f8e60424ffa286f165c16dd8752e4faa4d8977221e6720678d28");
// Subnet 1's owner hotkey: held uid 248 on netuid 1 on 24 Sep 2026.
const OWNER = bytes("0xe2ee75ea11e4c5b7f5dac2e735278cfa0b1590c9856690f66653bdd85b709104");

const t0 = Date.now();
const fdn = await findOnSubnet(FOUNDATION, 1n);
const d = await getDelegate(FOUNDATION);
expect("the foundation hotkey is a delegate (what the old check trusted)", d.exists, `take ${d.takePct.toFixed(2)}%`);
expect("…yet holds no uid on subnet 1, which the new check catches", fdn.uid === null && fdn.uidCount > 0, `${fdn.uidCount} uids scanned in ${Date.now() - t0} ms`);
const own = await findOnSubnet(OWNER, 1n);
expect("subnet 1's owner hotkey is found on subnet 1", own.uid !== null, JSON.stringify(own));
expect("a netuid far past the live range has no uids", (await getUidCount(60000n)) === 0);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
