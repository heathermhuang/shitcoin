#!/usr/bin/env node
// Auto-update detector for shitcoin.io coin data.
//
// Detects Binance monitoring/delisting announcements + Coinbase trading-status
// changes not yet reflected in the committed data. With --apply it edits the
// tracked-token data in data/tracked-tokens.json, refreshes the Coinbase snapshot, and writes
// a findings report — the GitHub Action turns those into a review PR.
// It also reconciles the data against Binance's own asset list (live Monitoring
// tag, delisting deadlines). Those findings are reported, never applied; the keys
// already reported live in data/binance-asset-findings.json.
//
// Usage:
//   node scripts/check-delistings.mjs               # dry run: print a report
//   node scripts/check-delistings.mjs --json        # machine-readable report
//   node scripts/check-delistings.mjs --apply       # edit tracked-tokens.json + snapshot + report
//   node scripts/check-delistings.mjs --selftest-edit  # in-memory test of the array editor
//   node scripts/check-delistings.mjs --selftest-cb    # in-memory test of the Coinbase differ
//   node scripts/check-delistings.mjs --selftest-assets  # in-memory test of the asset-list check
//
// Asymmetry worth knowing: Binance is monitored from its announcement feed, so
// findings are FORWARD-looking. Coinbase publishes no feed we read — it is
// monitored by diffing the products API, so a delisting is normally observed as
// it happens. `cancel_only` is the one advance signal available there.
//
// The report ends with two HTML-comment markers the Action greps off stdout:
//   <!-- findings-signature: xxxx -->  stable hash of WHAT was found (not when).
//                                      Names the PR branch, so repeat findings
//                                      update one PR and new findings open a new
//                                      one — a new PR is the only real notification.
//   <!-- BINANCE_FETCH_FAILED -->      emitted when the announcement or asset-list fetch threw.
//                                      Fails the job; a blind run must never be
//                                      indistinguishable from a quiet one.
//
// Env:
//   PROXY_URL  residential HTTP proxy URL for the Binance fetch
//              (http://user:pass@host:port). Empty = direct, which only works
//              from a non-datacenter IP (a dev Mac). REQUIRED in CI.
//   PROXY_HOST optional: replaces only PROXY_URL's host (after a proxy IP rotation)
//   TODAY      override "today" (YYYY-MM-DD) for deterministic tests.
//
// Why the proxy (verified 2026-06-27): binance.com blocks datacenter IPs — the
// Cloudflare worker egress AND US GitHub Actions runners both get HTTP 403.
// Routing the Binance fetch through a residential proxy (via undici ProxyAgent)
// makes Binance see a residential IP. Coinbase needs no proxy (reachable anywhere).

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// undici is imported lazily below — see binanceDispatcher.

const ROOT = new URL('..', import.meta.url).pathname;
const TRACKED = ROOT + 'data/tracked-tokens.json';
const SNAPSHOT = ROOT + 'data/coinbase-snapshot.json';

const BINANCE_BASE = 'https://www.binance.com';
// binance.com blocks datacenter IPs; in CI route the Binance fetch through a
// residential HTTP proxy via $PROXY_URL. Empty = direct (works from a dev Mac).
// PROXY_HOST (a repo variable, not a secret) replaces only the proxy's host, so a
// provider rotating the IP is followed without touching the credential in PROXY_URL.
function withProxyHost(url, host) {
  const h = (host || '').trim();
  if (!url || !h) return url;
  if (!/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})$/.test(h)) {
    throw new Error('PROXY_HOST must be a bare IPv4 address or hostname');
  }
  const u = new URL(url);
  u.hostname = h;
  // URL ignores or rewrites a host it won't take; never keep the old proxy silently.
  if (u.hostname !== h.toLowerCase()) throw new Error('PROXY_HOST was not accepted as a host');
  return u.toString().replace(/\/$/, '');
}
const PROXY_URL = withProxyHost(process.env.PROXY_URL || '', process.env.PROXY_HOST);
// Imported only when a proxy is actually configured. undici is needed for exactly
// one thing — routing the Binance call through PROXY_URL in CI — so a top-level
// import made the whole script unrunnable whenever undici itself could not load,
// including the self-tests and the entire Coinbase path, neither of which touch it.
// (undici 7.28.0 does not load on Node 24.18: "Class extends value undefined" from
// lib/mock/mock-errors.js. CI is on Node 22 and unaffected, but local runs died.)
// Same lazy-dispatcher pattern as relay/server.mjs.
const binanceDispatcher = PROXY_URL ? new (await import('undici')).ProxyAgent(PROXY_URL) : undefined;
const CMS_PATH = '/bapi/composite/v1/public/cms/article/list/query';
// Binance splits these across catalogs AND moves them without notice. Monitoring-tag
// notices lived in 161 ("Delisting") until 2026-06-18, then moved to 49 ("Latest
// Binance News") — reading only 161 silently missed three monitoring announcements
// over seven weeks (2026-07-03, 07-24, 08-11) and wrongly recorded ACX/PYR/VANRY as
// never tagged. Sweep both and merge. A catalog that returns nothing is reported,
// because "no announcements" and "we stopped looking here" must not look alike.
const CATALOGS = [
  { id: 161, name: 'Delisting' },
  { id: 49, name: 'Latest Binance News' },
];
const TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10);
const UA = 'Mozilla/5.0 (compatible; shitcoin-monitor/1.0)';

const FLAGS = new Set(process.argv.slice(2));

// ---------- Binance announcements ----------
// One transient blip must not blind the detector for a whole day. The 2026-08-22
// run died on a bare `fetch failed` — undici's network-level error, with no HTTP
// status — while 08-21 and 08-23 both succeeded through the same proxy. The
// residential egress simply drops a connection now and then, and a single attempt
// turned that into a red job carrying no data. Retrying is the difference between
// "we are blind" and "we have the announcements".
//
// 403 is deliberately NOT retried: a datacenter-IP block is a standing condition,
// not a blip, so burning the remaining attempts on it only delays an honest
// failure the operator needs to see.
const FETCH_ATTEMPTS = 3;
const RETRY_BASE_MS = 1500;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchCatalogTitles(catalogId) {
  const url = `${BINANCE_BASE}${CMS_PATH}?type=1&catalogId=${catalogId}&pageNo=1&pageSize=50`;
  const j = await fetchBinanceJson(url, `Binance CMS catalog ${catalogId}`);
  return (j?.data?.catalogs || []).flatMap(c => (c.articles || []).map(a => a.title));
}

async function fetchBinanceJson(url, label) {
  const opts = { headers: { 'User-Agent': UA } };
  if (binanceDispatcher) opts.dispatcher = binanceDispatcher;

  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 403) {
        throw Object.assign(
          new Error(`${label} HTTP 403 (egress IP blocked)`),
          { fatal: true },
        );
      }
      if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.fatal || attempt === FETCH_ATTEMPTS) break;
      // Linear, not exponential: the observed failures are connection-level and
      // clear in seconds, so a ramp would only push the job past its runtime.
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
  throw lastErr;
}

// -> { titles: [...unique], empty: [names of catalogs that returned nothing] }
async function fetchBinanceTitles() {
  const titles = new Set();
  const empty = [];
  for (const cat of CATALOGS) {
    const got = await fetchCatalogTitles(cat.id);
    if (!got.length) empty.push(`${cat.name} (${cat.id})`);
    for (const t of got) titles.add(t);
  }
  return { titles: [...titles], empty };
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
    // "... and Will Delist" too: the 2025-04-16 batch was titled "Binance Announced the
    // First Batch of Vote to Delist Results and Will Delist BADGER, BAL, ...", and the
    // bare anchor missed it — ten rows carried guessed dates for 18 months.
    let m;
    if ((m = t.match(/(?:^Binance|\band) Will Delist (.+?) on (\d{4}-\d{2}-\d{2})/i))) {
      for (const sym of splitSymbols(m[1])) out.push({ sym, kind: 'delisting', date: m[2], title: t });
    } else if ((m = t.match(/^Binance Will Extend the Monitoring Tag to Include (.+?) on (\d{4}-\d{2}-\d{2})/i))) {
      for (const sym of splitSymbols(m[1])) out.push({ sym, kind: 'monitoring', date: m[2], title: t });
    }
  }
  return out;
}

// ---------- Binance asset list ----------
// Titles are the forward-looking signal but not the whole truth. Tag REMOVALS are
// announced in notice bodies, so MBL's 2025-10-09 restore left its row on
// 'monitoring' for a year; and the 2025-04-16 batch was titled "... and Will
// Delist ...", so ten rows carried guessed dates for 18 months. Binance's own asset
// list holds the state those notices produce: the live Monitoring tag, whether the
// asset trades, and for a pending or past delisting `preDelist` with the trade
// deadline and the notice URL. Reconciling against it catches drift whatever the
// wording. Report only: a disagreement says the row is wrong, not what is right
// (a restore date, for one, has to come from the notice).
const ASSETS_PATH = '/bapi/asset/v2/public/asset/asset/get-all-asset';
// Keys already reported in a PR. A PR opens only for a key not in this list, so a
// standing disagreement is reported once, and fixed ones drop out with the next PR
// rather than opening one of their own.
const ASSET_FINDINGS = ROOT + 'data/binance-asset-findings.json';

async function fetchBinanceAssets() {
  const j = await fetchBinanceJson(`${BINANCE_BASE}${ASSETS_PATH}`, 'Binance asset list');
  const assets = j?.data;
  // Either of these would make every check below pass by finding nothing.
  if (!Array.isArray(assets) || !assets.length) throw new Error('Binance asset list came back empty');
  if (!assets.some(a => (a.tags || []).includes('Monitoring'))) {
    throw new Error('no asset carries a Monitoring tag; Binance may have renamed it');
  }
  return assets;
}

// -> [{key, sym, text}], sorted. Keys carry no run date, so they stay stable.
function reconcileAssets(assets, tokens, today = TODAY) {
  const bySym = new Map(tokens.map(t => [t.sym, t]));
  const out = [];
  for (const a of assets) {
    if (a.isLegalMoney) continue; // fiat: UAH's pair removal sets preDelist too
    const sym = a.assetCode;
    const t = bySym.get(sym);
    // Same promotion index.html applies on load: a past delist date means delisted.
    const status = !t ? null
      : (t.status === 'delisting' && t.delistDate && t.delistDate < today) ? 'delisted' : t.status;
    const tagged = (a.tags || []).includes('Monitoring');
    // `trading` agreed with exchangeInfo's TRADING status for every crypto asset
    // on 2026-10-16. Binance leaves the tag on assets after delisting them, so the
    // tag only means something while the asset still trades.
    const trading = !!a.trading && !a.delisted;

    if (status === 'monitoring' && trading && !tagged) {
      out.push({ key: `untagged:${sym}`, sym,
        text: 'tracked as monitoring, but Binance no longer tags it and it still trades: likely restored; the restore date has to come from the notice' });
    }
    if (tagged && trading && status !== 'monitoring' && status !== 'delisting') {
      out.push({ key: `tagged:${sym}`, sym,
        text: `Binance tags it Monitoring; ${t ? `tracked as ${status}` : 'not in dataset'}` });
    }
    if (a.preDelist && a.pdTradeDeadline) {
      const date = new Date(Number(a.pdTradeDeadline)).toISOString().slice(0, 10);
      if (!t || t.delistDate !== date) {
        const notice = String(a.pdAnnounceUrl || '').match(/[0-9a-f]{32}/)?.[0] || 'no notice URL';
        out.push({ key: `deadline:${sym}:${date}`, sym,
          text: `Binance trade deadline ${date} (notice ${notice}); ${t ? `tracked delistDate ${t.delistDate}` : 'not in dataset'}` });
      }
    }
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

const newAssetFindings = (findings, reported) => {
  const seen = new Set(reported);
  return findings.filter(f => !seen.has(f.key));
};

// ---------- current data ----------
// data/tracked-tokens.json is the source of truth. It used to be an array
// literal inside index.html that this script edited with line-oriented regexes
// requiring every record on one physical line — a contract nothing enforced, so
// a reformat would have made the detector silently see fewer tokens. It is now
// ordinary JSON, parsed and written with JSON.parse/stringify.
function parseTracked(tokens) {
  const map = new Map();
  for (const t of tokens) {
    map.set(t.sym, { status: t.status, monDate: t.monDate, delistDate: t.delistDate });
  }
  return map;
}

// Apply detected Binance changes. Never deletes, and never drops fields it does
// not manage (MDT's `resources`, restoreDate) — entries are edited in place.
// New coins: name defaults to the symbol (flag for review). Delistings with no
// prior monitoring record use the delist date as a placeholder monDate.
function applyBinanceEdits(tokens, changes) {
  const out = tokens.map(t => ({ ...t }));
  const idx = new Map(out.map((t, i) => [t.sym, i]));
  const applied = [];

  for (const ch of changes) {
    if (idx.has(ch.sym)) {
      const t = out[idx.get(ch.sym)];
      t.status = ch.expected;
      if (ch.kind === 'delisting') t.delistDate = ch.date;
      applied.push(`${ch.sym} \u2192 ${ch.expected} (flipped)`);
    } else {
      out.push({
        sym: ch.sym,
        name: ch.sym,
        status: ch.expected,
        monDate: ch.date,                                   // monitoring: tag date; delisting: placeholder
        delistDate: ch.kind === 'delisting' ? ch.date : null,
        restoreDate: null,
      });
      applied.push(`${ch.sym} \u2192 ${ch.expected} (added; name=symbol \u2014 verify)`);
    }
  }
  return { tokens: out, applied };
}

function serializeTracked(tokens) {
  return JSON.stringify(tokens, null, 2) + '\n';
}

// In-memory self-test of the editor (no file writes). Run: --selftest-edit
async function selftestEdit() {
  const tokens = JSON.parse(await readFile(TRACKED, 'utf8'));
  const before = parseTracked(tokens);
  const existingMon = [...before.entries()].find(([, v]) => v.status === 'monitoring')?.[0];
  const mdt = tokens.find(t => t.resources);              // the one entry with extra fields
  const changes = [
    { sym: 'ZZTESTMON', kind: 'monitoring', date: '2099-01-01', expected: 'monitoring' },
    { sym: 'ZZTESTDEL', kind: 'delisting', date: '2099-02-02', expected: 'delisting' },
    ...(existingMon ? [{ sym: existingMon, kind: 'delisting', date: '2099-03-03', expected: 'delisting' }] : []),
  ];
  const { tokens: out, applied } = applyBinanceEdits(tokens, changes);
  const after = parseTracked(out);

  let roundTripsOk = true;
  try { JSON.parse(serializeTracked(out)); } catch { roundTripsOk = false; }
  const mdtAfter = out.find(t => t.sym === mdt?.sym);

  const checks = [
    ['new monitoring coin added', after.get('ZZTESTMON')?.status === 'monitoring'],
    ['new delisting coin added w/ date', after.get('ZZTESTDEL')?.status === 'delisting' && after.get('ZZTESTDEL')?.delistDate === '2099-02-02'],
    ['existing coin flipped to delisting', !existingMon || (after.get(existingMon)?.status === 'delisting' && after.get(existingMon)?.delistDate === '2099-03-03')],
    ['tracked count grew by exactly 2', after.size === before.size + 2],
    ['source array not mutated in place', tokens.length === before.size],
    ['unmanaged fields preserved (resources)', !mdt || JSON.stringify(mdtAfter?.resources) === JSON.stringify(mdt.resources)],
    ['every entry keeps the full field set', out.every(t => 'sym' in t && 'name' in t && 'status' in t && 'monDate' in t && 'delistDate' in t && 'restoreDate' in t)],
    ['serialized output round-trips as JSON', roundTripsOk],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log('applied:', applied.join(' | '));
  console.log(ok ? '\n\u2705 selftest-edit PASSED' : '\n\u274c selftest-edit FAILED');
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

// In-memory self-test of the Coinbase differ (no network, no writes).
// Run: --selftest-cb
// Guards two opposite failure modes that are both silent in production: the
// old-format snapshot flooding every product as "changed", and wind-down
// detection never firing at all.
function selftestCb() {
  // (status, trading_disabled, cancel_only, limit_only)
  const P = (status, td, co, lo = false) => ({ status, trading_disabled: td, cancel_only: co, limit_only: lo });
  const checks = [];

  // 1. Previous snapshot predates these fields (absent) — must report nothing.
  const legacyPrev = { 'AAA-USD': { status: 'online', trading_disabled: false } };
  const legacyNow = { 'AAA-USD': P('online', false, false) };
  const legacy = diffCoinbase(legacyNow, legacyPrev);
  checks.push(['legacy snapshot produces no spurious diff',
    !legacy.changes.length && !legacy.pairChurn.length && !legacy.windDown.length]);

  // 2. Asset's only pair goes cancel-only — the advance warning must fire.
  const wd = diffCoinbase(
    { 'BBB-USD': P('online', false, true) },
    { 'BBB-USD': P('online', false, false) });
  checks.push(['sole pair -> cancel_only reported as wind-down',
    wd.windDown.length === 1 && wd.windDown[0].id === 'BBB-USD' && !wd.changes.length]);

  // 3. limit-only is the state Coinbase actually used before the 2026-08-07
  //    suspensions, so it must fire too — this is the case that matters most.
  const lo = diffCoinbase(
    { 'LLL-USD': P('online', false, false, true) },
    { 'LLL-USD': P('online', false, false, false) });
  checks.push(['sole pair -> limit_only reported as wind-down',
    lo.windDown.length === 1 && !lo.changes.length]);

  // 4. Same flip while another pair still trades freely — housekeeping, not a signal.
  const churn = diffCoinbase(
    { 'CCC-USD': P('online', false, true), 'CCC-EUR': P('online', false, false) },
    { 'CCC-USD': P('online', false, false), 'CCC-EUR': P('online', false, false) });
  checks.push(['restriction on one pair while asset trades freely = churn',
    churn.pairChurn.length === 1 && !churn.windDown.length && !churn.changes.length]);

  // 5. A real delisting must still classify as a delisting, not as wind-down.
  const del = diffCoinbase(
    { 'DDD-USD': P('delisted', true, false) },
    { 'DDD-USD': P('online', false, false) });
  checks.push(['last pair delisted still reported as delisting',
    del.changes.length === 1 && !del.windDown.length]);

  // 6. The 21 permanently limit-only markets (stablecoin/FX, INR, launch ramps)
  //    must stay silent once baselined, or every run reports the same 13 assets.
  const steady = diffCoinbase(
    { 'EEE-USD': P('online', false, true), 'FFF-USD': P('online', false, false, true) },
    { 'EEE-USD': P('online', false, true), 'FFF-USD': P('online', false, false, true) });
  checks.push(['steady-state restrictions are not re-reported',
    !steady.windDown.length && !steady.changes.length && !steady.pairChurn.length]);

  // 7. Escalation limit-only -> cancel-only must not re-fire as a new wind-down
  //    (already warned), but must still re-hash so the PR is not silently reused.
  const esc = diffCoinbase(
    { 'GGG-USD': P('online', false, true, false) },
    { 'GGG-USD': P('online', false, false, true) });
  checks.push(['escalation within restricted states is not a fresh wind-down',
    !esc.windDown.length && !esc.changes.length]);

  // 6. Wind-down must reach the PR signature, or the Action reuses the branch
  //    and the finding never produces a notification.
  const sigA = findingsSignature([], [], []);
  const sigB = findingsSignature([], [], wd.windDown);
  checks.push(['wind-down changes the findings signature', sigA !== sigB]);

  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(ok ? '\n✅ selftest-cb PASSED' : '\n❌ selftest-cb FAILED');
  process.exitCode = ok ? 0 : 1;
}

// In-memory self-test of the asset-list reconciliation (no network, no writes).
// Run: --selftest-assets. Each case is a real 2026 shape, named after its coin.
function selftestAssets() {
  const A = (assetCode, { tags = [], trading = true, delisted = false, pd = null, fiat = false } = {}) => ({
    assetCode, tags, trading, delisted, isLegalMoney: fiat,
    preDelist: !!pd, pdTradeDeadline: pd ? Date.parse(pd + 'T03:00:00Z') : null,
    pdAnnounceUrl: pd ? 'https://www.binance.com/support/announcement/detail/fac9c3e401da4cc8b604566fd261d70c' : null,
  });
  const T = (sym, status, delistDate = null) => ({ sym, name: sym, status, monDate: null, delistDate, restoreDate: null });
  const keys = (assets, tokens) => reconcileAssets(assets, tokens, '2026-10-16').map(f => f.key);
  const only = (got, want) => JSON.stringify(got) === JSON.stringify(want);
  const checks = [];

  checks.push(['tag gone while trading -> likely restored (MBL)',
    only(keys([A('MBL')], [T('MBL', 'monitoring')]), ['untagged:MBL'])]);
  checks.push(['tagged and trading, not in dataset (BICO)',
    only(keys([A('BICO', { tags: ['Monitoring'] })], []), ['tagged:BICO'])]);
  checks.push(['tagged again after restore (MLN)',
    only(keys([A('MLN', { tags: ['Monitoring'] })], [T('MLN', 'restored')]), ['tagged:MLN'])]);
  checks.push(['deadline disagrees with delistDate (HARD)',
    only(keys([A('HARD', { trading: false, delisted: true, pd: '2025-04-16' })], [T('HARD', 'delisted', '2025-02-20')]),
      ['deadline:HARD:2025-04-16'])]);
  checks.push(['deadline for an untracked coin (SNM)',
    only(keys([A('SNM', { trading: false, delisted: true, pd: '2023-08-22' })], []), ['deadline:SNM:2023-08-22'])]);

  // Silence is the other half: these are the states that must NOT be reported.
  checks.push(['stale tag on a delisted asset is ignored (FLM)',
    !keys([A('FLM', { tags: ['Monitoring'], trading: false, delisted: true })], [T('FLM', 'delisted', '2025-11-12')]).length]);
  checks.push(['agreeing monitoring row is quiet (STX)',
    !keys([A('STX', { tags: ['Monitoring'] })], [T('STX', 'monitoring')]).length]);
  checks.push(['announced delisting, tagged, matching deadline is quiet (EPIC)',
    !keys([A('EPIC', { tags: ['Monitoring'], pd: '2026-10-28' })], [T('EPIC', 'delisting', '2026-10-28')]).length]);
  checks.push(['past-dated delisting counts as delisted, not as a live tag (USDP)',
    !keys([A('USDP', { tags: ['Monitoring'], trading: false, pd: '2026-09-24' })], [T('USDP', 'delisting', '2026-09-24')]).length]);
  checks.push(['fiat pair removals are ignored (UAH)',
    !keys([A('UAH', { trading: true, pd: '2026-09-28', fiat: true })], []).length]);

  // Reporting: only unreported keys are new, and the keys carry no run date.
  const mbl = reconcileAssets([A('MBL')], [T('MBL', 'monitoring')], '2026-10-16');
  const later = reconcileAssets([A('MBL')], [T('MBL', 'monitoring')], '2027-01-01');
  checks.push(['keys are stable across run dates', only(mbl.map(f => f.key), later.map(f => f.key))]);
  checks.push(['an already-reported finding is not new', !newAssetFindings(mbl, ['untagged:MBL']).length]);
  checks.push(['an unreported finding is new', newAssetFindings(mbl, ['tagged:OTHER']).length === 1]);
  checks.push(['asset findings change the signature', findingsSignature([], [], [], mbl) !== findingsSignature([], [], [])]);
  checks.push(['no asset findings leaves existing signatures unchanged',
    findingsSignature([], [], [], []) === findingsSignature([], [], [])]);

  let ok = true;
  for (const [name, pass] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(ok ? '\n✅ selftest-assets PASSED' : '\n❌ selftest-assets FAILED');
  process.exitCode = ok ? 0 : 1;
}

// ---------- Coinbase ----------
async function fetchCoinbase() {
  const r = await fetch('https://api.exchange.coinbase.com/products', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Coinbase HTTP ${r.status}`);
  const arr = await r.json();
  const snap = {};
  // The early warning. Coinbase walks a market down through order-book
  // restrictions before status ever changes: the five assets suspended on
  // 2026-08-07 (LRC, FIS, PIRATE, IDEX, OMNI) had their books moved to
  // limit-only first. status alone only tells us afterwards.
  //
  // limit_only is captured even though 21 products sit in it permanently
  // (stablecoin/FX pairs, INR markets, new-listing ramps). That looked like a
  // false-positive generator at first glance, but detection is TRANSITION
  // based — a market already limit-only never transitions into it — so the
  // permanent residents are silent as long as the snapshot has them baselined.
  // Capturing only cancel_only would have been near-useless: zero products are
  // in that state right now, so the signal would rarely have fired at all.
  for (const p of arr) snap[p.id] = {
    status: p.status,
    trading_disabled: !!p.trading_disabled,
    cancel_only: !!p.cancel_only,
    limit_only: !!p.limit_only,
  };
  return snap;
}

// Stable fingerprint of WHAT was found, deliberately excluding the run date and
// any tracked-count noise. The Action names the PR branch after it, so the same
// unresolved finding keeps updating one PR (no daily spam) while a genuinely new
// finding lands on a new branch — which is what actually produces a notification.
function findingsSignature(binanceNew, cbChanges, cbWindDown = [], assetFindings = []) {
  const payload = {
    b: binanceNew.map(n => `${n.sym}:${n.kind}:${n.date}`).sort(),
    c: cbChanges.map(c => `${c.id}:${c.to.status}:${c.to.trading_disabled}`).sort(),
  };
  // Added only when non-empty so that shipping wind-down detection does not
  // change the signature of every pre-existing finding (which would strand the
  // open PR on a dead branch and re-notify for something already triaged).
  // Includes WHICH restriction, so an escalation (limit-only -> cancel-only)
  // re-hashes and opens a new PR rather than silently updating the old one.
  if (cbWindDown.length) payload.w = cbWindDown.map(c => `${c.id}:${restrictionLabel(c.to)}`).sort();
  // Same rule for the asset-list check: absent when empty.
  if (assetFindings.length) payload.a = assetFindings.map(f => f.key).sort();
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

// Coinbase products are PAIRS, so a raw diff conflates two very different events:
// an asset actually leaving the exchange, and routine quote-pair housekeeping
// (Coinbase prunes GBP/EUR/USDT pairs constantly while the asset keeps trading on
// -USD). Reported together, six pair removals read as six delistings — the kind of
// noise that teaches you to stop opening the PR. So split them: an asset that still
// has an online pair is churn; one that just lost its last is a delisting.
// Coerce every field with !!: snapshots written before these were captured have
// them undefined, and `undefined !== false` would report all 832 products as
// changed on the first run after this shipped.
const restricted = v => !!v.trading_disabled || !!v.cancel_only || !!v.limit_only;
const restrictionLabel = v =>
  [v.trading_disabled && 'trading_disabled', v.cancel_only && 'cancel_only', v.limit_only && 'limit_only']
    .filter(Boolean).join('+') || 'none';

function diffCoinbase(current, previous) {
  if (!previous) return { baseline: true, changes: [], pairChurn: [], windDown: [] };
  const baseOf = id => id.split('-')[0];
  // "Healthy" now means online AND unrestricted. A book in limit-only or
  // cancel-only is not freely tradeable, so an asset whose every remaining pair
  // is restricted has effectively stopped trading even though status still reads
  // "online". That makes the delisting/churn split below more sensitive than
  // before, which is the point — it is the difference between warning now and
  // reporting afterwards.
  const stillTrading = new Set();
  for (const [id, v] of Object.entries(current)) {
    if (v.status === 'online' && !restricted(v)) stillTrading.add(baseOf(id));
  }
  const changes = [], pairChurn = [], windDown = [];
  for (const [id, now] of Object.entries(current)) {
    const was = previous[id];
    if (!was) continue; // brand-new listing, not a risk signal
    // Coerce BOTH sides with !!: snapshots written before cancel_only was captured
    // have the field undefined, and `undefined !== false` would report all 832
    // products as changed on the first run after this shipped.
    const statusChanged = was.status !== now.status || !!was.trading_disabled !== !!now.trading_disabled;
    const newlyRestricted = restricted(now) && !restricted(was);
    if (statusChanged) {
      (stillTrading.has(baseOf(id)) ? pairChurn : changes).push({ id, from: was, to: now });
    } else if (newlyRestricted) {
      // Same precision rule as delistings: one pair getting restricted while the
      // asset still trades freely elsewhere is housekeeping, not a signal.
      (stillTrading.has(baseOf(id)) ? pairChurn : windDown).push({ id, from: was, to: now });
    }
  }
  return { baseline: false, changes, pairChurn, windDown };
}

// ---------- main ----------
async function main() {
  if (FLAGS.has('--selftest-edit')) return selftestEdit();
  if (FLAGS.has('--selftest-cb')) return selftestCb();
  if (FLAGS.has('--selftest-assets')) return selftestAssets();

  const trackedTokens = JSON.parse(await readFile(TRACKED, 'utf8'));
  const tracked = parseTracked(trackedTokens);

  let binanceNew = [], binanceErr = null, emptyCatalogs = [];
  try {
    const { titles, empty } = await fetchBinanceTitles();
    emptyCatalogs = empty;
    binanceNew = diffBinance(parseAnnouncements(titles), tracked);
  } catch (e) { binanceErr = e.message; }

  // Checked against the data as it will be once the title findings are applied, so
  // the asset list reports only what the announcement path could not fix.
  const projectedTokens = applyBinanceEdits(trackedTokens, binanceNew).tokens;
  let assetFindings = [], assetErr = null, reportedKeys = [];
  try {
    assetFindings = reconcileAssets(await fetchBinanceAssets(), projectedTokens);
  } catch (e) { assetErr = e.message; }
  try { reportedKeys = JSON.parse(await readFile(ASSET_FINDINGS, 'utf8')); } catch {}
  const assetNew = newAssetFindings(assetFindings, reportedKeys);

  let cb ={ baseline: false, changes: [], pairChurn: [], windDown: [] }, cbErr = null, cbSnap = null;
  try {
    cbSnap = await fetchCoinbase();
    let prev = null;
    try { prev = JSON.parse(await readFile(SNAPSHOT, 'utf8')); } catch {}
    cb = diffCoinbase(cbSnap, prev);
  } catch (e) { cbErr = e.message; }

  // Pair churn still counts as "something to commit" — the refreshed snapshot has
  // to land or the same churn is re-detected every day forever — but it is reported
  // apart from real findings so the PR never overstates what happened.
  const cbAny = !cb.baseline && (cb.changes.length || cb.pairChurn.length || cb.windDown.length);
  const hasChanges = !!(binanceNew.length || cbAny || assetNew.length);
  const signature = findingsSignature(binanceNew, cb.baseline ? [] : cb.changes, cb.baseline ? [] : cb.windDown, assetFindings);

  // Human-readable markdown report — used for console output AND the PR body.
  const lines = [`# Auto-update check — ${TODAY}`, `Tracked Binance coins: ${tracked.size}`];
  if (binanceErr) lines.push(`\n⚠ Binance fetch FAILED: ${binanceErr}`);
  // A catalog that suddenly returns nothing is how the 2026-06→08 blind spot would
  // have looked from the inside. Say it out loud rather than reporting "0 changes".
  if (emptyCatalogs.length) lines.push(`\n⚠ Binance catalog(s) returned no articles — Binance may have moved them again: ${emptyCatalogs.join(', ')}`);
  lines.push(`\n## Binance — ${binanceNew.length} change(s) not yet in data`);
  for (const n of binanceNew) lines.push(`- **${n.sym}** → ${n.expected} (${n.kind} ${n.date}) — ${n.reason}`);
  if (assetErr) lines.push(`\n⚠ Binance asset-list fetch FAILED: ${assetErr}`);
  else {
    lines.push(`\n## Binance asset list — ${assetFindings.length} disagreement(s) with data (${assetNew.length} new)`);
    if (assetFindings.length) lines.push(`_Not applied. Binance's own asset list (live Monitoring tag, delisting deadlines) disagrees with data/tracked-tokens.json. Confirm each against the official notice, then edit the row by hand._`);
    for (const f of assetFindings) lines.push(`- **${f.sym}** — ${f.text}${reportedKeys.includes(f.key) ? '' : ' _(new)_'}`);
  }
  if (cbErr) lines.push(`\n⚠ Coinbase fetch FAILED: ${cbErr}`);
  else if (cb.baseline) lines.push(`\n## Coinbase — baseline snapshot (${Object.keys(cbSnap).length} products)`);
  else {
    lines.push(`\n## Coinbase — ${cb.changes.length} asset delisting(s)`);
    for (const c of cb.changes) lines.push(`- **${c.id}**: ${c.from.status}/${c.from.trading_disabled} → ${c.to.status}/${c.to.trading_disabled} — last online pair gone`);
    // Advance warning: still "online", but accepting no new orders. This is the
    // only forward-looking Coinbase signal we have — unlike Binance there is no
    // announcement feed being read, so without this we always learn afterwards.
    if (cb.windDown.length) {
      lines.push(`\n## Coinbase — ${cb.windDown.length} market(s) entering wind-down`);
      lines.push(`_Still listed as online, but the order book is restricted and the asset has no freely-trading pair left. This is the state Coinbase moved LRC/FIS/PIRATE/IDEX/OMNI through before suspending them on 2026-08-07._`);
      for (const c of cb.windDown) lines.push(`- **${c.id}** → ${restrictionLabel(c.to)}`);
    }
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
  if (binanceErr || assetErr) lines.push('<!-- BINANCE_FETCH_FAILED -->');
  const md = lines.join('\n');

  if (FLAGS.has('--json')) {
    console.log(JSON.stringify({ today: TODAY, trackedCount: tracked.size, signature, binanceNew, binanceErr, assetFindings, assetNew, assetErr, coinbase: cb, cbErr, hasChanges }, null, 2));
  } else {
    console.log(md);
  }

  // --apply: persist state so the Action can open a PR. Gated so routine runs
  // (no delisting/monitoring changes) touch no files → no daily PR noise.
  if (FLAGS.has('--apply')) {
    if (binanceNew.length) {
      await writeFile(TRACKED, serializeTracked(projectedTokens));
    }
    // Rewritten only when a PR is opening anyway, so a fix never opens one alone.
    const keys = assetFindings.map(f => f.key);
    if (hasChanges && !assetErr && JSON.stringify(keys) !== JSON.stringify(reportedKeys)) {
      await writeFile(ASSET_FINDINGS, JSON.stringify(keys, null, 2) + '\n');
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
