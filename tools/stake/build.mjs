// Bundles src/app.js into ../../stake/stake.js: one self-hosted file, so the published page loads no
// third-party code at runtime and the site's `script-src 'self'` CSP stays as it is.
//
//   npm run build        then commit stake/stake.js and stake/stake.js.LEGAL.txt

import { build } from "esbuild";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

const out = "../../stake/stake.js";
const html = "../../stake/index.html";
const hashOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 8);
const noEval = (file) => {
  const code = readFileSync(file, "utf8");
  const evalish = [/\beval\(/, /new Function\(/].filter((re) => re.test(code));
  if (evalish.length) { console.error(`${file} uses eval-like constructs:`, evalish.map(String)); process.exit(1); }
  return code;
};

// The return direction's code (polkadot's api, ~1 MB) ships as its own file, loaded only when someone
// opens that direction. Built first, so the forward bundle can name it by content hash.
const returnOut = "../../stake/return.js";
await build({
  entryPoints: ["src/return_entry.js"], bundle: true, format: "iife", platform: "browser", target: ["es2020", "safari15"],
  minify: true, legalComments: "linked", define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  inject: ["./src/inject.js"],
  alias: { http: "./src/stubs/node-builtin.js", path: "./src/stubs/node-builtin.js", stream: "stream-browserify" },
  // polkadot's no-WebAssembly loader for the bare package only (its /packageInfo subpath must still
  // resolve normally): the page CSP has no 'wasm-unsafe-eval', and nothing here needs WASM (sr25519
  // signing is @scure/sr25519; hashing falls back to polkadot's pure-JS paths).
  plugins: [{
    name: "no-wasm",
    setup(b) { b.onResolve({ filter: /^@polkadot\/wasm-crypto-init$/ }, () => ({ path: resolvePath("node_modules/@polkadot/wasm-crypto-init/none.js") })); },
  }],
  outfile: returnOut, logLevel: "warning",
});
const returnUrl = `return.js?v=${hashOf(noEval(returnOut))}`;
console.log(`stake/return.js  ${(statSync(returnOut).size / 1024).toFixed(0)} KB  (loaded on demand as ${returnUrl})`);

const result = await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020", "safari15"],
  minify: true,
  legalComments: "linked",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis", __RETURN_BUNDLE__: JSON.stringify(returnUrl) },
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

// A content hash on the script tag, so a new build is a new URL: neither the browser nor an
// intermediate edge cache (each node caches independently, for up to the hour in _headers/nginx)
// can serve a stale bundle just because its own TTL hasn't expired yet. index.html itself is
// cached for only 5 minutes, so this reaches people far sooner than stake.js's own hour would.
const hash = createHash("sha256").update(code).digest("hex").slice(0, 8);
const page = readFileSync(html, "utf8");
const busted = page.replace(/(<script src="stake\.js)(?:\?v=[0-9a-f]+)?(" defer><\/script>)/, `$1?v=${hash}$2`);
if (busted === page && !page.includes(`stake.js?v=${hash}"`)) { console.error("could not find the stake.js script tag in index.html to version"); process.exit(1); }
writeFileSync(html, busted);
console.log(`stake/index.html  now points at stake.js?v=${hash}`);
