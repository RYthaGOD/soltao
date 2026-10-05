// Drives the local stake page and records a 1080p silent picture.
// Narration is timed from src/walk-durations.json and composited later.
//   node scripts/record-walk.mjs
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const videoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
const stakeRequire = createRequire("D:/TAO/tools/stake/package.json");
const videoRequire = createRequire(path.join(videoRoot, "package.json"));
const puppeteer = stakeRequire("puppeteer-core");
const { ed25519 } = stakeRequire("@noble/curves/ed25519");
const { base58 } = stakeRequire("@scure/base");
const ffmpeg = videoRequire("ffmpeg-static");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PAGE = "http://127.0.0.1:8788/stake/";
const PAD = 0.75;
const LEAD = 1.0;
const TAIL = 2.0;

const durations = JSON.parse(fs.readFileSync(path.join(videoRoot, "src/walk-durations.json"), "utf8"));
const framesDir = path.join(videoRoot, "tmp/walk-frames");
const outFile = path.join(videoRoot, "public/footage/demo-walk.mp4");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t0 = 0;
let finished = 0;
const cursor = [];

const frames = [];
async function shot(page) {
  const file = path.join(framesDir, `${String(frames.length).padStart(5, "0")}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 90 });
  frames.push({ file, t: Date.now() });
}

async function glide(page, sel) {
  const geom = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const dest = Math.max(0, window.scrollY + el.getBoundingClientRect().top - 168);
    return { start: window.scrollY, dest };
  }, sel);
  if (!geom) throw new Error(`missing ${sel}`);
  const dist = geom.dest - geom.start;
  const steps = Math.abs(dist) < 30 ? 1 : 6;
  for (let i = 1; i <= steps; i++) {
    const e = 1 - (1 - i / steps) ** 3;
    await page.evaluate((y) => window.scrollTo(0, y), geom.start + dist * e);
    await shot(page);
  }
}

async function point(page, sel) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(Math.max(r.width / 2, 18), 280)), y: Math.round(r.top + Math.min(Math.max(r.height / 2, 12), 36)) };
  }, sel);
  if (!box) return;
  cursor.push({ t: Math.round(((Date.now() - t0) / 1000) * 1000) / 1000, ...box });
  await sleep(280);
}

async function clickSel(page, sel) {
  await point(page, sel);
  await page.$eval(sel, (el) => el.click());
  await sleep(160);
  await shot(page);
}

async function mark(page, js, id) {
  const ok = await page.evaluate(js, id);
  if (!ok) throw new Error(`could not mark ${id}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb", "--window-size=1920,1080", "--disable-features=Translate"],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});

const secret = ed25519.utils.randomPrivateKey();
const pubkey = base58.encode(ed25519.getPublicKey(secret));
const page = await browser.newPage();
await page.exposeFunction("__testSign", (bytes) => Array.from(ed25519.sign(Uint8Array.from(bytes), secret)));
await page.evaluateOnNewDocument((pk) => {
  const key = { toString: () => pk, toBase58: () => pk };
  window.phantom = { solana: {
    isPhantom: true, publicKey: null,
    async connect() { this.publicKey = key; return { publicKey: key }; },
    async signMessage(msg) { return { signature: new Uint8Array(await window.__testSign(Array.from(msg))), publicKey: key }; },
    async signAndSendTransaction() { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); },
    on() {},
  } };
}, pubkey);

console.log("opening", PAGE);
await page.goto(PAGE, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => {
  const t = document.querySelector("#stake-min")?.textContent || "";
  return /TAO/.test(t);
}, { timeout: 45000 }).catch(() => console.log("stake minimum still pending; continuing"));

console.log("reading subnets");
await page.$eval("#dir-btn", (el) => el.click());
await page.waitForFunction(() => /emission midpoint is rank \d+/.test(document.querySelector("#dir-rule")?.textContent || ""), { timeout: 90000 });
// The page re-renders the subnet list every minute (since 2 Oct 2026), which drops an injected id,
// so the row is marked again right before each beat uses it.
const markMid = () => mark(page, () => {
  const b = [...document.querySelectorAll("#dir-body .dir-row")].find((el) => el.textContent.includes("the emission midpoint"));
  if (!b) return false;
  b.id = "rec-mid";
  return true;
}, "rec-mid");
await markMid();
await page.evaluate(() => window.scrollTo(0, 0));

fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });
fs.mkdirSync(path.dirname(outFile), { recursive: true });

t0 = Date.now();
cursor.push({ t: 0, x: 960, y: 420 });
await shot(page);
const sceneMarks = [];
const beat = async (id, fn) => {
  const at = (Date.now() - t0) / 1000;
  sceneMarks.push({ id, at: Math.round(at * 1000) / 1000 });
  console.log("beat", id, at.toFixed(2));
  const start = Date.now();
  await fn();
  const elapsed = Date.now() - start;
  const speech = ((durations[id] ?? 8) + PAD) * 1000;
  if (elapsed < speech) await sleep(speech - elapsed);
  else await sleep(PAD * 1000);
};

try {
  await sleep(LEAD * 1000);
  await beat("open", async () => {
    await point(page, "#stake-h");
    await sleep(900);
    await point(page, ".stake-lede");
  });
  await beat("door", async () => {
    const hops = ["ol.stake-hops.dir-fwd li:nth-child(1)", "ol.stake-hops.dir-fwd li:nth-child(2)", "ol.stake-hops.dir-fwd li:nth-child(3)", "ol.stake-hops.dir-fwd li:nth-child(4)"];
    for (const sel of hops) {
      await point(page, sel);
      await sleep(700);
    }
  });
  await beat("choose", async () => {
    await glide(page, "#dir-rule");
    await point(page, "#dir-rule");
    await sleep(Math.min(7000, (durations.choose ?? 20) * 350));
    await markMid();
    await glide(page, "#rec-mid");
    await point(page, "#rec-mid");
  });
  await beat("look", async () => {
    await markMid();
    await clickSel(page, "#rec-mid");
    await page.waitForFunction(() => Boolean(document.querySelector("#dir-detail svg")), { timeout: 50000 });
    await shot(page);
    await glide(page, "#dir-detail .chart");
    await point(page, "#dir-detail .chart");
    const days = await page.$("#dir-detail .range button[data-days='7']");
    if (days) {
      await point(page, "#dir-detail .range button[data-days='7']");
      await page.$eval("#dir-detail .range button[data-days='7']", (el) => el.click());
      await sleep(200);
      await shot(page);
    }
    await page.waitForFunction(() => {
      const t = document.querySelector("#dir-profile")?.innerText || "";
      return /Buying /.test(t) && !/asking the chain/.test(t);
    }, { timeout: 40000 }).catch(() => console.log("buy quote still pending"));
    await page.evaluate(() => {
      const dt = [...document.querySelectorAll("#dir-profile dt")].find((el) => el.textContent.startsWith("Buying "));
      if (dt) dt.parentElement.id = "rec-buy";
    });
    if (await page.$("#rec-buy")) {
      await glide(page, "#rec-buy");
      await point(page, "#rec-buy");
    }
  });
  await beat("sign", async () => {
    await glide(page, "#connect");
    await clickSel(page, "#connect");
    await page.waitForFunction(() => /TAO/.test(document.querySelector("#tao-balance")?.textContent || ""), { timeout: 30000 });
    await shot(page);
    await page.waitForSelector("#connect-note a", { timeout: 15000 }).catch(() => {});
    if (await page.$("#connect-note a")) await point(page, "#connect-note a");
    await sleep(900);
    await glide(page, "#derive");
    await clickSel(page, "#derive");
    await page.waitForFunction(() => /^5/.test(document.querySelector("#coldkey-out")?.textContent || ""), { timeout: 20000 });
    await shot(page);
    await page.$eval("#phrase-ack", (el) => { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); });
    await glide(page, "#coldkey-out");
    await point(page, "#coldkey-out");
  });
  await beat("alpha", async () => {
    await page.waitForFunction(() => /mints its Alpha|stays TAO/.test(document.querySelector("#netuid-note")?.textContent || ""), { timeout: 25000 }).catch(() => {});
    await glide(page, "#netuid-note");
    await point(page, "#netuid-note");
  });
  await beat("fee", async () => {
    await glide(page, "#r-fee-label");
    await point(page, "#r-fee-label");
    await sleep(900);
    const opened = await page.evaluate(() => {
      const s = [...document.querySelectorAll("#step-review summary")].find((el) => el.textContent.includes("About these fees"));
      if (!s) return false;
      s.id = "rec-fees";
      return true;
    });
    if (opened) {
      await glide(page, "#rec-fees");
      await clickSel(page, "#rec-fees");
    }
  });
  await beat("home", async () => {
    await glide(page, "#direction-toggle");
    await page.waitForFunction(() => !document.querySelector('input[name="direction"][value="reverse"]')?.disabled);
    await clickSel(page, 'label:has(input[name="direction"][value="reverse"])');
    await sleep(400);
    await glide(page, "ol.stake-hops.dir-rev");
    await point(page, "ol.stake-hops.dir-rev li:nth-child(4)");
    await sleep(1200);
    await glide(page, "#holdings-btn");
    await clickSel(page, "#holdings-btn");
    await page.waitForFunction(() => /No stake positions|stake position/.test(document.querySelector("#holdings-note")?.textContent || ""), { timeout: 40000 });
    await shot(page);
    await glide(page, "#holdings-note");
    await point(page, "#holdings-note");
  });
  await sleep(TAIL * 1000);
  finished = Date.now();
} finally {
  await browser.close();
}

const got = frames.filter(Boolean);
if (got.length < 10) throw new Error(`only ${got.length} frames`);
if (!finished) finished = got[got.length - 1].t + TAIL * 1000;
const end = Math.round(((finished - t0) / 1000) * 1000) / 1000;
fs.writeFileSync(path.join(videoRoot, "src/walk-marks.json"), JSON.stringify({ end, scenes: sceneMarks, cursor }, null, 1));
console.log("frames", got.length, "seconds", end.toFixed(2));

const concat = path.join(videoRoot, "tmp/walk-concat.txt");
const lines = [];
for (let i = 0; i < got.length; i++) {
  const dur = i < got.length - 1 ? Math.max(0.01, (got[i + 1].t - got[i].t) / 1000) : Math.max(0.08, (finished - got[i].t) / 1000);
  lines.push(`file '${got[i].file.replace(/\\/g, "/")}'`);
  lines.push(`duration ${dur.toFixed(3)}`);
}
lines.push(`file '${got[got.length - 1].file.replace(/\\/g, "/")}'`);
fs.writeFileSync(concat, lines.join("\n"));

await new Promise((resolve, reject) => {
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", concat, "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0b0c,fps=30", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outFile];
  const child = spawn(ffmpeg, args, { stdio: "inherit" });
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
});
fs.rmSync(framesDir, { recursive: true, force: true });
console.log("wrote", outFile);
