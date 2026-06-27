#!/usr/bin/env node
// Auto-update detector for shitcoin.io coin data.
//
// Detects Binance monitoring/delisting announcements + Coinbase trading-status
// changes that are NOT yet reflected in the committed data, and reports them.
// With --apply it also writes a Coinbase snapshot baseline. (Binance file-editing
// is intentionally a separate, reviewed step — see PR body output.)
//
// Usage:
//   node scripts/check-delistings.mjs            # dry run: print a report
//   node scripts/check-delistings.mjs --json     # machine-readable report (for the Action/PR body)
//   node scripts/check-delistings.mjs --apply    # also write data/coinbase-snapshot.json
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

// ---------- current data ----------
function parseTracked(html) {
  const map = new Map();
  for (const line of html.split('\n')) {
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

function diffCoinbase(current, previous) {
  if (!previous) return { baseline: true, changes: [] };
  const changes = [];
  for (const [id, now] of Object.entries(current)) {
    const was = previous[id];
    if (!was) continue; // brand-new listing, not a risk signal
    if (was.status !== now.status || was.trading_disabled !== now.trading_disabled) {
      changes.push({ id, from: was, to: now });
    }
  }
  return { baseline: false, changes };
}

// ---------- main ----------
async function main() {
  const html = await readFile(INDEX, 'utf8');
  const tracked = parseTracked(html);

  let binanceNew = [], binanceErr = null;
  try {
    binanceNew = diffBinance(parseAnnouncements(await fetchBinanceTitles()), tracked);
  } catch (e) { binanceErr = e.message; }

  let cb = { baseline: false, changes: [] }, cbErr = null, cbSnap = null;
  try {
    cbSnap = await fetchCoinbase();
    let prev = null;
    try { prev = JSON.parse(await readFile(SNAPSHOT, 'utf8')); } catch {}
    cb = diffCoinbase(cbSnap, prev);
  } catch (e) { cbErr = e.message; }

  const hasChanges = !!(binanceNew.length || (!cb.baseline && cb.changes.length));

  // Human-readable markdown report — used for console output AND the PR body.
  const lines = [`# Auto-update check — ${TODAY}`, `Tracked Binance coins: ${tracked.size}`];
  if (binanceErr) lines.push(`\n⚠ Binance fetch FAILED: ${binanceErr}`);
  lines.push(`\n## Binance — ${binanceNew.length} change(s) not yet in data`);
  for (const n of binanceNew) lines.push(`- **${n.sym}** → ${n.expected} (${n.kind} ${n.date}) — ${n.reason}`);
  if (cbErr) lines.push(`\n⚠ Coinbase fetch FAILED: ${cbErr}`);
  else if (cb.baseline) lines.push(`\n## Coinbase — baseline snapshot (${Object.keys(cbSnap).length} products)`);
  else {
    lines.push(`\n## Coinbase — ${cb.changes.length} status change(s)`);
    for (const c of cb.changes) lines.push(`- ${c.id}: ${c.from.status}/${c.from.trading_disabled} → ${c.to.status}/${c.to.trading_disabled}`);
  }
  const md = lines.join('\n');

  if (FLAGS.has('--json')) {
    console.log(JSON.stringify({ today: TODAY, trackedCount: tracked.size, binanceNew, binanceErr, coinbase: cb, cbErr, hasChanges }, null, 2));
  } else {
    console.log(md);
  }

  // --apply: persist state so the Action can open a PR. Gated so routine runs
  // (no delisting/monitoring changes) touch no files → no daily PR noise.
  if (FLAGS.has('--apply')) {
    if (cbSnap && (cb.baseline || cb.changes.length)) {
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
