// Bundles src/app.js into ../../stake/stake.js: one self-hosted file, so the published page loads no
// third-party code at runtime and the site's `script-src 'self'` CSP stays as it is.
//
//   npm run build        then commit stake/stake.js and stake/stake.js.LEGAL.txt

import { build } from "esbuild";
import { readFileSync, statSync } from "node:fs";

const out = "../../stake/stake.js";
const result = await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020", "safari15"],
  minify: true,
  legalComments: "linked",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  // Module-scoped stand-ins for Node's process and Buffer; see src/inject.js.
  inject: ["./src/inject.js"],
  // lz-utilities imports http and path for Node-only helpers; cipher-base subclasses stream.Transform
  // when it loads, so it gets a real polyfill rather than a stub.
  alias: {
    http: "./src/stubs/node-builtin.js",
    path: "./src/stubs/node-builtin.js",
    stream: "stream-browserify",
    // Six helpers instead of LayerZero's multi-chain toolkit; see src/stubs/lz-core.js.
    "@layerzerolabs/lz-utilities": "./src/stubs/lz-core.js",
    "@layerzerolabs/lz-foundation": "./src/stubs/lz-core.js",
  },
  outfile: out,
  metafile: true,
  logLevel: "warning",
});

// The page ships under `script-src 'self'` with no 'unsafe-eval'. Fail the build if anything in the
// bundle would need it.
const code = readFileSync(out, "utf8");
const evalish = [/\beval\(/, /new Function\(/].filter((re) => re.test(code));
if (evalish.length) { console.error("bundle uses eval-like constructs:", evalish.map(String)); process.exit(1); }

const kb = (statSync(out).size / 1024).toFixed(0);
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`stake/stake.js  ${kb} KB  (${inputs} modules, no eval)`);
