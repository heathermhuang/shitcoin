/**
 * Cloudflare Worker for shitcoin.io
 * Serves index.html and proxies API calls to Binance/Coinbase/CoinGecko/exchanges.
 * Uses Cloudflare Cache API for stale-while-revalidate.
 */

import { connect } from "cloudflare:sockets";

const BINANCE_BASE  = 'https://data-api.binance.vision/api/v3';
const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const LLAMA_BASE = 'https://stablecoins.llama.fi';

// Endpoint allowlists — prevents open-proxy abuse of third-party API quotas.
// Only paths the app actually needs are permitted; everything else returns 403.
const BINANCE_ALLOWED  = ['/ticker/24hr', '/depth', '/exchangeInfo', '/ticker/price'];
const COINBASE_ALLOWED = ['/products'];
const COINGECKO_ALLOWED = ['/coins', '/simple/price'];
const LLAMA_ALLOWED = ['/stablecoins'];

function isAllowed(allowlist, subpath) {
  return allowlist.some(p => subpath === p || subpath.startsWith(p + '?') || subpath.startsWith(p + '/'));
}

// ---- Binance relay (relay/server.mjs, deployed on Render) -------------------
// Binance blocks Cloudflare's egress IPs and the in-Worker CONNECT tunnel below
// cannot be made to work, so the Binance call happens in Node instead and the
// Worker makes an ordinary HTTPS request to it. Verified 2026-08-12: Render's
// egress reaches data-api.binance.vision DIRECTLY (`/diag` -> direct: 200), so
// the relay needs no proxy of its own.
//
// Unset RELAY_URL/RELAY_TOKEN and the Worker behaves exactly as before.
const RELAY_TIMEOUT_MS = 5000;

function parseRelay(env) {
  if (!env.RELAY_URL || !env.RELAY_TOKEN) return null;
  return { url: env.RELAY_URL.replace(/\/+$/, ''), token: env.RELAY_TOKEN };
}

// https://data-api.binance.vision/api/v3/ticker/24hr -> https://relay/binance/ticker/24hr
// The relay's routes mirror BINANCE_ALLOWED exactly, so this is a prefix swap.
function relayUrl(upstream, relay) {
  return relay.url + '/binance' + upstream.slice(BINANCE_BASE.length);
}

const EXCHANGE_URLS = {
  coinbase: 'https://api.exchange.coinbase.com/products',
  binance:  'https://data-api.binance.vision/api/v3/exchangeInfo',
  okx:      'https://www.okx.com/api/v5/public/instruments?instType=SPOT',
  kraken:   'https://api.kraken.com/0/public/AssetPairs',
};

const TTL_MAP = [
  ['ticker/24hr',  120],
  ['depth',        300],
  ['exchangeInfo', 900],
  ['/products',    300],
  ['/stats',       120],
  ['/book',        300],
  ['/cg/',        1800],  // 30 min — Demo API key is capped at ~10k calls/month; a longer fresh window keeps the Worker well under it. Clients still get instant cached data on their 180s refresh.
  ['/ex/',        1800],
  ['/llama/',      900],  // 15 min — DefiLlama is keyless and circulating supply moves slowly; the client's 180s refresh is served from cache.
];

function getTTL(path) {
  for (const [k, v] of TTL_MAP) if (path.includes(k)) return v;
  return 120;
}

// How long a BROWSER may reuse a proxy response without revalidating. Short on
// purpose: the client refreshes on a 3-5 minute cadence and has a Refresh
// button, and both are meaningless if the request never leaves the machine.
// The long retention lives in s-maxage, which is what the edge and the Worker's
// Cache API read.
const BROWSER_MAX_AGE = 30;

// ---- Outbound HTTP proxy (CONNECT tunnel) for upstreams that block Cloudflare's
// datacenter IPs (Binance, CoinGecko). Workers' fetch() can't use an HTTP proxy,
// so we open a raw TCP socket to the proxy, issue CONNECT, upgrade to TLS, and
// speak HTTP/1.1 by hand. Credentials come from env.PROXY_URL (a secret).
//
// ⚠️ THIS PATH DOES NOT WORK, and the reason is not what it long appeared to be.
// The old belief was that the proxy's exit IP rejects CF-sourced CONNECT. It does
// not: with valid credentials the CONNECT returns "HTTP/1.1 200 Connection
// Established" every time. What fails is startTls() immediately after, with
// "TLS Handshake Failed."
//
// Measured 2026-08-12 by probing the live Worker:
//   * two different residential proxies       -> identical failure
//   * allowHalfOpen false / true / omitted    -> identical failure
//   * startTls() with and without expectedServerHostname -> identical failure
//   * targets binance.vision, coingecko, coinbase AND example.com -> all fail
// curl through the same proxies reaches every one of those hosts fine.
//
// example.com failing is the tell: this is not upstream-specific. Workers'
// startTls() is built to upgrade a connection to the host you dialled (SMTP,
// Postgres); it cannot complete a handshake with a DIFFERENT host through a
// CONNECT tunnel. No proxy purchase or option tweak fixes this — the fix is a
// small relay on non-Cloudflare compute that the Worker calls over plain HTTPS.
// Binance still genuinely blocks CF (disabling the proxy yields "upstream
// error"), so today Binance data rides the client-side smartFetch fallback.
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    if (!u.hostname || !u.port) return null;
    return {
      host: u.hostname,
      port: parseInt(u.port, 10),
      auth: 'Basic ' + btoa(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)),
    };
  } catch { return null; }
}
function _concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
function _findCRLF2(b) { for (let i = 0; i + 3 < b.length; i++) if (b[i]===13&&b[i+1]===10&&b[i+2]===13&&b[i+3]===10) return i; return -1; }
function _dechunk(buf) {
  const parts = []; let pos = 0; const td = new TextDecoder();
  while (pos < buf.length) {
    let nl = -1; for (let i = pos; i + 1 < buf.length; i++) if (buf[i]===13&&buf[i+1]===10) { nl = i; break; }
    if (nl === -1) break;
    const size = parseInt(td.decode(buf.subarray(pos, nl)).trim().split(';')[0], 16);
    if (isNaN(size) || size === 0) break;
    const start = nl + 2;
    parts.push(buf.subarray(start, start + size));
    pos = start + size + 2;
  }
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// Fetch an HTTPS URL through the CONNECT proxy. Returns a Response.
async function proxyFetch(targetUrl, proxy, headers = {}) {
  const u = new URL(targetUrl);
  const host = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : 443;
  const enc = new TextEncoder();
  const socket = connect({ hostname: proxy.host, port: proxy.port }, { secureTransport: 'starttls', allowHalfOpen: false });

  // 1) CONNECT host:443 through the proxy
  let w = socket.writable.getWriter();
  await w.write(enc.encode(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: ${proxy.auth}\r\n\r\n`));
  w.releaseLock();
  let r = socket.readable.getReader();
  let acc = new Uint8Array(0);
  while (true) {
    const { value, done } = await r.read();
    if (done) throw new Error('proxy closed before CONNECT reply');
    acc = _concat(acc, value);
    if (_findCRLF2(acc) !== -1) break;
  }
  const connLine = new TextDecoder().decode(acc.subarray(0, acc.indexOf(13)));
  if (!connLine.includes(' 200')) throw new Error('CONNECT failed: ' + connLine);
  r.releaseLock();

  // 2) TLS over the tunnel (SNI = target host), then a plain HTTP/1.1 GET
  const tls = socket.startTls({ expectedServerHostname: host });
  w = tls.writable.getWriter();
  let req = `GET ${u.pathname + u.search} HTTP/1.1\r\nHost: ${host}\r\n` +
            `User-Agent: ${headers['User-Agent'] || 'CryptoMonitor/1.0'}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\n`;
  for (const [k, v] of Object.entries(headers)) { if (k.toLowerCase() === 'user-agent') continue; req += `${k}: ${v}\r\n`; }
  req += 'Connection: close\r\n\r\n';
  await w.write(enc.encode(req));
  w.releaseLock();

  // 3) read the whole response (Connection: close → read to EOF)
  r = tls.readable.getReader();
  let resp = new Uint8Array(0);
  while (true) { const { value, done } = await r.read(); if (done) break; resp = _concat(resp, value); }

  const hb = _findCRLF2(resp);
  if (hb === -1) throw new Error('no header boundary from proxied upstream');
  const head = new TextDecoder().decode(resp.subarray(0, hb)).split('\r\n');
  const status = parseInt((head[0].split(' ')[1]) || '502', 10);
  const h = {};
  for (let i = 1; i < head.length; i++) { const c = head[i].indexOf(':'); if (c > 0) h[head[i].slice(0, c).trim().toLowerCase()] = head[i].slice(c + 1).trim(); }
  let body = resp.subarray(hb + 4);
  if ((h['transfer-encoding'] || '').toLowerCase().includes('chunked')) body = _dechunk(body);
  return new Response(body, { status, headers: { 'Content-Type': h['content-type'] || 'application/json' } });
}

// ---- exchangeInfo projection -----------------------------------------------
// Binance's exchangeInfo is 16.7 MB: 3,684 symbols x 26 fields. Both consumers
// in index.html read exactly three of them, with the same filter —
//   symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
//          .map(s => s.baseAsset)
// — which is 484 tickers, about 2 KB of actual signal. Forwarding the catalogue
// cost every visitor a 16.7 MB download and 271 ms of blocking JSON.parse, on
// load and again on every 5-minute refresh.
//
// The projection deliberately keeps the {symbols:[...]} shape and every symbol,
// narrowing each entry to the three fields that are read. That matters: when the
// Worker cannot reach Binance, smartFetch falls back to fetching the RAW
// document straight from the browser, and that leg cannot be projected. Same
// shape and same field names on both legs means the identical client code
// produces identical results either way — no normaliser, and no chance of the
// proxy and fallback paths quietly disagreeing.
//
// Returns null if the body is not the shape we expect, in which case the caller
// forwards it untouched.
function projectExchangeInfo(buf) {
  try {
    const j = JSON.parse(new TextDecoder().decode(buf));
    if (!j || !Array.isArray(j.symbols)) return null;
    return JSON.stringify({
      symbols: j.symbols.map(s => ({
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
      })),
    });
  } catch { return null; }
}

async function cachedProxy(request, upstream, ttl, apiKey, proxy, relay, ctx) {
  const cache = caches.default;
  // Both /api/exchangeInfo and /ex/binance resolve to this same upstream URL —
  // and therefore to the same cache key — so one projection covers both tabs.
  const isExchangeInfo = upstream.startsWith(BINANCE_BASE + '/exchangeInfo');
  // CoinGecko: store cached entries for 24h so stale-while-revalidate survives rate-limit windows
  const isCoinGecko = upstream.includes('coingecko.com');
  const storageTtl = isCoinGecko ? 86400 : ttl * 10;
  // storageTtl is how long the EDGE (and the Worker's own Cache API, a shared
  // cache) may retain the entry. It must not also be the browser's max-age:
  // emitting it as a plain max-age pinned /cb/products in every visitor's HTTP
  // cache for 50 minutes and /cg/ for 24 hours, so the 3-minute auto-refresh and
  // the Refresh button never left the machine. s-maxage governs shared caches
  // and wins there, so the storage window is preserved while clients revalidate
  // on their own cadence.
  const cacheControl = `public, max-age=${BROWSER_MAX_AGE}, s-maxage=${storageTtl}`;
  // Authenticate CoinGecko with a Demo API key when one is configured. A keyed
  // request gets its own quota (30 req/min) instead of sharing the anonymous
  // pool that throttles Cloudflare's datacenter egress IPs down to []. With no
  // key set the behaviour is unchanged (keyless). The key is sent only to the
  // upstream — it is never written into the cache key or the cached response,
  // so a single cached copy is still shared by every visitor.
  const upstreamHeaders = { 'User-Agent': 'CryptoMonitor/1.0' };
  if (isCoinGecko && apiKey) upstreamHeaders['x-cg-demo-api-key'] = apiKey;
  // Route blocked upstreams (Binance/CoinGecko block CF datacenter IPs) through the
  // CONNECT proxy when one is configured; everything else uses normal fetch().
  //
  // Exception — CoinGecko WITH a Demo key goes direct, skipping the proxy. The key
  // carries its own quota, so the request no longer depends on the egress IP being
  // residential, and the proxy path is broken anyway (see proxyFetch) — which is what
  // turned every /cg/ response into []. Keyless CoinGecko still routes through the
  // proxy, since anonymous requests from CF datacenter IPs do get throttled to [] —
  // though with the proxy broken that path is currently academic.
  const cgDirect = isCoinGecko && !!apiKey;
  // Binance goes through the Node relay when one is configured. It takes priority
  // over the CONNECT proxy because it is the path that actually works.
  const useRelay = !!relay && upstream.startsWith(BINANCE_BASE);
  const useProxy = proxy && !cgDirect && !useRelay && (upstream.includes('binance.vision') || upstream.includes('coingecko.com'));
  const doFetch = () => useRelay
    // Short timeout on purpose. A cold Render free instance can take tens of
    // seconds to wake; the Worker must give up fast so index.html's smartFetch
    // falls back to fetching Binance from the visitor's own browser instead of
    // the page hanging. A 502 here is a working page, not a broken one.
    ? fetch(relayUrl(upstream, relay), {
        headers: { ...upstreamHeaders, 'Authorization': `Bearer ${relay.token}`, 'Accept-Encoding': 'gzip' },
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      })
    : useProxy
    ? proxyFetch(upstream, proxy, upstreamHeaders)
    : fetch(upstream, { headers: upstreamHeaders, cf: { cacheTtl: ttl, cacheEverything: true } });
  // Cache entries written before the projection landed hold the raw 16.7 MB
  // document, and a cache hit is served as-is — so without a new key those would
  // keep being served, unprojected, until the entry aged out (up to 5 hours).
  // Versioning the key retires them the moment this deploys. Bump it again if
  // the projected shape ever changes.
  const cacheKey = new Request(upstream + (isExchangeInfo ? '?_shape=v2' : ''), { headers: { 'Cache-Control': 'no-transform' } });

  const cached = await cache.match(cacheKey);
  if (cached) {
    // Stale-while-revalidate: return cached, refresh in background
    const age = Date.now()/1000 - new Date(cached.headers.get('X-Cached-At') || 0).getTime()/1000;
    if (age > ttl) {
      // Background refresh. Registered with waitUntil: an un-awaited promise is
      // free to be cancelled once the response is returned, so without this the
      // refresh that warms the cache often never landed and entries just served
      // stale until eviction.
      const revalidate = doFetch()
        .then(r => r.ok ? r.arrayBuffer().then(buf => {
          const projected = isExchangeInfo ? projectExchangeInfo(buf) : null;
          const fresh = new Response(projected ?? buf, { headers: {
            'Content-Type': projected ? 'application/json' : (r.headers.get('Content-Type') || 'application/json'),
            'X-Cached-At': new Date().toUTCString(),
            'Cache-Control': cacheControl,
          }});
          return cache.put(cacheKey, fresh.clone());
        }) : null)
        .catch(() => null);
      ctx?.waitUntil?.(revalidate);
    }
    return new Response(cached.body, { status: 200, headers: new Headers(cached.headers) });
  }

  // Cache miss — fetch upstream
  try {
    const upstream_resp = await doFetch();
    if (!upstream_resp.ok) {
      // CoinGecko rate-limited: return empty array so the client shows '—' gracefully
      if (isCoinGecko) {
        return new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{"error":"upstream error"}', {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = await upstream_resp.arrayBuffer();
    // Project before caching, so the small copy is what the edge stores and what
    // every later visitor is served.
    const projected = isExchangeInfo ? projectExchangeInfo(body) : null;
    const ct = projected ? 'application/json' : (upstream_resp.headers.get('Content-Type') || 'application/json');
    const response = new Response(projected ?? body, {
      headers: {
        'Content-Type': ct,
        'X-Cached-At': new Date().toUTCString(),
        'Cache-Control': cacheControl,
      },
    });
    // Don't block the first visitor's response on the cache write.
    const stored = cache.put(cacheKey, response.clone());
    if (ctx?.waitUntil) ctx.waitUntil(stored); else await stored;
    return response;
  } catch (e) {
    // CoinGecko fetch error: return empty array rather than 502
    if (isCoinGecko) {
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'fetch failed', detail: String((e && e.message) || e).slice(0, 200) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname + url.search; // NOTE: includes the query string — proxy routes use path.slice(N) directly; do NOT also append url.search (that doubled the query and corrupted CoinGecko's per_page)
    const ttl = getTTL(path);
    const proxy = parseProxy(env.PROXY_URL);
    const relay = parseRelay(env);

    // Force HTTPS — check both url.protocol and CF-Visitor header
    const cfVisitor = request.headers.get('CF-Visitor');
    const originalScheme = cfVisitor ? JSON.parse(cfVisitor).scheme : url.protocol.replace(':', '');
    if (originalScheme === 'http') {
      const httpsUrl = request.url.replace(/^http:/, 'https:');
      return Response.redirect(httpsUrl, 301);
    }

    // No CORS preflight handler, and no Access-Control-Allow-Origin on the proxy
    // responses. index.html reaches every proxy route as a same-origin relative
    // path, and smartFetch's direct fallback goes to upstreams that send their
    // own CORS headers — so the wildcard did nothing for this site and only let
    // any other origin spend the CG_DEMO_KEY quota through our warm cache.
    // Re-adding it needs a concrete cross-origin consumer; there is none today.
    //
    // With the preflight short-circuit gone, an OPTIONS would otherwise fall
    // through to the route handlers and be proxied upstream as if it were a GET.
    // This site only ever reads.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('{"error":"method not allowed"}', {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Allow': 'GET, HEAD' },
      });
    }

    // /api/* → Binance (allowlisted endpoints only)
    if (path.startsWith('/api/')) {
      const sub = path.slice(4);
      if (!isAllowed(BINANCE_ALLOWED, path.slice(4).split('?')[0])) {
        return new Response('{"error":"not allowed"}', { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return cachedProxy(request, BINANCE_BASE + sub, ttl, undefined, proxy, relay, ctx);
    }

    // /cb/* → Coinbase (allowlisted endpoints only)
    if (path.startsWith('/cb/')) {
      const sub = path.slice(3).split('?')[0];
      if (!isAllowed(COINBASE_ALLOWED, sub)) {
        return new Response('{"error":"not allowed"}', { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return cachedProxy(request, COINBASE_BASE + path.slice(3), ttl, undefined, proxy, relay, ctx);
    }

    // /cg/* → CoinGecko (allowlisted endpoints only)
    if (path.startsWith('/cg/')) {
      const sub = path.slice(3).split('?')[0];
      if (!isAllowed(COINGECKO_ALLOWED, sub)) {
        return new Response('{"error":"not allowed"}', { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return cachedProxy(request, COINGECKO_BASE + path.slice(3), ttl, env.CG_DEMO_KEY, proxy, relay, ctx);
    }

    // /llama/* → DefiLlama stablecoins (allowlisted endpoints only)
    // Without this route the path fell through to the catch-all and answered
    // 200 text/html, which smartFetch could not tell from a real response — so
    // the stablecoin tab silently ran CoinGecko-only (no chains, no discovery).
    if (path.startsWith('/llama/')) {
      const sub = path.slice(6).split('?')[0];
      if (!isAllowed(LLAMA_ALLOWED, sub)) {
        return new Response('{"error":"not allowed"}', { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return cachedProxy(request, LLAMA_BASE + path.slice(6), ttl, undefined, proxy, relay, ctx);
    }

    // /ex/<exchange> → exchange info
    if (path.startsWith('/ex/')) {
      const ex = path.slice(4).split('?')[0];
      const upstream = EXCHANGE_URLS[ex];
      if (!upstream) return new Response('{"error":"unknown exchange"}', { status: 404 });
      return cachedProxy(request, upstream, 1800, undefined, proxy, relay, ctx);
    }

    // Favicon
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
      return new Response(FAVICON_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
    }

    // SEO: robots.txt
    if (url.pathname === '/robots.txt') {
      return new Response(
        'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /cb/\nDisallow: /cg/\nDisallow: /ex/\nDisallow: /llama/\nSitemap: https://shitcoin.io/sitemap.xml\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }
      );
    }

    // SEO: sitemap.xml
    if (url.pathname === '/sitemap.xml') {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://shitcoin.io/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url><url><loc>https://shitcoin.io/terms</loc><changefreq>monthly</changefreq><priority>0.2</priority></url><url><loc>https://shitcoin.io/privacy</loc><changefreq>monthly</changefreq><priority>0.2</priority></url></urlset>`,
        { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } }
      );
    }

    // SEO: OG image
    if (url.pathname === '/og-image.png' || url.pathname === '/og-image.svg') {
      return new Response(OG_IMAGE_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
    }

    // Legal pages
    if (url.pathname === '/terms') {
      return new Response(TERMS_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    }
    if (url.pathname === '/privacy') {
      return new Response(PRIVACY_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    }

    // Everything else → serve index.html
    const htmlHeaders = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'ETag': HTML_ETAG,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    };
    if (request.headers.get('If-None-Match') === HTML_ETAG) {
      return new Response(null, { status: 304, headers: htmlHeaders });
    }
    return new Response(HTML, { headers: htmlHeaders });
  },
};

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0d0f14"/><polygon points="19,3 9,17 15.5,17 13,29 23,15 16.5,15" fill="#f59e0b"/></svg>`;

const SHARED_LEGAL_CSS = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#07080c;color:#e4e6ef;font-family:'DM Sans',sans-serif;min-height:100vh;line-height:1.7}.topnav{position:sticky;top:0;z-index:200;background:rgba(7,8,12,0.92);backdrop-filter:blur(16px);border-bottom:1px solid #1c1f2b}.topnav-inner{max-width:900px;margin:0 auto;padding:0 24px;height:54px;display:flex;align-items:center;gap:0}.tnav-brand{display:flex;align-items:center;gap:9px;text-decoration:none;color:#e4e6ef}.tnav-logo{width:30px;height:30px;background:#191c25;border:1px solid #252938;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:15px;color:#f59e0b;font-family:'IBM Plex Mono',monospace;font-weight:800}.tnav-name{font-size:13px;font-weight:700;color:#9498ad}.tnav-back{margin-left:auto;font-size:12px;font-family:'IBM Plex Mono',monospace;color:#3b82f6;text-decoration:none;padding:6px 14px;border:1px solid rgba(59,130,246,0.2);border-radius:6px;background:rgba(59,130,246,0.05)}.tnav-back:hover{background:rgba(59,130,246,0.1)}.legal-wrap{max-width:760px;margin:0 auto;padding:48px 24px 80px}.legal-wrap h1{font-size:28px;font-weight:800;letter-spacing:-0.5px;margin-bottom:6px}.legal-wrap .updated{font-size:12px;color:#5d6178;font-family:'IBM Plex Mono',monospace;margin-bottom:40px}.legal-wrap h2{font-size:16px;font-weight:700;color:#e4e6ef;margin:32px 0 10px;padding-bottom:8px;border-bottom:1px solid #1c1f2b}.legal-wrap p{font-size:14px;color:#9498ad;margin-bottom:12px}.legal-wrap ul{margin:8px 0 14px 20px}.legal-wrap li{font-size:14px;color:#9498ad;margin-bottom:6px}.legal-wrap a{color:#3b82f6}.disclaimer-box{background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:16px 20px;margin:24px 0}.disclaimer-box p{color:#fca5a5;margin:0;font-size:13px;font-weight:500}.footer{text-align:center;padding:32px 0;border-top:1px solid #1c1f2b;font-size:12px;color:#5d6178;font-family:'IBM Plex Mono',monospace}.footer a{color:#3b82f6;text-decoration:none}</style>`;

const TERMS_HTML = `<!DOCTYPE html><html lang="en"><head><title>Terms of Use · shitcoin.io</title>${SHARED_LEGAL_CSS}</head><body><nav class="topnav"><div class="topnav-inner"><a class="tnav-brand" href="/"><div class="tnav-logo">&#9889;</div><span class="tnav-name">shitcoin.io</span></a><a class="tnav-back" href="/">&#8592; Back to Monitor</a></div></nav><div class="legal-wrap"><h1>Terms of Use</h1><div class="updated">Last updated: March 2026</div><div class="disclaimer-box"><p>&#9888;&#65039; IMPORTANT: This site does not provide financial advice. All data is for informational purposes only. Never make investment decisions based solely on this data.</p></div><h2>1. Acceptance</h2><p>By accessing shitcoin.io you agree to these Terms. If you disagree, please do not use the service.</p><h2>2. What We Do</h2><p>shitcoin.io displays publicly available cryptocurrency market data from Binance, Coinbase, CoinGecko, and other sources. We show risk scores, monitoring tags, delisting announcements, and order book data. This is a data aggregation and display service only.</p><h2>3. No Financial Advice</h2><p>Nothing on this site constitutes financial advice, investment advice, trading advice, or any other sort of advice. The risk scores, labels, and rankings shown are algorithmic calculations based on publicly available data &mdash; they are not recommendations to buy, sell, or hold any asset.</p><p>Cryptocurrency markets are highly volatile. Past delisting patterns do not predict future delistings. You could lose all money invested in any cryptocurrency.</p><h2>4. Data Accuracy</h2><p>Data is sourced from third-party APIs (Binance, Coinbase, CoinGecko). We make no representations about the accuracy, completeness, or timeliness of any data. API data may be delayed, incorrect, or unavailable. Do not rely on this data for time-sensitive trading decisions.</p><h2>5. Eligibility</h2><p>You must be at least 18 years old to use this service. By using the service you represent that you are 18 or older.</p><h2>6. Prohibited Uses</h2><p>You may not use this service to:</p><ul><li>Scrape or systematically download data for commercial resale</li><li>Interfere with the service or its underlying infrastructure</li><li>Violate any applicable law or regulation</li><li>Misrepresent data from this site as your own original research</li></ul><h2>7. Disclaimer of Warranties</h2><p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND. WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p><h2>8. Limitation of Liability</h2><p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICE.</p><h2>9. Changes</h2><p>We reserve the right to modify these Terms at any time. Continued use of the service after changes constitutes acceptance of the new Terms.</p><h2>10. Governing Law</h2><p>These Terms are governed by applicable law. Any disputes shall be resolved through binding arbitration or in courts of competent jurisdiction.</p><h2>11. Contact</h2><p>Questions about these Terms? The site is operated as an independent project. See our <a href="/privacy">Privacy Policy</a> for more information.</p></div><div class="footer"><a href="/">shitcoin.io</a> &nbsp;&middot;&nbsp; <a href="/terms">Terms</a> &nbsp;&middot;&nbsp; <a href="/privacy">Privacy</a></div></body></html>`;

const PRIVACY_HTML = `<!DOCTYPE html><html lang="en"><head><title>Privacy Policy · shitcoin.io</title>${SHARED_LEGAL_CSS}</head><body><nav class="topnav"><div class="topnav-inner"><a class="tnav-brand" href="/"><div class="tnav-logo">&#9889;</div><span class="tnav-name">shitcoin.io</span></a><a class="tnav-back" href="/">&#8592; Back to Monitor</a></div></nav><div class="legal-wrap"><h1>Privacy Policy</h1><div class="updated">Last updated: June 2026</div><p>shitcoin.io is committed to protecting your privacy. This policy explains what data we collect, how we use it, and your rights.</p><h2>1. Data We Collect</h2><p><strong>Analytics data (with consent only):</strong> If you accept cookies, we use Google Analytics to collect anonymized usage data including pages visited, session duration, general geographic region (country/city), browser type, and device type. We do not collect personally identifiable information.</p><p><strong>Local storage:</strong> We store your cookie consent preference (<code>cm_consent_v1</code>) and your UI preferences &mdash; active filter and sort order (<code>cm_prefs_v1</code>) &mdash; in your browser's localStorage. This data never leaves your device and is not readable by us.</p><p><strong>No account data:</strong> We do not require accounts, logins, or any registration. We do not collect your name, email address, or payment information.</p><h2>2. Cookies</h2><p>We use cookies only if you consent. If you accept analytics cookies, Google Analytics sets the following cookies:</p><ul><li><strong>_ga</strong> &mdash; Distinguishes users (expires 2 years)</li><li><strong>_ga_*</strong> &mdash; Maintains session state (expires 2 years)</li></ul><p>You can withdraw consent at any time by clearing your browser cookies and localStorage, or by using browser privacy tools.</p><h2>3. How We Use Data</h2><p>Analytics data is used solely to understand how the service is used in aggregate &mdash; which features are popular, how many people visit, and general geographic distribution. We do not sell, share, or use this data for advertising targeting.</p><h2>4. Third-Party Services</h2><p>This site fetches data from the following third-party APIs. When your browser loads the page, it may make requests to these services:</p><ul><li><strong>Binance API</strong> (data-api.binance.vision) &mdash; Market data</li><li><strong>Coinbase API</strong> (api.exchange.coinbase.com) &mdash; Market data</li><li><strong>CoinGecko API</strong> (api.coingecko.com) &mdash; Market cap and price data</li><li><strong>Google Analytics</strong> (googletagmanager.com) &mdash; Analytics, consent-gated</li><li><strong>Google Fonts</strong> (fonts.googleapis.com) &mdash; Typography</li><li><strong>Google favicon service</strong> (google.com/s2/favicons) &mdash; Exchange icons shown next to each coin. Requested on every page view, not gated behind the analytics consent.</li><li><strong>CoinGecko images</strong> (coin-images.coingecko.com) &mdash; Coin logos</li><li><strong>jsDelivr</strong> (cdn.jsdelivr.net) &mdash; Fallback coin logos</li></ul><p>Market-data calls are normally proxied through our Cloudflare Worker, so your IP is not exposed to the exchanges. However, when our Worker cannot reach an exchange (for example, Binance currently blocks our datacenter IPs), your browser fetches that market data <strong>directly from the exchange</strong> as a fallback, which exposes your IP address and standard request headers to that service &mdash; the same as if you visited it directly. We never send any other personal data. Fonts and Analytics are loaded directly from Google servers if you consent.</p><h2>5. Data Retention</h2><p>Analytics data in Google Analytics is retained for 14 months by default. Local storage data stays on your device until you clear it. We have no server-side database.</p><h2>6. Your Rights (GDPR)</h2><p>If you are in the European Economic Area, you have the right to:</p><ul><li>Access the data we hold about you (we hold none beyond anonymized analytics)</li><li>Request deletion (Google Analytics data can be deleted via Google's tools)</li><li>Withdraw consent at any time (decline cookies or clear localStorage)</li><li>Lodge a complaint with your local data protection authority</li></ul><h2>7. Children</h2><p>This service is not intended for users under 18. We do not knowingly collect data from minors.</p><h2>8. Changes</h2><p>We may update this policy. The date at the top of this page reflects the last update. Continued use after changes constitutes acceptance.</p><h2>9. Contact</h2><p>For privacy questions, you can reach us via the site footer links. We aim to respond within 30 days.</p></div><div class="footer"><a href="/">shitcoin.io</a> &nbsp;&middot;&nbsp; <a href="/terms">Terms</a> &nbsp;&middot;&nbsp; <a href="/privacy">Privacy</a></div></body></html>`;

const OG_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#020408"/><rect x="0" y="0" width="1200" height="630" fill="url(#grad)"/><defs><linearGradient id="grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0d1320"/><stop offset="100%" stop-color="#020408"/></linearGradient></defs><rect x="60" y="60" width="1080" height="510" rx="16" fill="#080c14" stroke="#1a2540" stroke-width="1.5"/><polygon points="110,120 90,150 103,150 98,180 118,150 105,150" fill="#f59e0b"/><text x="130" y="152" font-family="monospace" font-weight="800" font-size="28" fill="#f59e0b">shitcoin.io</text><text x="90" y="230" font-family="monospace" font-weight="700" font-size="52" fill="#e4e6ef">Crypto Delisting</text><text x="90" y="295" font-family="monospace" font-weight="700" font-size="52" fill="#e4e6ef">Monitor</text><text x="90" y="370" font-family="sans-serif" font-size="26" fill="#5d6178">Real-time risk scores for Binance &amp; Coinbase coins</text><rect x="90" y="420" width="180" height="44" rx="8" fill="rgba(239,68,68,0.15)" stroke="rgba(239,68,68,0.3)" stroke-width="1"/><text x="180" y="448" font-family="monospace" font-size="16" fill="#f87171" text-anchor="middle">HIGH RISK</text><rect x="290" y="420" width="180" height="44" rx="8" fill="rgba(234,179,8,0.12)" stroke="rgba(234,179,8,0.3)" stroke-width="1"/><text x="380" y="448" font-family="monospace" font-size="16" fill="#eab308" text-anchor="middle">WATCH LIST</text><rect x="490" y="420" width="180" height="44" rx="8" fill="rgba(59,130,246,0.12)" stroke="rgba(59,130,246,0.3)" stroke-width="1"/><text x="580" y="448" font-family="monospace" font-size="16" fill="#3b82f6" text-anchor="middle">ORDER BOOK</text></svg>`;

const HTML = `__HTML_PLACEHOLDER__`;

// Validator for the HTML response. `Cache-Control: no-cache` means "revalidate
// before reuse" — but with no ETag and no Last-Modified there was nothing to
// revalidate against, so every navigation re-downloaded the whole ~157 KB
// document where a 304 would do. FNV-1a over the built HTML: this is a cache
// validator, not a security digest, and it is computed once per isolate.
const HTML_ETAG = (() => {
  let h = 0x811c9dc5;
  for (let i = 0; i < HTML.length; i++) {
    h ^= HTML.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `"${h.toString(16)}-${HTML.length.toString(16)}"`;
})();
