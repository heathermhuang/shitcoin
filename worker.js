/**
 * Cloudflare Worker for shitcoin.io
 * Serves index.html and proxies API calls to Binance/Coinbase/CoinGecko/exchanges.
 * Uses Cloudflare Cache API for stale-while-revalidate.
 */

const BINANCE_BASE  = 'https://data-api.binance.vision/api/v3';
const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

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
  ['/cg/',         300],
  ['/ex/',        1800],
];

function getTTL(path) {
  for (const [k, v] of TTL_MAP) if (path.includes(k)) return v;
  return 120;
}

async function cachedProxy(request, upstream, ttl) {
  const cache = caches.default;
  // CoinGecko: store cached entries for 24h so stale-while-revalidate survives rate-limit windows
  const isCoinGecko = upstream.includes('coingecko.com');
  const storageTtl = isCoinGecko ? 86400 : ttl * 10;
  const cacheKey = new Request(upstream, { headers: { 'Cache-Control': 'no-transform' } });

  const cached = await cache.match(cacheKey);
  if (cached) {
    // Stale-while-revalidate: return cached, refresh in background
    const age = Date.now()/1000 - new Date(cached.headers.get('X-Cached-At') || 0).getTime()/1000;
    if (age > ttl) {
      // Background refresh — don't await
      fetch(upstream, { headers: { 'User-Agent': 'CryptoMonitor/1.0' } })
        .then(r => r.ok ? r.blob().then(b => {
          const fresh = new Response(b, { headers: {
            'Content-Type': r.headers.get('Content-Type') || 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Cached-At': new Date().toUTCString(),
            'Cache-Control': `public, max-age=${storageTtl}`,
          }});
          cache.put(cacheKey, fresh.clone());
        }) : null)
        .catch(() => null);
    }
    // Return cached with CORS header
    const headers = new Headers(cached.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(cached.body, { status: 200, headers });
  }

  // Cache miss — fetch upstream
  try {
    const upstream_resp = await fetch(upstream, {
      headers: { 'User-Agent': 'CryptoMonitor/1.0' },
      cf: { cacheTtl: ttl, cacheEverything: true },
    });
    if (!upstream_resp.ok) {
      // CoinGecko rate-limited: return empty array so the client shows '—' gracefully
      if (isCoinGecko) {
        return new Response('[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      return new Response('{"error":"upstream error"}', {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    const body = await upstream_resp.arrayBuffer();
    const ct = upstream_resp.headers.get('Content-Type') || 'application/json';
    const response = new Response(body, {
      headers: {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'X-Cached-At': new Date().toUTCString(),
        'Cache-Control': `public, max-age=${storageTtl}`,
      },
    });
    await cache.put(cacheKey, response.clone());
    return response;
  } catch (e) {
    // CoinGecko fetch error: return empty array rather than 502
    if (isCoinGecko) {
      return new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    return new Response('{"error":"fetch failed"}', {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const ttl = getTTL(path);

    // Force HTTPS — check both url.protocol and CF-Visitor header
    const cfVisitor = request.headers.get('CF-Visitor');
    const originalScheme = cfVisitor ? JSON.parse(cfVisitor).scheme : url.protocol.replace(':', '');
    if (originalScheme === 'http') {
      const httpsUrl = request.url.replace(/^http:/, 'https:');
      return Response.redirect(httpsUrl, 301);
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Max-Age': '86400',
      }});
    }

    // /api/* → Binance
    if (path.startsWith('/api/')) {
      return cachedProxy(request, BINANCE_BASE + path.slice(4), ttl);
    }

    // /cb/* → Coinbase
    if (path.startsWith('/cb/')) {
      return cachedProxy(request, COINBASE_BASE + path.slice(3), ttl);
    }

    // /cg/* → CoinGecko
    if (path.startsWith('/cg/')) {
      return cachedProxy(request, COINGECKO_BASE + path.slice(3), ttl);
    }

    // /ex/<exchange> → exchange info
    if (path.startsWith('/ex/')) {
      const ex = path.slice(4).split('?')[0];
      const upstream = EXCHANGE_URLS[ex];
      if (!upstream) return new Response('{"error":"unknown exchange"}', { status: 404 });
      return cachedProxy(request, upstream, 1800);
    }

    // Everything else → serve index.html
    return new Response(HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  },
};

const HTML = `__HTML_PLACEHOLDER__`;
