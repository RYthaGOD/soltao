/* ============================================================================
   soltao — Solana TAO Board
   Zero deps. Dexscreener REST + localStorage cache. No wallet, no backend.
   ========================================================================== */

const API = 'https://api.dexscreener.com/latest/dex/tokens/';
const CACHE_KEY = 'soltao:v1:tokens';
const CACHE_TTL = 30_000;          // 30s, per Dexscreener rate-limit etiquette
const REFRESH_MS = 30_000;
// /latest/dex/tokens/ silently caps the response at 30 pairs no matter how many
// mints you ask for. TAO alone returned 24 pairs on 20 Sep 2026, so batching into one call
// drops the small coins. Keep TAO on its own and chunk the rest.
const CHUNK = 6;
const DEAD_LIQ = 1_000;            // a book under $1k is not a book
const SIZES = [1_000, 5_000, 25_000];
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// DefiLlama sizes the staking options. Separate cache: TVL moves in hours, not
// seconds, and /tvl/{slug} returns a bare number so each call is ~60 bytes.
const LLAMA_TVL = 'https://api.llama.fi/tvl/';
const LLAMA_CHAINS = 'https://api.llama.fi/v2/chains';
const YIELD_CACHE_KEY = 'soltao:v1:yield';
const YIELD_TTL = 600_000;   // 10 min

// The mint account itself, read straight from a Solana RPC. Dexscreener's fdv
// is not the bridged supply — dividing it by price gives roughly a quarter of
// what the mint actually holds — so the one number that claims to be on-chain
// truth is fetched from the chain.
const RPC = 'https://solana-rpc.publicnode.com';
const CHAIN_CACHE_KEY = 'soltao:v1:chain';
const CHAIN_TTL = 600_000;   // 10 min; bridged supply moves slowly
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ── number formatting ─────────────────────────────────────────────────────
   Display only. Every raw value stays untouched for copy/links.
   Rules: no scientific notation, no truncation, no -0.00, no NaN leaking out.
   -------------------------------------------------------------------------- */

const DASH = '—';
const SUBS = '₀₁₂₃₄₅₆₇₈₉';

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNum(n) ? n : null;
};

function abbrev(n) {
  const a = Math.abs(n);
  const [div, suf] =
    a >= 1e12 ? [1e12, 'T'] :
    a >= 1e9  ? [1e9,  'B'] :
    a >= 1e6  ? [1e6,  'M'] :
                [1e3,  'K'];
  const v = n / div;
  const av = Math.abs(v);
  const dp = av >= 100 ? 0 : av >= 10 ? 1 : 2;
  return String(parseFloat(v.toFixed(dp))) + suf;   // 5.00K -> 5K, 1.86M stays
}

/** fiat_value / stable_value: $ prefix, K/M/B/T in compact contexts. */
function fmtUsd(v, compact = true) {
  const n = num(v);
  if (n === null) return DASH;
  if (n === 0) return '$0.00';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a < 0.01) return '<$0.01';
  if (compact && a >= 1000) return sign + '$' + abbrev(a);
  return sign + '$' + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Sub-0.001 prices as 0.0₃1621 — never $0.00, never 1.62e-4. */
function subscript(p, sig) {
  let exp = Math.floor(Math.log10(p));
  let digits = Math.round(p * Math.pow(10, -exp + sig - 1));
  if (String(digits).length > sig) { exp += 1; digits = Math.round(p * Math.pow(10, -exp + sig - 1)); }
  const zeros = -exp - 1;
  return {
    text: '$0.0' + String(zeros).split('').map((d) => SUBS[+d]).join('') + digits,
    aria: '$' + p.toFixed(zeros + sig),
  };
}

/** token_price: $ prefix, never abbreviated, decimals scale with magnitude. */
function fmtPrice(v) {
  const n = num(v);
  if (n === null) return { text: DASH, aria: null };
  if (n === 0) return { text: '$0.00', aria: null };
  if (n >= 100) return { text: '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), aria: null };
  if (n >= 1) return { text: '$' + n.toFixed(4), aria: null };
  if (n >= 0.001) return { text: '$' + n.toFixed(6), aria: null };
  return subscript(n, 4);
}

/** percent: signed, 2dp, never -0.00%. */
function fmtPct(v) {
  const n = num(v);
  if (n === null) return DASH;
  if (n === 0) return '0.00%';
  const a = Math.abs(n);
  if (a < 0.01) return n > 0 ? '<+0.01%' : '<-0.01%';
  return (n > 0 ? '+' : '-') + a.toFixed(2) + '%';
}

/** token_amount: plain quantity, grouped, no currency. */
function fmtQty(v, dp = 0) {
  const n = num(v);
  if (n === null) return DASH;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Write a formatted price into a node, keeping the screen-reader value honest. */
function setPrice(node, v) {
  const { text, aria } = fmtPrice(v);
  setText(node, text);
  if (aria) node.setAttribute('aria-label', aria); else node.removeAttribute('aria-label');
}

/** Swap text and flash the cell only when the value actually moved. */
function setText(node, text) {
  if (!node || node.textContent === text) return;
  const had = node.textContent && node.textContent !== DASH;
  node.textContent = text;
  if (had && node.classList.contains('cell-v')) {
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }
}

/* ── cache ─────────────────────────────────────────────────────────────────── */

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || !c.t || !c.data) return null;
    return { ...c, fresh: Date.now() - c.t < CACHE_TTL };
  } catch { return null; }
}

function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data })); } catch { /* private mode */ }
}

/* ── state ─────────────────────────────────────────────────────────────────── */

const state = {
  registry: null,
  pairsByToken: new Map(),   // mint -> pairs[]
  fetchedAt: null,
  stale: false,
  showDead: false,
};

function setFeed(kind, label) {
  const f = $('feed-state');
  f.dataset.state = kind;
  $('feed-label').textContent = label;
}

function stamp(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ── data ──────────────────────────────────────────────────────────────────── */

async function loadRegistry() {
  const res = await fetch('pairs.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('registry ' + res.status);
  return res.json();
}

function batches(reg) {
  const rest = [...reg.pairs.map((p) => p.mint), ...reg.notThis.map((p) => p.mint)];
  const out = [[reg.canonical.mint]];
  for (let i = 0; i < rest.length; i += CHUNK) out.push(rest.slice(i, i + CHUNK));
  return out;
}

async function fetchBatch(mints) {
  const res = await fetch(API + mints.join(','), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('dexscreener ' + res.status);
  const json = await res.json();
  return (json && json.pairs) || [];
}

async function loadMarket(force = false) {
  const cached = readCache();
  if (!force && cached && cached.fresh) {
    ingest(cached.data, cached.t, false);
    return;
  }

  setFeed('loading', 'fetching');
  const results = await Promise.allSettled(batches(state.registry).map(fetchBatch));
  const pairs = [];
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') pairs.push(...r.value);
    else { failed++; console.warn('[soltao] batch failed:', r.reason); }
  }

  if (!pairs.length) {
    if (cached) { ingest(cached.data, cached.t, true); return; }
    setFeed('error', 'feed down');
    $('pairs-foot').textContent = 'Dexscreener is not answering, so there are no live prices — the rows above are whatever the page could render without it. The mint address above is hardcoded and still correct.';
    return;
  }

  writeCache(pairs);
  ingest(pairs, Date.now(), failed > 0);
}

function ingest(pairs, ts, stale) {
  const map = new Map();
  const seen = new Set();          // the same pool comes back in two batches
  for (const p of pairs || []) {
    if (p.chainId !== 'solana') continue;
    if (seen.has(p.pairAddress)) continue;
    seen.add(p.pairAddress);
    for (const side of [p.baseToken, p.quoteToken]) {
      if (!side || !side.address) continue;
      if (!map.has(side.address)) map.set(side.address, []);
      map.get(side.address).push(p);
    }
  }
  state.pairsByToken = map;
  state.fetchedAt = ts;
  state.stale = stale;
  setFeed(stale ? 'stale' : 'live', (stale ? 'stale ' : 'live ') + stamp(ts));
  render();
}

const liqOf = (p) => (p.liquidity && num(p.liquidity.usd)) || 0;
const volOf = (p) => (p.volume && num(p.volume.h24)) || 0;

/* ── render: TAO hero strip ────────────────────────────────────────────────── */

function renderTao() {
  const mint = state.registry.canonical.mint;
  const all = state.pairsByToken.get(mint) || [];
  // "TAO books" = pools where you buy TAO itself, not pools quoted in TAO.
  const books = all.filter((p) => p.baseToken.address === mint);
  if (!books.length) return null;

  books.sort((a, b) => liqOf(b) - liqOf(a));
  const deepest = books[0];
  const price = num(deepest.priceUsd);
  const liq = books.reduce((s, p) => s + liqOf(p), 0);
  const vol = books.reduce((s, p) => s + volOf(p), 0);
  const change = num(deepest.priceChange && deepest.priceChange.h24);
  const txns = deepest.txns && deepest.txns.h24;

  setPrice($('v-price'), price);
  setText($('v-price-sol'), deepest.priceNative ? deepest.priceNative + ' ' + deepest.quoteToken.symbol + ' · ' + deepest.dexId : DASH);

  const ch = $('v-change');
  setText(ch, fmtPct(change));
  ch.className = 'cell-v num ' + (isNum(change) ? (change > 0 ? 'up' : change < 0 ? 'down' : '') : '');
  setText($('v-txns'), txns ? txns.buys + ' buys / ' + txns.sells + ' sells' : DASH);

  setText($('v-vol'), fmtUsd(vol));
  setText($('v-pools'), books.length + ' pool' + (books.length === 1 ? '' : 's') + ' across ' + new Set(books.map((p) => p.dexId)).size + ' dexes');

  const thin = liq < state.registry.canonical.thinBookUsd;
  const lq = $('v-liq');
  setText(lq, fmtUsd(liq));
  lq.className = 'cell-v num' + (thin ? ' warn' : '');
  setText($('v-liq-note'), 'deepest ' + fmtUsd(liqOf(deepest)) + ' · ' + deepest.dexId);

  // thin-book alert
  const alert = $('thin-alert');
  alert.hidden = !thin;
  if (thin) {
    $('thin-copy').textContent =
      'Every TAO pool on Solana adds up to ' + fmtUsd(liq) + ', under the ' +
      fmtUsd(state.registry.canonical.thinBookUsd) + ' line. Size your order against the depth below, ' +
      'not against what TAO costs on a centralised exchange.';
  }

  renderSlippage(deepest, price);
  setText($('step-depth'), 'the deepest single pool holds ' + fmtUsd(liqOf(deepest)));
  return { price, liq, deepest };
}

/** Upper bound, not constant-product: size / quote-side reserve of the deepest pool alone.
    Measured 20 Sep 2026 against a live Jupiter quote, it overstates a $25k fill by >10x. */
function renderSlippage(pool, price) {
  const body = $('slip-rows');
  const baseUsd = (pool.liquidity && num(pool.liquidity.base)) * price;
  const quoteUsd = isNum(baseUsd) ? Math.max(liqOf(pool) - baseUsd, 0) : liqOf(pool) / 2;
  const rows = [];

  if (!quoteUsd || !isNum(price)) {
    body.replaceChildren(rowMsg('Not enough pool data to estimate.', 3));
    return;
  }

  for (const size of SIZES) {
    const impact = size / quoteUsd;
    const eff = price * (1 + impact);
    const tr = el('tr');
    tr.append(el('td', null, fmtUsd(size)));
    const imp = el('td', 'r ' + (impact >= 0.05 ? 'down' : impact >= 0.02 ? 'warn' : ''), fmtPct(impact * 100));
    tr.append(imp);
    tr.append(el('td', 'r', fmtPrice(eff).text));
    rows.push(tr);
  }
  body.replaceChildren(...rows);
  $('slip-sum').textContent = fmtUsd(SIZES[1]) + ' buy ≈ ' + fmtPct((SIZES[1] / quoteUsd) * 100) + ' worse than spot';
}

/* ── render: the not-this list ─────────────────────────────────────────────── */

function renderNotThis() {
  const ul = $('nolist');
  const items = state.registry.notThis.map((t) => {
    const li = el('li');

    const head = el('div', 'no-head');
    head.append(el('span', 'no-sym', t.symbol));
    head.append(el('span', 'no-name', t.name));
    const flag = el('span', 'no-flag', { legacy: 'legacy wrapper', mislabeled: 'mislabeled', 'ticker-squat': 'ticker squat' }[t.verdict] || t.verdict);
    flag.dataset.f = t.verdict;
    head.append(flag);
    li.append(head);

    const ca = el('code', 'no-ca', t.mint);
    ca.setAttribute('aria-label', 'Not the canonical mint: ' + t.mint);
    li.append(ca);

    const why = el('p', 'no-why');
    why.append(el('span', null, t.claim + ' '));
    why.append(document.createTextNode(t.why + ' '));

    const pools = state.pairsByToken.get(t.mint) || [];
    const liq = pools.reduce((s, p) => s + liqOf(p), 0);
    why.append(el('span', 'no-live', pools.length ? '[' + fmtUsd(liq) + ' liquidity, ' + pools.length + ' pool' + (pools.length === 1 ? '' : 's') + ']' : '[no live pools]'));
    li.append(why);
    return li;
  });
  ul.replaceChildren(...items);
}

/* ── render: TAO-quoted coins ──────────────────────────────────────────────── */

function rowMsg(text, span = 8) {
  const tr = el('tr', 'row-msg');
  const td = el('td', null, text);
  td.colSpan = span;
  tr.append(td);
  return tr;
}

function bestPair(token, taoMint) {
  const pools = state.pairsByToken.get(token.mint) || [];
  if (!pools.length) return null;
  if (token.pairAddress) {
    const exact = pools.find((p) => p.pairAddress === token.pairAddress);
    if (exact) return exact;
  }
  const quoted = pools.filter((p) => p.quoteToken.address === taoMint);
  return (quoted.length ? quoted : pools).sort((a, b) => liqOf(b) - liqOf(a))[0];
}

function renderPairs() {
  const taoMint = state.registry.canonical.mint;
  const tbody = $('pairs-body');
  const rows = [];
  let hidden = 0;

  const ranked = state.registry.pairs
    .map((t) => ({ t, p: bestPair(t, taoMint) }))
    .sort((a, b) => liqOf(b.p || {}) - liqOf(a.p || {}));

  for (const { t, p } of ranked) {
    const liq = p ? liqOf(p) : 0;
    const dead = liq < DEAD_LIQ;
    if (dead && !state.showDead) { hidden++; continue; }

    const tr = el('tr', dead ? 'row-dead' : null);

    const c = el('td');
    const box = el('div', 'coin');
    box.append(el('span', 'coin-sym', '$' + t.symbol));
    box.append(el('span', 'coin-name', t.name));
    c.append(box);
    tr.append(c);

    const priceTd = el('td', 'r num');
    if (p) setPrice(priceTd, p.priceUsd); else priceTd.textContent = DASH;
    tr.append(priceTd);

    const chg = p ? num(p.priceChange && p.priceChange.h24) : null;
    tr.append(el('td', 'r num ' + (isNum(chg) ? (chg > 0 ? 'up' : chg < 0 ? 'down' : '') : ''), fmtPct(chg)));

    tr.append(el('td', 'r num c-opt', p ? fmtUsd(p.marketCap ?? p.fdv) : DASH));
    tr.append(el('td', 'r num c-opt', p ? fmtUsd(volOf(p)) : DASH));
    tr.append(el('td', 'r num' + (dead ? ' down' : ''), p ? fmtUsd(liq) : DASH));

    const rw = el('td');
    const badge = el('span', 'rw', t.rewards === 'confirmed' ? 'TAO dividends' : 'unverified');
    badge.dataset.r = t.rewards;
    badge.title = t.mechanic;
    rw.append(badge);
    tr.append(rw);

    const links = el('td', 'r');
    const wrapL = el('div', 'tlinks');
    wrapL.append(link('DEX', p ? p.url : 'https://dexscreener.com/solana/' + t.mint));
    wrapL.append(link('JUP', 'https://jup.ag/swap/' + taoMint + '-' + t.mint));
    if (t.site) wrapL.append(link('WWW', t.site));
    links.append(wrapL);
    tr.append(links);

    rows.push(tr);
  }

  tbody.replaceChildren(...(rows.length ? rows : [rowMsg('No live TAO-quoted books in the registry right now.')]));
  $('pairs-foot').textContent =
    state.registry.pairs.length + ' coins tracked' +
    (hidden ? ', ' + hidden + ' hidden with under ' + fmtUsd(DEAD_LIQ) + ' liquidity' : '') +
    '. "Unverified" means the TAO-quoted pool is real but the reward mechanic has not been confirmed at the source — check before you size in.';
}

/* ── render: the yield menu ────────────────────────────────────────────────
   Sizes every real route to TAO yield. Degrades to prose-only if DefiLlama is
   unreachable — the guidance matters more than the numbers.
   -------------------------------------------------------------------------- */

function readYieldCache() {
  try {
    const c = JSON.parse(localStorage.getItem(YIELD_CACHE_KEY) || 'null');
    if (!c || !c.t || !c.tvl) return null;
    return { ...c, fresh: Date.now() - c.t < YIELD_TTL };
  } catch { return null; }
}

async function loadYield() {
  const y = state.registry.yield;
  if (!y) return;

  const cached = readYieldCache();
  if (cached && cached.fresh) { renderYield(cached.tvl, cached.t, false); return; }

  const refs = [...y.contrast, ...y.routes].map((r) => r.llama).filter(Boolean);
  const slugs = [...new Set(refs.filter((r) => r.protocol).map((r) => r.protocol))];
  const needChains = refs.some((r) => r.chain);

  const jobs = slugs.map((s) =>
    fetch(LLAMA_TVL + s).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => ['p:' + s, parseFloat(t)]));
  if (needChains) {
    jobs.push(fetch(LLAMA_CHAINS).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((rows) => ['chains', rows]));
  }

  const tvl = {};
  let failed = 0;
  for (const res of await Promise.allSettled(jobs)) {
    if (res.status !== 'fulfilled') { failed++; continue; }
    const [k, v] = res.value;
    if (k === 'chains') {
      for (const row of v) tvl['c:' + row.name] = num(row.tvl);
    } else {
      tvl[k] = num(v);
    }
  }

  if (!Object.keys(tvl).length) {
    if (cached) { renderYield(cached.tvl, cached.t, true); return; }
    renderYield(null, null, true);
    return;
  }
  try { localStorage.setItem(YIELD_CACHE_KEY, JSON.stringify({ t: Date.now(), tvl })); } catch { /* private mode */ }
  renderYield(tvl, Date.now(), failed > 0);
}

const tvlOf = (tvl, ref) => {
  if (!tvl || !ref) return null;
  const v = ref.protocol ? tvl['p:' + ref.protocol] : tvl['c:' + ref.chain];
  return isNum(v) ? v : null;
};

function renderYield(tvl, ts, degraded) {
  const y = state.registry.yield;
  if (!y) return;

  // headline contrast
  const cwrap = $('contrast');
  cwrap.replaceChildren(...y.contrast.map((c) => {
    const box = el('div', 'contrast-cell');
    box.append(el('span', 'contrast-k', c.label));
    box.append(el('span', 'contrast-v num', fmtUsd(tvlOf(tvl, c.llama))));
    return box;
  }));

  const body = $('yield-body');
  const rows = y.routes.map((r) => {
    const v = tvlOf(tvl, r.llama);
    const tr = el('tr', r.status === 'dead' ? 'row-dead' : null);

    const first = el('td');
    const box = el('div', 'coin');
    const name = el('span', 'coin-sym', r.label);
    box.append(r.url ? Object.assign(link(r.label, r.url), { className: 'coin-sym coin-link' }) : name);
    if (r.status !== 'live') {
      const b = el('span', 'rw', { caution: 'chokepoint', closing: 'winding down', dead: 'dead', none: 'no yield' }[r.status] || r.status);
      b.dataset.r = r.status;
      box.append(b);
    }
    first.append(box);
    tr.append(first);

    tr.append(el('td', 'c-opt yield-where', r.where));
    tr.append(el('td', 'r num' + (r.status === 'dead' || r.status === 'none' ? ' down' : ''),
      r.llama ? fmtUsd(v) : 'n/a'));
    tr.append(el('td', 'yield-note', r.note));
    return tr;
  });
  body.replaceChildren(...rows);

  $('yield-foot').textContent = tvl
    ? 'TVL from the DefiLlama public API' + (ts ? ', ' + stamp(ts) : '') +
      (degraded ? ' (partial — some figures may be stale).' : ', refreshed every 10 minutes.') +
      ' Sizes are whole protocols or whole chains, not TAO staked. ' + y.note
    : 'DefiLlama is not answering, so the sizes are missing. The routes and the guidance above do not depend on it.';
}

function link(text, href) {
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function render() {
  renderTao();
  renderNotThis();
  renderPairs();
  $('foot-counts').textContent =
    ' · ' + state.registry.notThis.length + ' look-alikes and ' +
    state.registry.pairs.length + ' TAO-quoted coins on file.';
}

/* ── clipboard ─────────────────────────────────────────────────────────────── */

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.dataset.show = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.dataset.show = '0'; }, 1800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const ok = await copy(btn.dataset.copy);          // raw value, always
  btn.dataset.done = ok ? '1' : '0';
  btn.textContent = ok ? 'copied' : 'select it';
  toast(ok ? 'Canonical mint copied' : 'Copy blocked — select the address manually');
  setTimeout(() => { btn.textContent = 'copy'; delete btn.dataset.done; }, 1800);
});


/* ── on-chain facts ────────────────────────────────────────────────────────
   Supply, decimals and the owning token program, read from the mint account.
   Everything here is a claim the page makes about the chain, so it comes from
   the chain rather than from a price feed. Fails closed: the fields stay at —.
   -------------------------------------------------------------------------- */

async function loadChain() {
  const mint = state.registry.canonical.mint;

  try {
    const c = JSON.parse(localStorage.getItem(CHAIN_CACHE_KEY) || 'null');
    if (c && c.t && c.mint === mint && Date.now() - c.t < CHAIN_TTL) { renderChain(c.info); return; }
  } catch { /* private mode */ }

  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [mint, { encoding: 'jsonParsed' }],
    }),
  });
  if (!res.ok) throw new Error('rpc ' + res.status);

  const j = await res.json();
  const v = j && j.result && j.result.value;
  const info = v && v.data && v.data.parsed && v.data.parsed.info;
  if (!info || info.supply == null) throw new Error('rpc: no mint account');

  const facts = {
    supply: Number(info.supply) / 10 ** info.decimals,
    decimals: info.decimals,
    program: v.owner === SPL_TOKEN_PROGRAM ? 'SPL Token' : v.owner,
  };
  try { localStorage.setItem(CHAIN_CACHE_KEY, JSON.stringify({ t: Date.now(), mint, info: facts })); } catch { /* private mode */ }
  renderChain(facts);
}

function renderChain(f) {
  if (!f) return;
  setText($('v-supply'), fmtQty(f.supply, 0) + ' TAO');
  setText($('v-decimals'), String(f.decimals));
  setText($('v-program'), f.program);
  const stamp = $('chain-src');
  if (stamp) stamp.textContent = 'Read from the mint account on Solana mainnet.';
}

/* ── the checker ───────────────────────────────────────────────────────────── */

const B58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

function extractMint(raw) {
  const hits = String(raw).trim().match(B58);
  if (!hits) return null;
  return hits.sort((a, b) => b.length - a.length)[0];
}

function verdictFor(addr) {
  const reg = state.registry;
  if (addr === reg.canonical.mint) {
    return { v: 'yes', head: 'Canonical', body: 'This is the LayerZero OFT mint listed by Sunrise — the one Jupiter, Orca, Raydium and Meteora route. Safe to trade, still a wrapper.' };
  }
  const bad = reg.notThis.find((t) => t.mint === addr);
  if (bad) {
    return { v: 'no', head: 'Not the canonical TAO', body: bad.claim + ' ' + bad.why };
  }
  const paired = reg.pairs.find((t) => t.mint === addr);
  if (paired) {
    return { v: 'unknown', head: 'TAO-quoted coin, not TAO', body: '$' + paired.symbol + ' (' + paired.name + ') is a coin priced in TAO, not TAO itself. ' + paired.mechanic };
  }
  const can = reg.canonical.mint;
  const lookalike = addr.slice(0, 4) === can.slice(0, 4) || addr.slice(-4) === can.slice(-4);
  return {
    v: lookalike ? 'no' : 'unknown',
    head: lookalike ? 'Look-alike — treat as hostile' : 'Not in the registry',
    body: lookalike
      ? 'This shares its first or last four characters with the canonical mint but is a different address. That is the exact shape of a vanity-address swap. Compare the full string, character by character.'
      : 'Unknown here. That makes it neither a scam nor TAO — open it on Solscan and check the mint, supply and pools before you sign anything.',
  };
}

$('checker').addEventListener('submit', (e) => {
  e.preventDefault();
  const out = $('check-out');
  const raw = $('check-in').value;
  const addr = extractMint(raw);

  out.hidden = false;
  out.replaceChildren();

  if (!addr) {
    out.dataset.v = 'unknown';
    out.append(el('b', null, 'No address found'));
    out.append(document.createTextNode('That does not contain a Solana address. Paste the full mint, or a Solscan / Dexscreener link.'));
    return;
  }

  const r = verdictFor(addr);
  out.dataset.v = r.v;
  out.append(el('b', null, r.head));
  out.append(el('code', null, addr));
  out.append(el('br'));
  out.append(document.createTextNode(r.body + ' '));
  if (r.v !== 'yes') out.append(link('Open on Solscan ↗', 'https://solscan.io/token/' + addr));
});

/* ── wiring ────────────────────────────────────────────────────────────────── */

$('refresh').addEventListener('click', () => loadMarket(true));
$('show-dead').addEventListener('change', (e) => { state.showDead = e.target.checked; renderPairs(); });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const c = readCache();
  if (!c || !c.fresh) loadMarket();
});

async function boot() {
  try {
    state.registry = await loadRegistry();
  } catch (err) {
    console.error('[soltao] registry failed:', err);
    setFeed('error', 'registry error');
    /* Leave the hardcoded rows in index.html standing — they are the fallback. */
    $('pairs-foot').textContent = 'pairs.json could not be loaded, so the rows above are the hardcoded fallback written into the page: no live prices, no full registry. If you opened this file directly, serve the folder over HTTP instead — see the README.';
    $('nolist-foot').textContent = 'Registry unavailable, so this list is the hardcoded fallback written into the page. The canonical mint above is hardcoded too, and is still correct.';
    return;
  }
  await loadMarket();
  loadChain().catch((e) => console.warn('[soltao] on-chain read failed:', e));
  loadYield().catch((e) => { console.warn('[soltao] yield sizing failed:', e); renderYield(null, null, true); });
  setInterval(() => { if (document.visibilityState === 'visible') loadMarket(); }, REFRESH_MS);
  setInterval(() => { if (document.visibilityState === 'visible') loadYield().catch(() => {}); }, YIELD_TTL);
  setInterval(() => { if (document.visibilityState === 'visible') loadChain().catch(() => {}); }, CHAIN_TTL);
}

boot();
