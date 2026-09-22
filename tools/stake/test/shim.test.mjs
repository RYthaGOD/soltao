// The browser bundle swaps @layerzerolabs/lz-utilities and lz-foundation for src/stubs/lz-core.js.
// This checks every function the Solana SDK imports from them against the real packages.

import * as real from "@layerzerolabs/lz-utilities";
import * as realF from "@layerzerolabs/lz-foundation";
import * as shim from "../src/stubs/lz-core.js";

let failures = 0;
const hex = (v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : String(v));
const attempt = (f) => { try { return f(); } catch (e) { return "THROWS"; } };
const same = (name, fa, fb) => { const a = attempt(fa), b = attempt(fb); const ok = hex(a) === hex(b); if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — real ${hex(a)} vs shim ${hex(b)}`}`); };

const inputs = ["0x", "0x1", "0xabc", "ABCDEF", "0x00ff", 0, 1, 255, 65536, 123456789n, new Uint8Array([1, 2, 3]), Buffer.from("guid-bytes")];
for (const v of inputs) {
  same(`arrayify(${typeof v === "object" ? "bytes" : JSON.stringify(String(v))})`, () => real.arrayify(v), () => shim.arrayify(v));
  same(`arrayify(…, 32)`, () => real.arrayify(v, 32), () => shim.arrayify(v, 32));
  same(`hexlify(…)`, () => real.hexlify(v), () => shim.hexlify(v));
}
for (const v of ["0x", "0xZZ", "abc", "0x12", ""]) same(`isHex(${JSON.stringify(v)})`, () => real.isHex(v), () => shim.isHex(v));
for (const [v, o] of [["0x12", {}], ["0x12", { dir: "right" }], [new Uint8Array([9]), { size: 4 }], [new Uint8Array([9]), { size: 4, dir: "right" }]]) {
  same(`padify(${hex(v)}, ${JSON.stringify(o)})`, () => real.padify(v, o), () => shim.padify(v, o));
}
for (const m of ["event:PacketSentEvent", "global:send", new Uint8Array(40).fill(7)]) {
  same(`keccak_256(${typeof m === "string" ? m : "bytes"})`, () => realF.keccak_256(m), () => shim.keccak_256(m));
  same(`sha2_256(${typeof m === "string" ? m : "bytes"})`, () => realF.sha2_256(m), () => shim.sha2_256(m));
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
