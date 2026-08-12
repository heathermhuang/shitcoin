/**
 * shitcoin.io — Binance relay
 *
 * Why this service exists
 * -----------------------
 * The Cloudflare Worker cannot fetch Binance. Two independent reasons, both
 * verified 2026-08-12 and written up in the comment above `proxyFetch` in
 * ../worker.js:
 *
 *   1. Binance blocks Cloudflare's datacenter egress IPs.
 *   2. The CONNECT-tunnel workaround inside the Worker is dead. CONNECT itself
 *      succeeds ("HTTP/1.1 200 Connection Established"), but the `startTls()`
 *      that must follow fails with "TLS Handshake Failed." against EVERY host,
 *      including example.com. Workers' socket API cannot TLS-handshake with a
 *      different host through a tunnel. No proxy fixes that — it is the API.
 *
 * Node has none of that problem: undici's ProxyAgent does CONNECT+TLS
 * correctly (proven daily by scripts/check-delistings.mjs in CI). So the Worker
 * calls this service over ordinary HTTPS and this service talks to Binance.
 *
 *   Render (Node) ──[direct, or proxy if PROXY_URL set]──> data-api.binance.vision
 *         ▲
 *         │ plain HTTPS + bearer token
 *   Cloudflare Worker ──> Cache API ──> visitors
 *
 * Egress mode is chosen at boot by whether PROXY_URL is set, exactly like
 * scripts/check-delistings.mjs. Set the env var to switch to the proxy without
 * touching code; unset it to go direct. `GET /diag` (token-gated) reports which
 * paths actually work from this box.
 *
 * This is NOT an open proxy. Every /binance/* route requires a bearer token and
 * only the four paths in ROUTES are reachable — mirroring BINANCE_ALLOWED in
 * ../worker.js:15. Query strings are filtered to each endpoint's documented
 * parameters, so there is no arbitrary passthrough of path OR query.
 */

import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

const PORT = Number(process.env.PORT) || 3000;
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const PROXY_URL = process.env.PROXY_URL || '';
const BINANCE_BASE = 'https://data-api.binance.vision/api/v3';
const UA = 'shitcoin-relay/1.0 (+https://shitcoin.io)';

// Upstream call budget. Deliberately longer than the Worker's ~5s relay timeout:
// if Binance is slow the Worker gives up and the browser-side smartFetch
// fallback takes over, but we keep the call alive so the cache still gets
// warmed for the next request.
const UPSTREAM_TIMEOUT_MS = 12_000;
// How long an expired entry may still be served when the upstream is failing.
const STALE_MAX_MS = 60 * 60 * 1000;
// Bound the cache in BYTES, not entries: /depth is per-symbol so the key space
// is unbounded, and exchangeInfo alone is ~17.5 MB. An entry count would happily
// hold 200 x 17 MB and OOM the 512 MB free instance.
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

// Egress dispatcher. No PROXY_URL -> direct (Node's default). The import is
// lazy so the direct path has no runtime dependency on undici at all.
let dispatcher;
if (PROXY_URL) {
  const { ProxyAgent } = await import('undici');
  dispatcher = new ProxyAgent(PROXY_URL);
}
const MODE = dispatcher ? 'proxy' : 'direct';

/**
 * The allowlist. Mirrors BINANCE_ALLOWED in ../worker.js:15 exactly.
 * `params` lists the documented query parameters for each endpoint; anything
 * else is dropped rather than forwarded, which keeps the upstream URL space
 * finite (and the cache key space with it).
 */
const ROUTES = {
  '/binance/ticker/24hr': { upstream: '/ticker/24hr', ttl: 120, params: ['symbol', 'symbols', 'type'] },
  '/binance/ticker/price': { upstream: '/ticker/price', ttl: 120, params: ['symbol', 'symbols'] },
  '/binance/depth': { upstream: '/depth', ttl: 300, params: ['symbol', 'limit'] },
  '/binance/exchangeInfo': {
    upstream: '/exchangeInfo',
    ttl: 900,
    params: ['symbol', 'symbols', 'permissions', 'showPermissionSets', 'symbolStatus'],
  },
};

// ---------------------------------------------------------------- cache ----

/** key -> { status, ct, buf, gz, at } — `gz` is filled in on first gzip use. */
const cache = new Map();
/** key -> Promise, so a burst of identical misses makes ONE upstream call. */
const inflight = new Map();

let cacheBytes = 0;
const entryBytes = (e) => e.buf.length + (e.gz ? e.gz.length : 0);

function cacheSet(key, entry) {
  const prev = cache.get(key);
  if (prev) cacheBytes -= entryBytes(prev);
  cache.set(key, entry);
  cacheBytes += entryBytes(entry);
  // Evict oldest-first until back under budget. Never evict the entry just
  // written, even if it alone exceeds the budget — it is the one being served.
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 1) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of cache) {
      if (k !== key && v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    }
    if (oldestKey === null) break;
    cacheBytes -= entryBytes(cache.get(oldestKey));
    cache.delete(oldestKey);
  }
}

// ------------------------------------------------------------- upstream ----

async function fetchUpstream(url) {
  const opts = {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (dispatcher) opts.dispatcher = dispatcher;
  const r = await fetch(url, opts);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ct: r.headers.get('content-type') || 'application/json', buf };
}

/** Fetch through the single-flight map so concurrent misses share one call. */
function fetchOnce(key, url) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = fetchUpstream(url).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// -------------------------------------------------------------- replies ----

/**
 * `body` is either a Buffer or a cache entry { buf, gz }. Passing the entry lets
 * the gzipped copy be memoized on it: exchangeInfo is ~17.5 MB raw and the free
 * instance has 0.1 CPU, so re-compressing on every hit would dominate the
 * response time it is supposed to save.
 */
async function send(req, res, status, body, ct, extra = {}) {
  const entry = Buffer.isBuffer(body) ? null : body;
  const buf = entry ? entry.buf : body;
  const headers = { 'Content-Type': ct, 'Content-Length': buf.length, ...extra };
  // exchangeInfo is multi-megabyte (17.5 MB -> ~330 KB gzipped); compression is
  // what keeps the Worker's short relay budget realistic. Workers' fetch() sends
  // Accept-Encoding: gzip and inflates the response for us.
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    let gz = entry?.gz;
    if (!gz) {
      gz = await gzipAsync(buf);
      // Only bill the cache for it if the entry is still the cached one.
      if (entry && !entry.gz) { entry.gz = gz; cacheBytes += gz.length; }
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = gz.length;
    headers.Vary = 'Accept-Encoding';
    res.writeHead(status, headers);
    return res.end(gz);
  }
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(req, res, status, obj, extra = {}) {
  return send(req, res, status, Buffer.from(JSON.stringify(obj)), 'application/json', extra);
}

// ----------------------------------------------------------------- auth ----

function authorized(req) {
  // A relay with no token set is an open Binance proxy, so an unset token
  // denies everything rather than allowing everything.
  if (!RELAY_TOKEN) return false;
  const header = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(RELAY_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ----------------------------------------------------------------- diag ----

/** Can this box reach host:port at all? Answers "is the outbound port open". */
function tcpProbe(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (result) => {
      sock.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done({ ok: true }));
    sock.once('timeout', () => done({ ok: false, error: 'timeout' }));
    sock.once('error', (e) => done({ ok: false, error: e.message }));
  });
}

/**
 * Step 1 of docs/RELAY-HANDOFF.md, run from the real runtime instead of a
 * throwaway service: can Render reach Binance DIRECTLY (no proxy needed), and
 * if not, is the proxy's non-standard port even reachable from here?
 */
async function diag() {
  const out = { mode: MODE, node: process.version, proxyConfigured: !!PROXY_URL };

  const time = async (label, fn) => {
    const started = Date.now();
    try {
      const status = await fn();
      out[label] = { status, ms: Date.now() - started };
    } catch (e) {
      out[label] = { status: 'ERR ' + (e?.message || String(e)), ms: Date.now() - started };
    }
  };

  // Direct, explicitly bypassing any configured dispatcher.
  await time('direct', async () => {
    const r = await fetch(`${BINANCE_BASE}/ping`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    return r.status;
  });

  if (dispatcher) {
    await time('viaProxy', async () => {
      const r = await fetch(`${BINANCE_BASE}/ping`, {
        headers: { 'User-Agent': UA },
        dispatcher,
        signal: AbortSignal.timeout(10_000),
      });
      return r.status;
    });
  }

  if (PROXY_URL) {
    try {
      const u = new URL(PROXY_URL);
      const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      // Host and port only — credentials are never echoed.
      out.proxyTcp = { host: u.hostname, port, ...(await tcpProbe(u.hostname, port)) };
    } catch (e) {
      out.proxyTcp = { ok: false, error: 'unparseable PROXY_URL' };
    }
  }

  return out;
}

// -------------------------------------------------------------- handler ----

async function handle(req, res) {
  const url = new URL(req.url, 'http://relay.local');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(req, res, 405, { error: 'method not allowed' });
  }

  // Health check — no auth, so Render's monitor and a plain curl both work.
  if (path === '/ping' || path === '/') {
    return sendJson(req, res, 200, { ok: true, mode: MODE, uptime: Math.round(process.uptime()) });
  }

  if (path === '/diag') {
    if (!authorized(req)) return sendJson(req, res, 401, { error: 'unauthorized' });
    return sendJson(req, res, 200, await diag(), { 'Cache-Control': 'no-store' });
  }

  const route = ROUTES[path];
  if (!route) return sendJson(req, res, 404, { error: 'not found' });

  // Auth BEFORE the upstream call: an unauthorized request must never cost us
  // a Binance request or a proxy byte.
  if (!authorized(req)) return sendJson(req, res, 401, { error: 'unauthorized' });

  // Rebuild the query from the allowlist, sorted, so that equivalent requests
  // share one cache entry and unknown parameters cannot reach Binance.
  const params = new URLSearchParams();
  for (const name of route.params) {
    const v = url.searchParams.get(name);
    if (v !== null) params.append(name, v);
  }
  params.sort();
  const qs = params.toString();
  const key = path + (qs ? '?' + qs : '');
  const upstreamUrl = BINANCE_BASE + route.upstream + (qs ? '?' + qs : '');

  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < route.ttl * 1000) {
    return send(req, res, hit.status, hit, hit.ct, {
      'X-Relay-Cache': 'HIT',
      'X-Relay-Age': Math.round(age / 1000),
    });
  }

  try {
    const fresh = await fetchOnce(key, upstreamUrl);
    // Only cache success. A 4xx/5xx is passed through but must not evict a good
    // body — that is what makes the stale fallback below worth having.
    if (fresh.status === 200) {
      const entry = { ...fresh, at: Date.now() };
      cacheSet(key, entry);
      return send(req, res, entry.status, entry, entry.ct, { 'X-Relay-Cache': 'MISS' });
    }
    if (hit && age < STALE_MAX_MS) {
      return send(req, res, hit.status, hit, hit.ct, {
        'X-Relay-Cache': 'STALE',
        'X-Relay-Age': Math.round(age / 1000),
        'X-Relay-Upstream-Status': fresh.status,
      });
    }
    return send(req, res, fresh.status, fresh.buf, fresh.ct, { 'X-Relay-Cache': 'MISS' });
  } catch (e) {
    // Upstream unreachable. Stale data beats no data for a dashboard.
    if (hit && age < STALE_MAX_MS) {
      return send(req, res, hit.status, hit, hit.ct, {
        'X-Relay-Cache': 'STALE',
        'X-Relay-Age': Math.round(age / 1000),
        'X-Relay-Upstream-Error': String(e?.message || e).slice(0, 100),
      });
    }
    return sendJson(req, res, 502, {
      error: 'upstream fetch failed',
      detail: String(e?.message || e).slice(0, 200),
    });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[relay] unhandled', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"internal"}');
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] listening on ${PORT} — egress: ${MODE}, auth: ${RELAY_TOKEN ? 'on' : 'MISSING (all /binance/* will 401)'}`);
});

// Render sends SIGTERM on deploy/scale-down; close cleanly so in-flight
// requests finish instead of being cut off mid-body.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
