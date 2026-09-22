// Node globals some bundled Solana libraries still reach for, supplied to the bundle only. esbuild's
// `inject` (build.mjs) rewrites every free `process` and `Buffer` inside the bundle to these exports,
// so the page never sets window.process or window.Buffer. Wallet extensions run their providers in
// the same page, and a half-built global `process` can break their code.
import { Buffer } from "buffer";

export { Buffer };
export const process = { env: {} };
