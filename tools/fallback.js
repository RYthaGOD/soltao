#!/usr/bin/env node
/* Regenerates the no-JavaScript fallback markup in index.html from pairs.json.

   The page renders the look-alike list and the TAO-quoted book from pairs.json
   at runtime. With JavaScript off — or with a failed registry fetch — those two
   containers would otherwise be empty, which is the worst possible outcome for
   a page whose entire job is telling you which mint is real. So the same facts
   are also written into index.html as static markup, between the markers below,
   and app.js replaces them once it has live data.

   Static copy drifts. This script is how it doesn't: it rewrites both blocks
   from the registry, and `--check` fails if what is in the file is stale.

     node tools/fallback.js            rewrite the blocks
     node tools/fallback.js --check    exit 1 if they are out of date

   It is maintenance tooling, not a build step: the site still serves straight
   from the repo with no install.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const REG = path.join(ROOT, 'pairs.json');
const DASH = '—';

const FLAGS = { legacy: 'legacy wrapper', mislabeled: 'mislabeled', 'ticker-squat': 'ticker squat' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function notThisBlock(reg) {
  return reg.notThis.map((t) => [
    '        <li>',
    '          <div class="no-head">',
    `            <span class="no-sym">${esc(t.symbol)}</span>`,
    `            <span class="no-name">${esc(t.name)}</span>`,
    `            <span class="no-flag" data-f="${esc(t.verdict)}">${esc(FLAGS[t.verdict] || t.verdict)}</span>`,
    '          </div>',
    `          <code class="no-ca" aria-label="Not the canonical mint: ${esc(t.mint)}">${esc(t.mint)}</code>`,
    `          <p class="no-why"><span>${esc(t.claim)}</span> ${esc(t.why)}</p>`,
    '        </li>',
  ].join('\n')).join('\n');
}

function pairsBlock(reg) {
  const tao = reg.canonical.mint;
  const shown = reg.pairs.filter((t) => t.rewards === 'confirmed');
  const rows = (shown.length ? shown : reg.pairs.slice(0, 1)).map((t) => {
    const links = [
      `<a href="https://dexscreener.com/solana/${esc(t.mint)}" rel="noopener" target="_blank">DEX</a>`,
      `<a href="https://jup.ag/swap/${esc(tao)}-${esc(t.mint)}" rel="noopener" target="_blank">JUP</a>`,
    ];
    if (t.site) links.push(`<a href="${esc(t.site)}" rel="noopener" target="_blank">WWW</a>`);
    return [
      '        <tr>',
      '          <td>',
      '            <div class="coin">',
      `              <span class="coin-sym">$${esc(t.symbol)}</span>`,
      `              <span class="coin-name">${esc(t.name)}</span>`,
      `              <code class="coin-ca">${esc(t.mint)}</code>`,
      '            </div>',
      '          </td>',
      `          <td class="r num">${DASH}</td>`,
      `          <td class="r num">${DASH}</td>`,
      `          <td class="r num c-opt">${DASH}</td>`,
      `          <td class="r num c-opt">${DASH}</td>`,
      `          <td class="r num">${DASH}</td>`,
      `          <td><span class="rw" data-r="${esc(t.rewards)}" title="${esc(t.mechanic)}">TAO dividends</span></td>`,
      `          <td class="r"><div class="tlinks">${links.join('')}</div></td>`,
      '        </tr>',
    ].join('\n');
  });

  const rest = reg.pairs.length - (shown.length || 1);
  rows.push([
    '        <tr class="row-msg">',
    `          <td colspan="8">Prices, liquidity and the other ${rest} TAO-quoted ${rest === 1 ? 'coin' : 'coins'} in the registry need JavaScript. The mint above does not.</td>`,
    '        </tr>',
  ].join('\n'));

  return rows.join('\n');
}

function splice(html, name, body) {
  const open = `<!-- fallback:${name} -->`;
  const close = `<!-- /fallback:${name} -->`;
  const i = html.indexOf(open);
  const j = html.indexOf(close);
  if (i < 0 || j < 0 || j < i) throw new Error(`markers for "${name}" not found in index.html`);
  const indent = (html.slice(0, i).match(/[ \t]*$/) || [''])[0];
  return html.slice(0, i + open.length) + '\n' + body + '\n' + indent + html.slice(j);
}

const reg = JSON.parse(fs.readFileSync(REG, 'utf8'));
const before = fs.readFileSync(HTML, 'utf8');
let after = splice(before, 'notThis', notThisBlock(reg));
after = splice(after, 'pairs', pairsBlock(reg));

if (process.argv.includes('--check')) {
  if (before === after) {
    console.log('fallback markup is current');
  } else {
    console.error('fallback markup in index.html is stale — run: node tools/fallback.js');
    process.exit(1);
  }
} else {
  fs.writeFileSync(HTML, after);
  console.log(before === after ? 'fallback markup already current' : 'fallback markup rewritten from pairs.json');
}
