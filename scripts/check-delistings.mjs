#!/usr/bin/env node
// Auto-update detector for shitcoin.io coin data.
//
// Detects Binance monitoring/delisting announcements + Coinbase trading-status
// changes not yet reflected in the committed data. With --apply it edits the
// TRACKED_TOKENS array in index.html, refreshes the Coinbase snapshot, and writes
// a findings report — the GitHub Action turns those into a review PR.
//
// Usage:
//   node scripts/check-delistings.mjs               # dry run: print a report
//   node scripts/check-delistings.mjs --json        # machine-readable report
//   node scripts/check-delistings.mjs --apply       # edit index.html + snapshot + report
//   node scripts/check-delistings.mjs --selftest-edit  # in-memory test of the array editor
//
// The report ends with two HTML-comment markers the Action greps off stdout:
//   <!-- findings-signature: xxxx -->  stable hash of WHAT was found (not when).
//                                      Names the PR branch, so repeat findings
//                                      update one PR and new findings open a new
//                                      one — a new PR is the only real notification.
//   <!-- BINANCE_FETCH_FAILED -->      emitted when the announcement fetch threw.
//                                      Fails the job; a blind run must never be
//                                      indistinguishable from a quiet one.
//
// Env:
//   PROXY_URL  residential HTTP proxy URL for the Binance fetch
//              (http://user:pass@host:port). Empty = direct, which only works
//              from a non-datacenter IP (a dev Mac). REQUIRED in CI.
//   TODAY      override "today" (YYYY-MM-DD) for deterministic tests.
//
// Why the proxy (verified 2026-06-27): binance.com blocks datacenter IPs — the
// Cloudflare worker egress AND US GitHub Actions runners both get HTTP 403.
// Routing the Binance fetch through a residential proxy (via undici ProxyAgent)
// makes Binance see a residential IP. Coinbase needs no proxy (reachable anywhere).

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ProxyAgent } from 'undici';

const ROOT = new URL('..', import.meta.url).pathname;
const INDEX = ROOT + 'index.html';
const SNAPSHOT = ROOT + 'data/coinbase-snapshot.json';

const BINANCE_BASE = 'https://www.binance.com';
// binance.com blocks datacenter IPs; in CI route the Binance fetch through a
// residential HTTP proxy via $PROXY_URL. Empty = direct (works from a dev Mac).
const PROXY_URL = process.env.PROXY_URL || '';
const binanceDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
const CMS_PATH = '/bapi/composite/v1/public/cms/article/list/query';
const DELISTING_CATALOG = 161; // "Delisting" — holds both delist + monitoring-tag notices
const TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (compatible; shitcoin-monitor/1.0)';

const FLAGS = new Set(process.argv.slice(2));

// ---------- Binance announcements ----------
async function fetchBinanceTitles() {
  const url = `${BINANCE_BASE}${CMS_PATH}?type=1&catalogId=${DELISTING_CATALOG}&pageNo=1&pageSize=50`;
  const opts = { headers: { 'User-Agent': UA } };
  if (binanceDispatcher) opts.dispatcher = binanceDispatcher;
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`Binance CMS HTTP ${r.status}`);
  const j = await r.json();
  const catalogs = j?.data?.catalogs || [];
  return catalogs.flatMap(c => (c.articles || []).map(a => a.title));
}

function splitSymbols(s) {
  return s
    .replace(/\band\b/gi, ',')
    .split(/[,&]/)
    .map(x => x.replace(/\(.*?\)/g, '').trim()) // drop parenthetical names
    .filter(x => /^[A-Z0-9]{2,12}$/.test(x));   // plausible ticker only
}

// -> [{sym, kind:'delisting'|'monitoring', date}]
function parseAnnouncements(titles) {
  const out = [];
  for (const t of titles) {
    // Anchor to "Binance Will Delist ..." so "Binance Margin/Futures Will Delist ..."
    // (margin/perp removals, which precede or differ from spot delistings) don't match.
    let m;
    if ((m = t.match(/^Binance Will Delist (.+?) on (\d{4}-\d{2}-\d{2})/i))) {
      for (const sym of splitSymbols(m[1])) out.push({ sym, kind: 'delisting', date: m[2], title: t });
    } else if ((m = t.match(/^Binance Will Extend the Monitoring Tag to Include (.+?) on (\d{4}-\d{2}-\d{2})/i))) {
      for (const sym of splitSymbols(m[1])) out.push({ sym, kind: 'monitoring', date: m[2], title: t });
    }
  }
  return out;
}

// ---------- current data (scoped to the TRACKED_TOKENS array ONLY) ----------
// index.html contains other {sym:...} arrays too (Coinbase CB_DELISTED, etc.),
// so slice out just the Binance TRACKED_TOKENS array before parsing/editing.
function sliceTracked(html) {
  const marker = 'const TRACKED_TOKENS = [';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('TRACKED_TOKENS array not found in index.html');
  const open = start + marker.length;
  const close = html.indexOf('\n];', open);
  if (close < 0) throw new Error('TRACKED_TOKENS closing "];" not found');
  return { before: html.slice(0, open), body: html.slice(open, close), after: html.slice(close) };
}

function parseTracked(html) {
  const { body } = sliceTracked(html);
  const map = new Map();
  for (const line of body.split('\n')) {
    const sm = line.match(/\{sym:'([^']+)'/);
    if (!sm) continue;
    map.set(sm[1], {
      status: (line.match(/status:'([^']+)'/) || [])[1],
      monDate: (line.match(/monDate:('[^']*'|null)/) || [])[1],
      delistDate: (line.match(/delistDate:('[^']*'|null)/) || [])[1],
    });
  }
  return map;
}

// ---------- v2: edit the TRACKED_TOKENS array ----------
function entryLine({ sym, name, status, monDate, delistDate }) {
  const q = v => (v ? `'${v}'` : 'null');
  return `  {sym:'${sym}', name:'${name}', status:'${status}', monDate:${q(monDate)}, delistDate:${q(delistDate)}, restoreDate:null},`;
}

function updateTotalsComment(html) {
  const t = parseTracked(html);
  const c = { delisted: 0, delisting: 0, monitoring: 0, restored: 0 };
  for (const v of t.values()) if (v.status in c) c[v.status]++;
  const block = `// Total: ${t.size} tokens\n// delisted: ${c.delisted}\n// delisting: ${c.delisting}\n// monitoring: ${c.monitoring}\n// restored: ${c.restored}`;
  return html.replace(/\/\/ Total: \d+ tokens\n\/\/ delisted: \d+\n\/\/ delisting: \d+\n\/\/ monitoring: \d+\n\/\/ restored: \d+/, block);
}

// Apply detected Binance changes to the TRACKED_TOKENS array. Never deletes.
// New coins: name defaults to the symbol (flag for review). Delistings with no
// prior monitoring record use the delist date as a placeholder monDate.
function applyBinanceEdits(html, changes) {
  const { before, body, after } = sliceTracked(html);
  const lines = body.split('\n');
  const idx = new Map();
  lines.forEach((line, i) => { const m = line.match(/\{sym:'([^']+)'/); if (m) idx.set(m[1], i); });

  const applied = [], inserts = [];
  for (const ch of changes) {
    if (idx.has(ch.sym)) {
      let line = lines[idx.get(ch.sym)];
      line = line.replace(/status:'[^']*'/, `status:'${ch.expected}'`);
      if (ch.kind === 'delisting') line = line.replace(/delistDate:('[^']*'|null)/, `delistDate:'${ch.date}'`);
      lines[idx.get(ch.sym)] = line;
      applied.push(`${ch.sym} → ${ch.expected} (flipped)`);
    } else {
      inserts.push(entryLine({
        sym: ch.sym, name: ch.sym, status: ch.expected,
        monDate: ch.date,                                   // monitoring: tag date; delisting: placeholder
        delistDate: ch.kind === 'delisting' ? ch.date : null,
      }));
      applied.push(`${ch.sym} → ${ch.expected} (added; name=symbol — verify)`);
    }
  }

  let newBody = lines.join('\n');
  if (inserts.length) newBody = newBody.replace(/\s*$/, '') + '\n' + inserts.join('\n');
  return { html: updateTotalsComment(before + newBody + after), applied };
}

// In-memory self-test of the editor (no file writes). Run: --selftest-edit
async function selftestEdit() {
  const html = await readFile(INDEX, 'utf8');
  const before = parseTracked(html);
  const existingMon = [...before.entries()].find(([, v]) => v.status === 'monitoring')?.[0];
  const changes = [
    { sym: 'ZZTESTMON', kind: 'monitoring', date: '2099-01-01', expected: 'monitoring' },
    { sym: 'ZZTESTDEL', kind: 'delisting', date: '2099-02-02', expected: 'delisting' },
    ...(existingMon ? [{ sym: existingMon, kind: 'delisting', date: '2099-03-03', expected: 'delisting' }] : []),
  ];
  const { html: out, applied } = applyBinanceEdits(html, changes);
  const after = parseTracked(out);
  let editedArrayOk = true;
  try { eval('([' + sliceTracked(out).body + '])'); } catch { editedArrayOk = false; }
  const checks = [
    ['new monitoring coin added', after.get('ZZTESTMON')?.status === 'monitoring'],
    ['new delisting coin added w/ date', after.get('ZZTESTDEL')?.status === 'delisting' && after.get('ZZTESTDEL')?.delistDate === "'2099-02-02'"],
    ['existing coin flipped to delisting', !existingMon || (after.get(existingMon)?.status === 'delisting' && after.get(existingMon)?.delistDate === "'2099-03-03'")],
    ['tracked count grew by exactly 2', after.size === before.size + 2],
    ['totals comment matches', (/\/\/ Total: (\d+) tokens/.exec(out) || [])[1] === String(after.size)],
    ['only 2 sym entries added file-wide', (out.match(/\{sym:'/g) || []).length === (html.match(/\{sym:'/g) || []).length + 2],
    ['edited array still valid JS', editedArrayOk],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log('applied:', applied.join(' | '));
  console.log(ok ? '\n✅ selftest-edit PASSED' : '\n❌ selftest-edit FAILED');
  process.exitCode = ok ? 0 : 1;
}

function diffBinance(events, tracked) {
  const news = [];
  for (const e of events) {
    const cur = tracked.get(e.sym);
    const expected = e.kind === 'delisting'
      ? (e.date < TODAY ? 'delisted' : 'delisting')
      : 'monitoring';
    if (!cur) {
      news.push({ ...e, expected, reason: 'not in dataset' });
    } else if (e.kind === 'delisting') {
      const dateOk = cur.delistDate && cur.delistDate.includes(e.date);
      const statusOk = cur.status === 'delisting' || cur.status === 'delisted';
      if (!statusOk || !dateOk) {
        news.push({ ...e, expected, reason: `tracked as ${cur.status} (delistDate ${cur.delistDate})` });
      }
    } else { // monitoring announcement
      const known = ['monitoring', 'delisting', 'delisted', 'restored'];
      if (!known.includes(cur.status)) news.push({ ...e, expected, reason: `tracked as ${cur.status}` });
    }
  }
  return news;
}

// ---------- Coinbase ----------
async function fetchCoinbase() {
  const r = await fetch('https://api.exchange.coinbase.com/products', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Coinbase HTTP ${r.status}`);
  const arr = await r.json();
  const snap = {};
  for (const p of arr) snap[p.id] = { status: p.status, trading_disabled: !!p.trading_disabled };
  return snap;
}

// Stable fingerprint of WHAT was found, deliberately excluding the run date and
// any tracked-count noise. The Action names the PR branch after it, so the same
// unresolved finding keeps updating one PR (no daily spam) while a genuinely new
// finding lands on a new branch — which is what actually produces a notification.
function findingsSignature(binanceNew, cbChanges) {
  const payload = {
    b: binanceNew.map(n => `${n.sym}:${n.kind}:${n.date}`).sort(),
    c: cbChanges.map(c => `${c.id}:${c.to.status}:${c.to.trading_disabled}`).sort(),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

// Coinbase products are PAIRS, so a raw diff conflates two very different events:
// an asset actually leaving the exchange, and routine quote-pair housekeeping
// (Coinbase prunes GBP/EUR/USDT pairs constantly while the asset keeps trading on
// -USD). Reported together, six pair removals read as six delistings — the kind of
// noise that teaches you to stop opening the PR. So split them: an asset that still
// has an online pair is churn; one that just lost its last is a delisting.
function diffCoinbase(current, previous) {
  if (!previous) return { baseline: true, changes: [], pairChurn: [] };
  const baseOf = id => id.split('-')[0];
  const stillTrading = new Set();
  for (const [id, v] of Object.entries(current)) {
    if (v.status === 'online' && !v.trading_disabled) stillTrading.add(baseOf(id));
  }
  const changes = [], pairChurn = [];
  for (const [id, now] of Object.entries(current)) {
    const was = previous[id];
    if (!was) continue; // brand-new listing, not a risk signal
    if (was.status !== now.status || was.trading_disabled !== now.trading_disabled) {
      (stillTrading.has(baseOf(id)) ? pairChurn : changes).push({ id, from: was, to: now });
    }
  }
  return { baseline: false, changes, pairChurn };
}

// ---------- main ----------
async function main() {
  if (FLAGS.has('--selftest-edit')) return selftestEdit();

  const html = await readFile(INDEX, 'utf8');
  const tracked = parseTracked(html);

  let binanceNew = [], binanceErr = null;
  try {
    binanceNew = diffBinance(parseAnnouncements(await fetchBinanceTitles()), tracked);
  } catch (e) { binanceErr = e.message; }

  let cb = { baseline: false, changes: [], pairChurn: [] }, cbErr = null, cbSnap = null;
  try {
    cbSnap = await fetchCoinbase();
    let prev = null;
    try { prev = JSON.parse(await readFile(SNAPSHOT, 'utf8')); } catch {}
    cb = diffCoinbase(cbSnap, prev);
  } catch (e) { cbErr = e.message; }

  // Pair churn still counts as "something to commit" — the refreshed snapshot has
  // to land or the same churn is re-detected every day forever — but it is reported
  // apart from real findings so the PR never overstates what happened.
  const cbAny = !cb.baseline && (cb.changes.length || cb.pairChurn.length);
  const hasChanges = !!(binanceNew.length || cbAny);
  const signature = findingsSignature(binanceNew, cb.baseline ? [] : cb.changes);

  // Human-readable markdown report — used for console output AND the PR body.
  const lines = [`# Auto-update check — ${TODAY}`, `Tracked Binance coins: ${tracked.size}`];
  if (binanceErr) lines.push(`\n⚠ Binance fetch FAILED: ${binanceErr}`);
  lines.push(`\n## Binance — ${binanceNew.length} change(s) not yet in data`);
  for (const n of binanceNew) lines.push(`- **${n.sym}** → ${n.expected} (${n.kind} ${n.date}) — ${n.reason}`);
  if (cbErr) lines.push(`\n⚠ Coinbase fetch FAILED: ${cbErr}`);
  else if (cb.baseline) lines.push(`\n## Coinbase — baseline snapshot (${Object.keys(cbSnap).length} products)`);
  else {
    lines.push(`\n## Coinbase — ${cb.changes.length} asset delisting(s)`);
    for (const c of cb.changes) lines.push(`- **${c.id}**: ${c.from.status}/${c.from.trading_disabled} → ${c.to.status}/${c.to.trading_disabled} — last online pair gone`);
    if (cb.pairChurn.length) {
      lines.push(`\n<details><summary>${cb.pairChurn.length} routine quote-pair removal(s) — asset still trading, no action needed</summary>\n`);
      for (const c of cb.pairChurn) lines.push(`- ${c.id}: ${c.from.status} → ${c.to.status}`);
      lines.push('\n</details>');
    }
  }
  // Machine-readable markers the Action greps: the signature names the PR branch,
  // BINANCE_FETCH_FAILED trips the explicit failure step. Both ride in the report
  // (and therefore the PR body) as HTML comments so they stay invisible to readers.
  lines.push(`\n<!-- findings-signature: ${signature} -->`);
  if (binanceErr) lines.push('<!-- BINANCE_FETCH_FAILED -->');
  const md = lines.join('\n');

  if (FLAGS.has('--json')) {
    console.log(JSON.stringify({ today: TODAY, trackedCount: tracked.size, signature, binanceNew, binanceErr, coinbase: cb, cbErr, hasChanges }, null, 2));
  } else {
    console.log(md);
  }

  // --apply: persist state so the Action can open a PR. Gated so routine runs
  // (no delisting/monitoring changes) touch no files → no daily PR noise.
  if (FLAGS.has('--apply')) {
    if (binanceNew.length) {
      const { html: edited } = applyBinanceEdits(html, binanceNew);
      await writeFile(INDEX, edited);
    }
    if (cbSnap && (cb.baseline || cbAny)) {
      await writeFile(SNAPSHOT, JSON.stringify(cbSnap, null, 0) + '\n');
    }
    if (hasChanges) {
      await writeFile(ROOT + 'data/pending-update.md', md + '\n');
    }
  }

  process.exitCode = 0;
  return hasChanges;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
