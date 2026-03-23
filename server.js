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

const PORT = 8080;
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

async function cachedFetch(key, url, ttl = 120) {
  const cached = cacheGet(key);
  if (cached) {
    const [data, ct, ts] = cached;
    const age = Date.now() / 1000 - ts;
    if (age < ttl) return [data, ct, 200];
    // Stale — revalidate in background
    if (!refreshing.has(key)) {
      refreshing.add(key);
      doFetch(url).then(([d, c]) => { cacheSet(key, d, c); refreshing.delete(key); })
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
      cacheSet(key, data, ct);
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

async function routeRequest(reqPath) {
  if (reqPath.startsWith('/api/')) {
    const p = reqPath.slice(4);
    return cachedFetch('binance:' + p, BINANCE_BASE + p, ttlFor(p));
  }
  if (reqPath.startsWith('/cb/')) {
    const p = reqPath.slice(3);
    const ttl = p.replace(/\/$/, '') === '/products' ? 300 : p.includes('/stats') ? 120 : p.includes('/book') ? 300 : 120;
    return cachedFetch('cb:' + p, 'https://api.exchange.coinbase.com' + p, ttl || 120);
  }
  if (reqPath.startsWith('/cg/')) {
    const p = reqPath.slice(3);
    return cachedFetch('cg:' + p, 'https://api.coingecko.com/api/v3' + p, 300);
  }
  if (reqPath.startsWith('/ex/')) {
    const ex = reqPath.slice(4);
    const url = EXCHANGE_URLS[ex];
    if (!url) return [Buffer.from('{"error":"unknown"}'), 'application/json', 404];
    return cachedFetch('exchange:' + ex, url, 1800);
  }
  return null; // serve static
}

// ---- STATIC FILE SERVER ----
function serveStatic(reqPath, res) {
  let filePath = path.join(ROOT, reqPath === '/' ? 'index.html' : reqPath);
  // Safety: prevent directory traversal
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    const ct = MIME[ext] || 'application/octet-stream';
    const noCache = ['.html', '.js', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': ct,
      ...(noCache ? { 'Cache-Control': 'no-cache, no-store, must-revalidate' } : {}),
    });
    res.end(data);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[INIT] Crypto Monitor proxy on http://localhost:${PORT}`);
});
