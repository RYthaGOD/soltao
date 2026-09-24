// The sealed resume route (src/pending.js): a route saved by this wallet opens, and an edited or
// foreign one does not, so a changed destination is ignored rather than paid out to.

import { randomBytes } from "node:crypto";
import { sealRoute, openRoute, readRoute, untrustedPlan } from "../src/pending.js";

let failures = 0;
const expect = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!ok) failures++; };

const key = Uint8Array.from(randomBytes(32)), other = Uint8Array.from(randomBytes(32));
const route = { plan: "stake", hotkey: "0x" + "ab".repeat(32), coldkey: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", netuid: "1", reserveRao: "10000000", amountLd: "100000000", sig: null, at: 1790000000000 };
const stored = JSON.parse(JSON.stringify(sealRoute(route, key)));

expect("a sealed route opens with the same transit key", JSON.stringify(openRoute(stored, key)) === JSON.stringify(route));
expect("…and not with another wallet's key", openRoute(stored, other) === null);
expect("an edited destination is refused", openRoute({ ...stored, coldkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty" }, key) === null);
expect("an edited amount is refused", openRoute({ ...stored, amountLd: "900000000" }, key) === null);
expect("an edited subnet is refused", openRoute({ ...stored, netuid: "2" }, key) === null);
expect("a route saved before sealing existed is refused", openRoute({ ...route }, key) === null);
expect("key order in storage does not matter", openRoute(Object.fromEntries(Object.entries(stored).reverse()), key) !== null);
expect("junk is refused, not thrown", openRoute(null, key) === null && openRoute("x", key) === null && openRoute({ mac: 5 }, key) === null);
const later = JSON.parse(JSON.stringify(sealRoute({ ...route, sig: "5abc" }, key)));
expect("re-sealing after the Solana signature arrives still opens", openRoute(later, key)?.sig === "5abc");

// readRoute: what the page may do with it.
const ON_SCREEN = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";
const t = readRoute(stored, key, ON_SCREEN);
expect("a sealed route is trusted and pays out where it was saved", t.trusted && t.destination === route.coldkey && t.route.netuid === "1");
const legacy = readRoute({ ...route }, key, ON_SCREEN);
expect("an unsealed route is untrusted, keeps its hotkey and netuid as hints", !legacy.trusted && legacy.route.hotkey === route.hotkey && legacy.route.netuid === "1");
expect("…pays out only to the wallet on screen, and remembers what it named", legacy.destination === ON_SCREEN && legacy.route.coldkey === ON_SCREEN && legacy.savedDestination === route.coldkey);
const forged = readRoute({ ...stored, coldkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty" }, key, ON_SCREEN);
expect("an edited sealed route is treated the same way: never trusted to pay out", !forged.trusted && forged.destination === ON_SCREEN);
expect("a malformed hotkey hint is dropped", readRoute({ ...route, hotkey: "not-hex" }, key, ON_SCREEN).route.hotkey === null);
expect("an untrusted route hands over stake it finds, and stakes nothing new", untrustedPlan({ stake: 5n }) === "stake" && untrustedPlan({ stake: 0n }) === "deliver");
expect("nothing stored reads as nothing", readRoute(null, key, ON_SCREEN) === null && readRoute({ junk: 1 }, key, ON_SCREEN) === null);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
