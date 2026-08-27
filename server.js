#!/usr/bin/env node
/**
 * Combined proxy server for Binance + Coinbase Monitor dashboard.
 * Drop-in Node.js replacement for server.py — no npm deps required.
 * Stale-while-revalidate pattern. Dashboard NEVER shows 0 coins.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BINANCE_ALLOWED, COINBASE_ALLOWED, COINGECKO_ALLOWED, LLAMA_ALLOWED, isAllowed } = require('./lib/api-routes.cjs');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const CACHE_DIR = path.join(__dirname, 'cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---- MIME TYPES ----
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ---- CACHE LAYER ----
const memCache = new Map();
const refreshing = new Set();

function diskPath(key) {
  return path.join(CACHE_DIR, crypto.createHash('md5').update(key).digest('hex') + '.json');
}

function saveDisk(key, data, ct) {
  const p = diskPath(key);
  fs.writeFile(p + '.tmp', JSON.stringify({
    key, content_type: ct,
    timestamp: Date.now() / 1000,
    data_b64: data.toString('base64'),
  }), err => {
    if (!err) fs.rename(p + '.tmp', p, () => {});
  });
}

function loadDisk(key) {
  try {
    const raw = fs.readFileSync(diskPath(key), 'utf8');
    const p = JSON.parse(raw);
    return [Buffer.from(p.data_b64, 'base64'), p.content_type, p.timestamp];
  } catch { return null; }
}

function cacheGet(key) {
  if (memCache.has(key)) return memCache.get(key);
  const d = loadDisk(key);
  if (d) { memCache.set(key, d); return d; }
  return null;
}

function cacheSet(key, data, ct) {
  const entry = [data, ct, Date.now() / 1000];
  memCache.set(key, entry);
  saveDisk(key, data, ct);
}

// ---- UPSTREAM FETCH ----
function doFetch(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CryptoMonitor/1.0)' },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve([data, res.headers['content-type'] || 'application/json', res.statusCode]);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Mirrors projectExchangeInfo() in worker.js. Binance's exchangeInfo is 16.7 MB
// of which index.html reads three fields per symbol; forwarding the catalogue
// costs a 16.7 MB download and ~271 ms of blocking JSON.parse per load. Keeping
// the {symbols:[...]} shape and every symbol means the same client code works
// unchanged against both this and the raw document smartFetch falls back to.
// Returns null if the body is not the expected shape, and the caller forwards
// it untouched.
//
// This has to exist in BOTH entry points: server.js is the dev server and
// worker.js is production, and a projection in only one of them is exactly the
// kind of local/prod divergence that hides bugs until deploy.
function projectExchangeInfo(buf) {
  try {
    const j = JSON.parse(buf.toString());
    if (!j || !Array.isArray(j.symbols)) return null;
    return Buffer.from(JSON.stringify({
      symbols: j.symbols.map(s => ({
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
      })),
    }));
  } catch { return null; }
}

async function cachedFetch(key, url, ttl = 120, transform = null) {
  const cached = cacheGet(key);
  if (cached) {
    const [data, ct, ts] = cached;
    const age = Date.now() / 1000 - ts;
    if (age < ttl) return [data, ct, 200];
    // Stale — revalidate in background
    if (!refreshing.has(key)) {
      refreshing.add(key);
      doFetch(url).then(([d, c]) => { cacheSet(key, transform ? (transform(d) || d) : d, c); refreshing.delete(key); })
                  .catch(() => refreshing.delete(key));
    }
    return [data, ct, 200];
  }
  try {
    const [data, ct, status] = await doFetch(url);
    if (status < 400) {
      // Don't cache Binance rate-limit/ban responses (they look like 200 but contain error JSON)
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.code < 0) {
          return [data, ct, 503]; // Return as error, don't cache
        }
      } catch {} // Not JSON or array response — safe to cache
      const out = transform ? (transform(data) || data) : data;
      cacheSet(key, out, ct);
      return [out, ct, 200];
    }
    return [data, ct, status < 400 ? 200 : 502];
  } catch {
    return [Buffer.from('{"error":"no data available"}'), 'application/json', 502];
  }
}

// ---- ROUTE HANDLERS ----
const BINANCE_BASE = 'https://data-api.binance.vision/api/v3';

const TTL = {
  '24hr': 120, 'depth': 300, 'exchangeInfo': 900,
};

function ttlFor(path) {
  for (const [k, v] of Object.entries(TTL)) if (path.includes(k)) return v;
  return 120;
}

const EXCHANGE_URLS = {
  coinbase: 'https://api.exchange.coinbase.com/products',
  binance:  'https://data-api.binance.vision/api/v3/exchangeInfo',
  okx:      'https://www.okx.com/api/v5/public/instruments?instType=SPOT',
  kraken:   'https://api.kraken.com/0/public/AssetPairs',
};

const DENIED = [Buffer.from('{"error":"not allowed"}'), 'application/json', 403];

async function routeRequest(reqPath) {
  // The Worker allowlists every proxy prefix and 403s anything outside it. The
  // dev server used to forward any subpath, so a call could work locally and be
  // rejected in production. Same lists, same answer.
  if (reqPath.startsWith('/api/')) {
    const p = reqPath.slice(4);
    if (!isAllowed(BINANCE_ALLOWED, p.split('?')[0])) return DENIED;
    const xf = p.startsWith('/exchangeInfo') ? projectExchangeInfo : null;
    return cachedFetch('binance:' + p + (xf ? ':v2' : ''), BINANCE_BASE + p, ttlFor(p), xf);
  }
  if (reqPath.startsWith('/cb/')) {
    const p = reqPath.slice(3);
    if (!isAllowed(COINBASE_ALLOWED, p.split('?')[0])) return DENIED;
    const ttl = p.replace(/\/$/, '') === '/products' ? 300 : p.includes('/stats') ? 120 : p.includes('/book') ? 300 : 120;
    return cachedFetch('cb:' + p, 'https://api.exchange.coinbase.com' + p, ttl || 120);
  }
  if (reqPath.startsWith('/cg/')) {
    const p = reqPath.slice(3);
    if (!isAllowed(COINGECKO_ALLOWED, p.split('?')[0])) return DENIED;
    return cachedFetch('cg:' + p, 'https://api.coingecko.com/api/v3' + p, 300);
  }
  if (reqPath.startsWith('/ex/')) {
    const ex = reqPath.slice(4);
    const url = EXCHANGE_URLS[ex];
    if (!url) return [Buffer.from('{"error":"unknown"}'), 'application/json', 404];
    // /ex/binance is the same exchangeInfo document as /api/exchangeInfo.
    const xf = ex === 'binance' ? projectExchangeInfo : null;
    return cachedFetch('exchange:' + ex + (xf ? ':v2' : ''), url, 1800, xf);
  }
  if (reqPath.startsWith('/llama/')) {
    const p = reqPath.slice(6);
    if (!isAllowed(LLAMA_ALLOWED, p.split('?')[0])) return DENIED;
    return cachedFetch('llama:' + p, 'https://stablecoins.llama.fi' + p, 900);
  }
  return null; // serve static
}

// ---- STATIC FILE SERVER ----
function serveStatic(reqPath, res) {
  let filePath = path.join(ROOT, reqPath === '/' ? 'index.html' : reqPath);

  // Directory boundary, not a string prefix. `startsWith(ROOT)` also accepted a
  // sibling directory whose name merely begins with ROOT's ("shitcoin-notes/").
  // Node normalises `..` out of the URL before it reaches here so that was not
  // actually reachable — but the check should say what it means.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // Never serve dotfiles. `.dev.vars` sits in ROOT and holds PROXY_URL; with no
  // denylist and a 0.0.0.0 bind, `GET /.dev.vars` returned it with HTTP 200 to
  // anything on the network while `npm start` was running. Verified before the fix.
  if (path.relative(ROOT, filePath).split(path.sep).some(seg => seg.startsWith('.'))) {
    res.writeHead(404); res.end('Not Found'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fall through to index.html, the way the Worker's catch-all does. This is
      // the invariant smartFetch is built around: an unmatched path answers 200
      // text/html, NOT 404. Dev used to 404 here, so the one failure mode the
      // content-type guard exists to catch could not be reproduced locally —
      // which is how the missing /llama/ route stayed hidden for months.
      if (reqPath !== '/index.html') { serveStatic('/index.html', res); return; }
      res.writeHead(404); res.end('Not Found'); return;
    }
    const ext = path.extname(filePath);
    const ct = MIME[ext] || 'application/octet-stream';
    const noCache = ['.html', '.js', '.css'].includes(ext);

    // index.html ships with the __TRACKED_TOKENS__ placeholder; production gets
    // it filled by build.js, so dev has to fill it too or the page is broken
    // locally and fine when deployed. Same shared helper, re-read each time so
    // edits to the JSON show up on refresh without restarting the server.
    let body = data;
    if (path.basename(filePath) === 'index.html') {
      try {
        delete require.cache[require.resolve('./lib/tracked-tokens.cjs')];
        body = require('./lib/tracked-tokens.cjs').injectTrackedTokens(data.toString('utf8'));
      } catch (e) {
        console.error('[DEV] tracked-token injection failed:', e.message);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('tracked-token injection failed: ' + e.message);
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': ct,
      ...(noCache ? { 'Cache-Control': 'no-cache, no-store, must-revalidate' } : {}),
    });
    res.end(body);
  });
}

// ---- SERVER ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const reqPath = url.pathname + url.search;

  try {
    const result = await routeRequest(reqPath);
    if (result) {
      const [data, ct, status] = result;
      res.writeHead(status, {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    } else {
      serveStatic(url.pathname, res);
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"internal"}');
  }
});

// Load disk cache on startup
let loaded = 0;
for (const f of fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
    memCache.set(p.key, [Buffer.from(p.data_b64, 'base64'), p.content_type, p.timestamp]);
    loaded++;
  } catch {}
}
console.log(`[INIT] Loaded ${loaded} cache entries`);

// Loopback by default. This is a dev server with no auth that reads files from
// the repo root; binding 0.0.0.0 put it on every interface. Set HOST=0.0.0.0
// deliberately if you need to reach it from another device.
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`[INIT] Crypto Monitor proxy on http://localhost:${PORT} (bound ${HOST})`);
});
