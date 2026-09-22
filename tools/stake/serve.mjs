// Serves the whole site locally with the production security headers from _headers, so /stake/ can
// be tried with a real wallet before it is published.
//
//   npm run serve        then open http://localhost:8788/stake/
//
// NO_CSP=1 drops the security policy, only to tell a policy problem apart from anything else.
//
// Keep the port fixed: an unfinished route is remembered per origin, so a resume test has to come
// back to the same address.

import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const port = Number(process.env.PORT || 8788);
const csp = process.env.NO_CSP ? null : readFileSync(join(root, "_headers"), "utf8").match(/Content-Security-Policy: (.+)/)[1].trim();
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".txt": "text/plain", ".xml": "application/xml" };

http.createServer((req, res) => {
  let p = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!p.startsWith(root) || /[\\/](research|tools|node_modules|\.git)([\\/]|$)/.test(p.slice(root.length))) { res.writeHead(404); return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[extname(p)] || "application/octet-stream", ...(csp && { "content-security-policy": csp }), "x-frame-options": "DENY", "x-content-type-options": "nosniff", "cache-control": "no-store" });
  res.end(readFileSync(p));
}).listen(port, "127.0.0.1", () => console.log(`${csp ? "" : "[no CSP] "}soltao at http://localhost:${port}/  ·  stake page: http://localhost:${port}/stake/`));
