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

    // Favicon
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
      return new Response(FAVICON_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
    }

    // SEO: robots.txt
    if (url.pathname === '/robots.txt') {
      return new Response(
        'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /cb/\nDisallow: /cg/\nDisallow: /ex/\nSitemap: https://shitcoin.io/sitemap.xml\n',
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
    return new Response(HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  },
};

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0d0f14"/><polygon points="19,3 9,17 15.5,17 13,29 23,15 16.5,15" fill="#f59e0b"/></svg>`;

const SHARED_LEGAL_CSS = `<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#07080c;color:#e4e6ef;font-family:'DM Sans',sans-serif;min-height:100vh;line-height:1.7}.topnav{position:sticky;top:0;z-index:200;background:rgba(7,8,12,0.92);backdrop-filter:blur(16px);border-bottom:1px solid #1c1f2b}.topnav-inner{max-width:900px;margin:0 auto;padding:0 24px;height:54px;display:flex;align-items:center;gap:0}.tnav-brand{display:flex;align-items:center;gap:9px;text-decoration:none;color:#e4e6ef}.tnav-logo{width:30px;height:30px;background:#191c25;border:1px solid #252938;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:15px;color:#f59e0b;font-family:'IBM Plex Mono',monospace;font-weight:800}.tnav-name{font-size:13px;font-weight:700;color:#9498ad}.tnav-back{margin-left:auto;font-size:12px;font-family:'IBM Plex Mono',monospace;color:#3b82f6;text-decoration:none;padding:6px 14px;border:1px solid rgba(59,130,246,0.2);border-radius:6px;background:rgba(59,130,246,0.05)}.tnav-back:hover{background:rgba(59,130,246,0.1)}.legal-wrap{max-width:760px;margin:0 auto;padding:48px 24px 80px}.legal-wrap h1{font-size:28px;font-weight:800;letter-spacing:-0.5px;margin-bottom:6px}.legal-wrap .updated{font-size:12px;color:#5d6178;font-family:'IBM Plex Mono',monospace;margin-bottom:40px}.legal-wrap h2{font-size:16px;font-weight:700;color:#e4e6ef;margin:32px 0 10px;padding-bottom:8px;border-bottom:1px solid #1c1f2b}.legal-wrap p{font-size:14px;color:#9498ad;margin-bottom:12px}.legal-wrap ul{margin:8px 0 14px 20px}.legal-wrap li{font-size:14px;color:#9498ad;margin-bottom:6px}.legal-wrap a{color:#3b82f6}.disclaimer-box{background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:16px 20px;margin:24px 0}.disclaimer-box p{color:#fca5a5;margin:0;font-size:13px;font-weight:500}.footer{text-align:center;padding:32px 0;border-top:1px solid #1c1f2b;font-size:12px;color:#5d6178;font-family:'IBM Plex Mono',monospace}.footer a{color:#3b82f6;text-decoration:none}</style>`;

const TERMS_HTML = `<!DOCTYPE html><html lang="en"><head><title>Terms of Use · shitcoin.io</title>${SHARED_LEGAL_CSS}</head><body><nav class="topnav"><div class="topnav-inner"><a class="tnav-brand" href="/"><div class="tnav-logo">&#9889;</div><span class="tnav-name">shitcoin.io</span></a><a class="tnav-back" href="/">&#8592; Back to Monitor</a></div></nav><div class="legal-wrap"><h1>Terms of Use</h1><div class="updated">Last updated: March 2026</div><div class="disclaimer-box"><p>&#9888;&#65039; IMPORTANT: This site does not provide financial advice. All data is for informational purposes only. Never make investment decisions based solely on this data.</p></div><h2>1. Acceptance</h2><p>By accessing shitcoin.io you agree to these Terms. If you disagree, please do not use the service.</p><h2>2. What We Do</h2><p>shitcoin.io displays publicly available cryptocurrency market data from Binance, Coinbase, CoinGecko, and other sources. We show risk scores, monitoring tags, delisting announcements, and order book data. This is a data aggregation and display service only.</p><h2>3. No Financial Advice</h2><p>Nothing on this site constitutes financial advice, investment advice, trading advice, or any other sort of advice. The risk scores, labels, and rankings shown are algorithmic calculations based on publicly available data &mdash; they are not recommendations to buy, sell, or hold any asset.</p><p>Cryptocurrency markets are highly volatile. Past delisting patterns do not predict future delistings. You could lose all money invested in any cryptocurrency.</p><h2>4. Data Accuracy</h2><p>Data is sourced from third-party APIs (Binance, Coinbase, CoinGecko). We make no representations about the accuracy, completeness, or timeliness of any data. API data may be delayed, incorrect, or unavailable. Do not rely on this data for time-sensitive trading decisions.</p><h2>5. Eligibility</h2><p>You must be at least 18 years old to use this service. By using the service you represent that you are 18 or older.</p><h2>6. Prohibited Uses</h2><p>You may not use this service to:</p><ul><li>Scrape or systematically download data for commercial resale</li><li>Interfere with the service or its underlying infrastructure</li><li>Violate any applicable law or regulation</li><li>Misrepresent data from this site as your own original research</li></ul><h2>7. Disclaimer of Warranties</h2><p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND. WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.</p><h2>8. Limitation of Liability</h2><p>TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES, WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICE.</p><h2>9. Changes</h2><p>We reserve the right to modify these Terms at any time. Continued use of the service after changes constitutes acceptance of the new Terms.</p><h2>10. Governing Law</h2><p>These Terms are governed by applicable law. Any disputes shall be resolved through binding arbitration or in courts of competent jurisdiction.</p><h2>11. Contact</h2><p>Questions about these Terms? The site is operated as an independent project. See our <a href="/privacy">Privacy Policy</a> for more information.</p></div><div class="footer"><a href="/">shitcoin.io</a> &nbsp;&middot;&nbsp; <a href="/terms">Terms</a> &nbsp;&middot;&nbsp; <a href="/privacy">Privacy</a></div></body></html>`;

const PRIVACY_HTML = `<!DOCTYPE html><html lang="en"><head><title>Privacy Policy · shitcoin.io</title>${SHARED_LEGAL_CSS}</head><body><nav class="topnav"><div class="topnav-inner"><a class="tnav-brand" href="/"><div class="tnav-logo">&#9889;</div><span class="tnav-name">shitcoin.io</span></a><a class="tnav-back" href="/">&#8592; Back to Monitor</a></div></nav><div class="legal-wrap"><h1>Privacy Policy</h1><div class="updated">Last updated: March 2026</div><p>shitcoin.io is committed to protecting your privacy. This policy explains what data we collect, how we use it, and your rights.</p><h2>1. Data We Collect</h2><p><strong>Analytics data (with consent only):</strong> If you accept cookies, we use Google Analytics to collect anonymized usage data including pages visited, session duration, general geographic region (country/city), browser type, and device type. We do not collect personally identifiable information.</p><p><strong>Local storage:</strong> We store your cookie consent preference and UI preferences (sort order, active filter) in your browser's localStorage. This data never leaves your device.</p><p><strong>No account data:</strong> We do not require accounts, logins, or any registration. We do not collect your name, email address, or payment information.</p><h2>2. Cookies</h2><p>We use cookies only if you consent. If you accept analytics cookies, Google Analytics sets the following cookies:</p><ul><li><strong>_ga</strong> &mdash; Distinguishes users (expires 2 years)</li><li><strong>_ga_*</strong> &mdash; Maintains session state (expires 2 years)</li></ul><p>You can withdraw consent at any time by clearing your browser cookies and localStorage, or by using browser privacy tools.</p><h2>3. How We Use Data</h2><p>Analytics data is used solely to understand how the service is used in aggregate &mdash; which features are popular, how many people visit, and general geographic distribution. We do not sell, share, or use this data for advertising targeting.</p><h2>4. Third-Party Services</h2><p>This site fetches data from the following third-party APIs. When your browser loads the page, it may make requests to these services:</p><ul><li><strong>Binance API</strong> (data-api.binance.vision) &mdash; Market data</li><li><strong>Coinbase API</strong> (api.exchange.coinbase.com) &mdash; Market data</li><li><strong>CoinGecko API</strong> (api.coingecko.com) &mdash; Market cap and price data</li><li><strong>Google Analytics</strong> (googletagmanager.com) &mdash; Analytics, consent-gated</li><li><strong>Google Fonts</strong> (fonts.googleapis.com) &mdash; Typography</li></ul><p>All API calls to Binance and CoinGecko are proxied through our Cloudflare Worker, so your IP is not directly exposed to those services. Fonts and Analytics are loaded directly from Google servers if you consent.</p><h2>5. Data Retention</h2><p>Analytics data in Google Analytics is retained for 14 months by default. Local storage data stays on your device until you clear it. We have no server-side database.</p><h2>6. Your Rights (GDPR)</h2><p>If you are in the European Economic Area, you have the right to:</p><ul><li>Access the data we hold about you (we hold none beyond anonymized analytics)</li><li>Request deletion (Google Analytics data can be deleted via Google's tools)</li><li>Withdraw consent at any time (decline cookies or clear localStorage)</li><li>Lodge a complaint with your local data protection authority</li></ul><h2>7. Children</h2><p>This service is not intended for users under 18. We do not knowingly collect data from minors.</p><h2>8. Changes</h2><p>We may update this policy. The date at the top of this page reflects the last update. Continued use after changes constitutes acceptance.</p><h2>9. Contact</h2><p>For privacy questions, you can reach us via the site footer links. We aim to respond within 30 days.</p></div><div class="footer"><a href="/">shitcoin.io</a> &nbsp;&middot;&nbsp; <a href="/terms">Terms</a> &nbsp;&middot;&nbsp; <a href="/privacy">Privacy</a></div></body></html>`;

const OG_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#020408"/><rect x="0" y="0" width="1200" height="630" fill="url(#grad)"/><defs><linearGradient id="grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0d1320"/><stop offset="100%" stop-color="#020408"/></linearGradient></defs><rect x="60" y="60" width="1080" height="510" rx="16" fill="#080c14" stroke="#1a2540" stroke-width="1.5"/><polygon points="110,120 90,150 103,150 98,180 118,150 105,150" fill="#f59e0b"/><text x="130" y="152" font-family="monospace" font-weight="800" font-size="28" fill="#f59e0b">shitcoin.io</text><text x="90" y="230" font-family="monospace" font-weight="700" font-size="52" fill="#e4e6ef">Crypto Delisting</text><text x="90" y="295" font-family="monospace" font-weight="700" font-size="52" fill="#e4e6ef">Monitor</text><text x="90" y="370" font-family="sans-serif" font-size="26" fill="#5d6178">Real-time risk scores for Binance &amp; Coinbase coins</text><rect x="90" y="420" width="180" height="44" rx="8" fill="rgba(239,68,68,0.15)" stroke="rgba(239,68,68,0.3)" stroke-width="1"/><text x="180" y="448" font-family="monospace" font-size="16" fill="#f87171" text-anchor="middle">HIGH RISK</text><rect x="290" y="420" width="180" height="44" rx="8" fill="rgba(234,179,8,0.12)" stroke="rgba(234,179,8,0.3)" stroke-width="1"/><text x="380" y="448" font-family="monospace" font-size="16" fill="#eab308" text-anchor="middle">WATCH LIST</text><rect x="490" y="420" width="180" height="44" rx="8" fill="rgba(59,130,246,0.12)" stroke="rgba(59,130,246,0.3)" stroke-width="1"/><text x="580" y="448" font-family="monospace" font-size="16" fill="#3b82f6" text-anchor="middle">ORDER BOOK</text></svg>`;

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Crypto Delisting Monitor — Binance &amp; Coinbase Risk Scores | shitcoin.io</title>
<meta name="description" content="Real-time crypto delisting monitor for Binance and Coinbase. Track coins under delisting watch with risk scores, order book depth, market cap, and cross-exchange data.">
<link rel="canonical" href="https://shitcoin.io/">
<meta property="og:title" content="Crypto Delisting Monitor — Binance &amp; Coinbase Risk Scores">
<meta property="og:description" content="Track Binance and Coinbase coins under delisting watch. Real-time risk scores, order book depth, and market data for 100+ coins.">
<meta property="og:url" content="https://shitcoin.io/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="shitcoin.io">
<meta property="og:locale" content="en_US">
<meta property="og:image" content="https://shitcoin.io/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@shitcoinio">
<meta name="twitter:title" content="Crypto Delisting Monitor — Binance &amp; Coinbase">
<meta name="twitter:description" content="Track coins under delisting watch with real-time risk scores and order book depth.">
<meta name="twitter:image" content="https://shitcoin.io/og-image.png">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="alternate icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://coin-images.coingecko.com" crossorigin>
<link rel="preconnect" href="https://icons.llamao.fi" crossorigin>
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="dns-prefetch" href="https://www.google.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
:root {
    --bg-0: #020408;
    --bg-1: #080c14;
    --bg-2: #0d1320;
    --bg-3: #131b2e;
    --bg-4: #1a2540;
    --border-1: rgba(255,255,255,0.06);
    --border-2: rgba(255,255,255,0.10);
    --border-3: rgba(255,255,255,0.15);
    --text-1: #f1f5f9;
    --text-2: #94a3b8;
    --text-3: #475569;
    --red: #ef4444;
    --red-soft: rgba(239,68,68,0.12);
    --amber: #f59e0b;
    --amber-soft: rgba(245,158,11,0.12);
    --green: #22c55e;
    --green-soft: rgba(34,197,94,0.12);
    --blue: #3b82f6;
    --blue-soft: rgba(59,130,246,0.12);
    --purple: #a855f7;
    --purple-soft: rgba(168,85,247,0.12);
    --cyan: #06b6d4;
    --cyan-soft: rgba(6,182,212,0.12);
}
*{margin:0;padding:0;box-sizing:border-box;font-family:inherit}
html{font-family:'Inter',sans-serif}
body{background:var(--bg-0);color:var(--text-1);font-family:'Inter',sans-serif;min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body::after{content:'';position:fixed;top:0;left:0;width:100%;height:100%;opacity:0.025;background:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;max-width:1700px;margin:0 auto;padding:28px 24px}
.mono{font-family:'IBM Plex Mono',monospace}

/* HEADER */
.hdr{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:24px}
.hdr-left{display:flex;align-items:center;gap:14px}
.logo{width:38px;height:38px;background:linear-gradient(135deg,#f59e0b,#ea580c);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;font-family:'IBM Plex Mono',monospace;box-shadow:0 4px 12px rgba(245,158,11,0.25)}
.hdr h1{font-size:22px;font-weight:800;letter-spacing:-0.5px;color:var(--text-1)}
.hdr .sub{font-size:12px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:3px;letter-spacing:0.01em}
.hdr-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.live{display:flex;align-items:center;gap:6px;font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--green);background:rgba(34,197,94,0.08);padding:5px 12px;border-radius:20px;border:1px solid rgba(34,197,94,0.2);letter-spacing:0.05em;font-weight:600}
.live-dot{width:6px;height:6px;background:var(--green);border-radius:50%;animation:blink 1.4s ease-in-out infinite;box-shadow:0 0 6px rgba(34,197,94,0.6)}
@keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.3;transform:scale(0.8)}}
.meta-text{font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--text-3)}
.btn{background:var(--bg-3);border:1px solid var(--border-2);color:var(--text-2);padding:7px 14px;border-radius:8px;font-family:'IBM Plex Mono',monospace;font-size:11px;cursor:pointer;transition:all 0.2s cubic-bezier(0.16,1,0.3,1);display:flex;align-items:center;gap:5px}
.btn:hover{background:var(--bg-4);border-color:var(--border-3);color:var(--text-1);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,0.3)}
.btn:active{transform:translateY(0)}
.btn.spinning svg{animation:spin 0.8s linear infinite}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

/* STATS */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:24px}
.stat{background:linear-gradient(135deg,var(--bg-2) 0%,var(--bg-1) 100%);border:1px solid var(--border-1);border-radius:12px;padding:20px 24px;transition:all 0.2s;position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
.stat.r::before{background:var(--red)}.stat.a::before{background:var(--amber)}.stat.g::before{background:var(--green)}.stat.b::before{background:var(--blue)}.stat.p::before{background:var(--purple)}
.stat:hover{border-color:var(--border-2);transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,0,0,0.3)}
.stat-label{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-bottom:8px;font-weight:500}
.stat-val{font-size:28px;font-weight:700;letter-spacing:-0.5px;line-height:1;font-family:'IBM Plex Mono',monospace}
.stat-val.r{color:var(--red)}.stat-val.a{color:var(--amber)}.stat-val.g{color:var(--green)}.stat-val.b{color:var(--blue)}.stat-val.p{color:var(--purple)}
.stat-sub{font-size:10px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:6px}

/* PREDICTION */
.pred-bar{background:linear-gradient(135deg,var(--bg-2) 0%,var(--bg-1) 100%);border:1px solid var(--border-1);border-radius:12px;padding:14px 20px;margin-bottom:24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.recovery-guide{background:linear-gradient(135deg,rgba(34,197,94,0.04) 0%,rgba(16,185,129,0.02) 100%);border:1px solid rgba(34,197,94,0.18);border-radius:12px;padding:20px 24px;margin-bottom:20px;display:none}
.recovery-guide.visible{display:block}
.recovery-guide-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:12px}
.recovery-guide-title{font-size:13px;font-weight:700;color:#22c55e;font-family:'IBM Plex Mono',monospace;letter-spacing:0.04em;display:flex;align-items:center;gap:8px}
.recovery-guide-stat{font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.15);border-radius:20px;padding:3px 10px}
.recovery-guide-intro{font-size:13px;color:var(--text-2);line-height:1.6;margin-bottom:16px}
.recovery-guide-intro strong{color:var(--text-1)}
.recovery-steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.recovery-step{background:rgba(255,255,255,0.02);border:1px solid var(--border-1);border-radius:8px;padding:12px 14px}
.recovery-step-icon{font-size:16px;margin-bottom:6px}
.recovery-step-title{font-size:12px;font-weight:600;color:var(--text-1);margin-bottom:4px}
.recovery-step-desc{font-size:11px;color:var(--text-3);line-height:1.5}
.recovery-guide-toggle{background:none;border:none;font-size:11px;color:var(--text-3);cursor:pointer;font-family:'IBM Plex Mono',monospace;padding:0;display:flex;align-items:center;gap:4px}
.recovery-guide-toggle:hover{color:var(--text-2)}
.recovery-guide-body{transition:opacity 0.2s}
.recovery-guide.collapsed .recovery-guide-body{display:none}
.recovery-guide.collapsed #rg-chevron{transform:rotate(180deg)}
/* Coin-level recovery detail rows */
tbody tr.mon-clickable{cursor:pointer}
tbody tr.mon-clickable:hover{background:rgba(34,197,94,0.05)!important;border-left:2px solid rgba(34,197,94,0.4)!important}
tbody tr.mon-clickable.expanded{background:rgba(34,197,94,0.05)!important;border-left:2px solid rgba(34,197,94,0.5)!important}
.coin-detail-row td{padding:0!important;border:none!important}
.coin-detail-panel{background:linear-gradient(180deg,rgba(34,197,94,0.05) 0%,transparent 100%);border-bottom:1px solid rgba(34,197,94,0.12);padding:14px 20px 18px 20px}
.cdr-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.cdr-title{font-size:11px;font-family:'IBM Plex Mono',monospace;color:#22c55e;font-weight:600;letter-spacing:0.04em}
.cdr-hint{font-size:10px;font-family:'IBM Plex Mono',monospace;color:var(--text-3)}
.cdr-close{background:none;border:none;font-size:10px;color:var(--text-3);cursor:pointer;font-family:'IBM Plex Mono',monospace;padding:0;margin-left:12px}
.cdr-close:hover{color:var(--text-1)}
.cdr-items{display:flex;gap:8px;flex-wrap:wrap}
.cdr-item{flex:1;min-width:170px;max-width:270px;background:rgba(255,255,255,0.025);border:1px solid var(--border-1);border-radius:8px;padding:10px 12px}
.cdr-item.urgent{border-color:rgba(239,68,68,0.3);background:rgba(239,68,68,0.05)}
.cdr-item.good{border-color:rgba(34,197,94,0.2);background:rgba(34,197,94,0.04)}
.cdr-item-title{font-size:11px;font-weight:600;color:var(--text-1);margin-bottom:3px}
.cdr-item.urgent .cdr-item-title{color:#f87171}
.cdr-item.good .cdr-item-title{color:#4ade80}
.cdr-item-desc{font-size:10.5px;color:var(--text-3);line-height:1.5}
.cdr-footer{font-size:10px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:12px;padding-top:10px;border-top:1px solid var(--border-1)}
.pred-bar .pred-label{font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);text-transform:uppercase;letter-spacing:0.08em;font-weight:500}
.pred-bar .pred-val{font-size:13px;font-weight:600;color:var(--cyan);font-family:'IBM Plex Mono',monospace}
.pred-bar .pred-sep{width:1px;height:20px;background:var(--border-1)}

/* FILTERS */
.filters{display:flex;align-items:center;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.ftab{padding:7px 16px;border-radius:20px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.2s;border:1px solid var(--border-1);background:transparent;color:var(--text-2);font-family:'Inter',sans-serif;white-space:nowrap;min-height:36px}
.ftab:hover{background:var(--bg-3);border-color:var(--border-2);color:var(--text-1);transform:translateY(-1px)}
.ftab.active{background:var(--text-1);color:var(--bg-0);border-color:var(--text-1);font-weight:600}
.ftab .cnt{font-family:'IBM Plex Mono',monospace;font-size:10px;margin-left:4px;opacity:0.6}
.search{margin-left:auto;background:rgba(255,255,255,0.04);border:1px solid var(--border-2);border-radius:8px;padding:0 14px;color:var(--text-1);font-family:'IBM Plex Mono',monospace;font-size:12px;width:200px;outline:none;transition:all 0.2s;height:36px}
.search::placeholder{color:var(--text-3)}
.search:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(59,130,246,0.15);background:rgba(255,255,255,0.06)}

/* TABLE */
.tbl-wrap{background:var(--bg-1);border:1px solid var(--border-1);border-radius:14px;overflow-x:auto;box-shadow:0 4px 24px rgba(0,0,0,0.4)}
table{width:100%;border-collapse:collapse;min-width:1200px}
thead{background:rgba(255,255,255,0.02)}
th{padding:12px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-weight:600;border-bottom:1px solid var(--border-1);white-space:nowrap;cursor:pointer;user-select:none;transition:color 0.15s}
th:hover{color:var(--text-2)}
th.sorted{color:var(--blue)}
th[data-sort]::after{content:'';margin-left:3px;opacity:0.3;font-size:9px}
th[data-sort].sorted::after{content:' ▼';opacity:1}
th[data-sort].sorted.asc-dir::after{content:' ▲';opacity:1}
td{padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px;vertical-align:middle}
tr{transition:background 0.15s,border-left 0.15s}
tbody tr:nth-child(even){background:rgba(255,255,255,0.012)}
tbody tr:hover{background:rgba(255,255,255,0.025);border-left:2px solid rgba(59,130,246,0.4)}
tbody tr:hover td:first-child{padding-left:12px}
tbody tr:last-child td{border-bottom:none}
tbody tr.delisting-row{background:rgba(239,68,68,0.04)}
tbody tr.delisted-row{opacity:0.4}
tbody tr.restored-row{background:rgba(34,197,94,0.04)}
tbody tr.highrisk-row{background:rgba(239,68,68,0.03)}
tbody tr.limit-row{background:rgba(245,158,11,0.04)}

/* CELLS */
.tk{display:flex;align-items:center;gap:10px}
.tk-ico{width:28px;height:28px;border-radius:50%;background:var(--bg-3);border:1px solid var(--border-2);display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;color:var(--text-2);flex-shrink:0;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,0.05);position:relative}
.tk-ico img{width:28px;height:28px;border-radius:50%;object-fit:cover;display:block}
.coin-letter-icon{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--bg-4),var(--bg-3));border:1px solid var(--border-2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text-2);font-family:'IBM Plex Mono',monospace;flex-shrink:0}
.tk-sym{font-weight:700;font-size:13px;letter-spacing:-0.2px;color:var(--text-1)}
.tk-name{font-size:10px;color:var(--text-3);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tk-links{display:flex;gap:3px;margin-top:2px;align-items:center}
.tk-links a{display:flex;align-items:center;justify-content:center;width:20px;height:20px;opacity:0.45;transition:opacity 0.15s;border-radius:3px}
.tk-links a:hover{opacity:1}
.tk-links a img{width:14px;height:14px;border-radius:2px;display:block}
.ex-icons{display:flex;gap:3px;align-items:center}
.ex-icons a{display:flex;align-items:center;justify-content:center;width:16px;height:16px;opacity:0.45;transition:opacity 0.15s;border-radius:3px}
.ex-icons a:hover{opacity:1}
.ex-icons a img{width:16px;height:16px;border-radius:3px;display:block}

.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:600;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:0.04em}
.badge.monitoring{background:var(--amber-soft);color:var(--amber);border:1px solid rgba(245,158,11,0.15)}
.badge.delisting{background:var(--red-soft);color:var(--red);border:1px solid rgba(239,68,68,0.15);animation:dpulse 2s ease-in-out infinite}
.badge.delisted{background:rgba(100,100,130,0.08);color:var(--text-3);border:1px solid rgba(100,100,130,0.1)}
.badge.restored{background:var(--green-soft);color:var(--green);border:1px solid rgba(34,197,94,0.15)}
.badge.active{background:var(--blue-soft);color:var(--blue);border:1px solid rgba(59,130,246,0.15)}
.badge.online{background:var(--green-soft);color:var(--green);border:1px solid rgba(34,197,94,0.15)}
.badge.limit{background:var(--amber-soft);color:var(--amber);border:1px solid rgba(245,158,11,0.15)}
.badge.new-tag{background:var(--purple-soft);color:var(--purple);border:1px solid rgba(167,139,250,0.2);animation:dpulse 2s ease-in-out infinite}
@keyframes dpulse{0%,100%{box-shadow:none}50%{box-shadow:0 0 8px rgba(239,68,68,0.12)}}
.bdot{width:4px;height:4px;border-radius:50%}
.bdot.a{background:var(--amber)}.bdot.r{background:var(--red);animation:blink 1s ease-in-out infinite}.bdot.g{background:var(--green)}

.dt{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-2)}
.dt .cd{font-size:10px;color:var(--red);margin-top:1px}
.dt .na,.na{color:var(--text-3)}
.dt .past{color:var(--text-3);text-decoration:line-through}

.days-ref{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600}
.days-ref.over{color:var(--red)}
.days-ref.near{color:var(--amber)}
.days-ref.ok{color:var(--green)}

.vol{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-2)}
.pct{font-size:11px}.pct.up{color:var(--green)}.pct.dn{color:var(--red)}
.mcap{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-2)}
.depth{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3)}

/* RISK SCORE */
.risk-score{display:inline-flex;align-items:center;gap:5px;font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px}
.risk-score.safe{background:var(--green-soft);color:var(--green);border:1px solid rgba(34,197,94,0.15)}
.risk-score.low{background:rgba(34,197,94,0.06);color:#6ee7b7;border:1px solid rgba(34,197,94,0.1)}
.risk-score.medium{background:var(--amber-soft);color:var(--amber);border:1px solid rgba(245,158,11,0.15)}
.risk-score.high{background:rgba(239,68,68,0.08);color:#f87171;border:1px solid rgba(239,68,68,0.12)}
.risk-score.critical{background:var(--red-soft);color:var(--red);border:1px solid rgba(239,68,68,0.2)}
.risk-bar{width:40px;height:4px;background:var(--bg-4);border-radius:2px;overflow:hidden;display:inline-block;vertical-align:middle}
.risk-fill{height:100%;border-radius:2px;transition:width 0.3s}

.lnk{color:var(--blue);text-decoration:none;font-size:11px;font-family:'IBM Plex Mono',monospace;display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:4px;border:1px solid rgba(59,130,246,0.15);background:rgba(59,130,246,0.04);transition:all 0.15s;white-space:nowrap}
.lnk:hover{background:rgba(59,130,246,0.08);border-color:rgba(59,130,246,0.3)}

/* TIMELINE */
.timeline-section{margin-top:40px}
.sec-title{font-size:16px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px;color:var(--text-1);letter-spacing:-0.3px}
.timeline{display:flex;gap:12px;overflow-x:auto;padding-bottom:12px;scrollbar-width:thin;scrollbar-color:var(--border-2) transparent}
.tcard{flex-shrink:0;background:linear-gradient(135deg,var(--bg-2) 0%,var(--bg-1) 100%);border:1px solid var(--border-1);border-radius:12px;padding:18px;min-width:240px;transition:all 0.2s cubic-bezier(0.16,1,0.3,1)}
.tcard:hover{border-color:var(--border-2);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.4)}
.tcard.urgent{border-color:rgba(239,68,68,0.2);background:linear-gradient(135deg,var(--bg-2),rgba(239,68,68,0.03))}
.tcard .tdate{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:var(--amber);margin-bottom:6px}
.tcard.urgent .tdate{color:var(--red)}
.tcard .tevt{font-size:13px;font-weight:500;margin-bottom:8px;line-height:1.4;color:var(--text-1)}
.ttokens{display:flex;flex-wrap:wrap;gap:4px}
.ttk{font-family:'IBM Plex Mono',monospace;font-size:10px;padding:2px 7px;border-radius:20px;background:var(--bg-0);border:1px solid var(--border-1);color:var(--text-2)}

/* FOOTER */
.footer{margin-top:48px;text-align:center;font-size:12px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;padding:28px 0;border-top:1px solid var(--border-1);background:linear-gradient(to bottom,transparent,rgba(2,4,8,0.5))}
.footer a{color:var(--text-2);text-decoration:none;transition:color 0.15s}
.footer a:hover{color:var(--blue);text-decoration:underline}

/* COOKIE CONSENT */
.cookie-bar{position:fixed;bottom:0;left:0;right:0;z-index:1000;background:rgba(8,12,20,0.97);border-top:1px solid var(--border-2);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);transition:transform 0.35s cubic-bezier(0.16,1,0.3,1)}
.cookie-bar.hidden{transform:translateY(100%);pointer-events:none}
.cookie-bar-inner{max-width:1700px;margin:0 auto;width:100%;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.cookie-bar-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.cookie-bar-text{font-size:11px;color:var(--text-2);font-family:'IBM Plex Mono',monospace;line-height:1.6}
.cookie-bar-text a{color:var(--blue);text-decoration:none}
.cookie-bar-text a:hover{text-decoration:underline}
.cookie-bar-actions{display:flex;gap:8px;flex-shrink:0}
.cookie-btn{padding:8px 18px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;font-family:'IBM Plex Mono',monospace;transition:all 0.2s;border:1px solid transparent;min-height:36px}
.cookie-btn.accept{background:var(--blue);color:#fff;border-color:var(--blue)}
.cookie-btn.accept:hover{background:#2563eb;transform:translateY(-1px);box-shadow:0 4px 12px rgba(59,130,246,0.3)}
.cookie-btn.decline{background:transparent;color:var(--text-3);border-color:var(--border-2)}
.cookie-btn.decline:hover{color:var(--text-2);border-color:var(--border-3)}

/* PAGINATION */
.pagination{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:16px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-3)}
.pagination button{background:var(--bg-3);border:1px solid var(--border-1);color:var(--text-2);padding:5px 12px;border-radius:5px;cursor:pointer;font-family:'IBM Plex Mono',monospace;font-size:11px;transition:all 0.15s}
.pagination button:hover{background:var(--bg-4)}
.pagination button:disabled{opacity:0.3;cursor:not-allowed}
.pagination .pg-info{color:var(--text-3)}

/* Loading */
.loading-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:var(--bg-0);display:flex;align-items:center;justify-content:center;z-index:100;transition:opacity 0.4s}
.loading-overlay.hidden{opacity:0;pointer-events:none;visibility:hidden}
.loader{text-align:center;padding:32px}
.loader .lname{font-size:28px;font-weight:800;letter-spacing:-1px;margin-bottom:24px;color:var(--text-1)}
.loader .lname span{color:var(--amber)}
.loader .spinner{width:36px;height:36px;border:2px solid var(--border-2);border-top-color:var(--amber);border-radius:50%;animation:spin 0.7s linear infinite;margin:0 auto 16px}
.loader .ltxt{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3);margin-bottom:20px}
.loader .lprog{width:200px;height:2px;background:var(--border-1);border-radius:1px;margin:0 auto;overflow:hidden}
.loader .lprog-fill{height:100%;width:0%;background:var(--amber);border-radius:1px;transition:width 0.5s ease}

@media(max-width:900px){.wrap{padding:16px 14px}.hdr{flex-direction:column}.search{width:100%;margin-left:0}.stats{grid-template-columns:repeat(2,1fr)}}
@media(max-width:640px){
  .tnav-name{display:none}
  .tnav-divider{display:none}
  .tnav-tab{padding:6px 10px;font-size:12px;flex-shrink:0;gap:5px}
  .topnav-inner{padding:0 10px;height:50px}
  .tnav-right{margin-left:4px}
  .live{padding:4px 8px;font-size:10px;gap:4px}
  .live-dot{width:5px;height:5px}
  .stats{grid-template-columns:repeat(2,1fr);gap:8px}
  .stat{padding:14px 16px}
  .stat-val{font-size:24px}
  .filters{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:4px}
  .filters::-webkit-scrollbar{display:none}
  .ftab{flex-shrink:0;padding:5px 12px;font-size:11px}
  .search{min-width:140px;font-size:11px}
  .hdr h1{font-size:18px}
  .hdr .sub{font-size:11px}
  .pred-bar{padding:10px 14px;gap:10px}
  .pred-bar .pred-label{font-size:10px}
  .pred-bar .pred-val{font-size:12px}
  .cookie-bar{padding:12px 14px}
  .cookie-bar-inner{flex-direction:column;align-items:flex-start;gap:10px}
  .cookie-bar-actions{align-self:flex-end}
  .col-days,.col-mon,.col-vol,.col-mcap,.col-bid,.col-ask,.col-also{display:none}
  table{min-width:360px}
  td,th{padding:10px 10px}
  .tk-ico{width:24px;height:24px}
  .tk-ico img{width:24px;height:24px}
  .coin-letter-icon{width:24px;height:24px;font-size:10px}
  .tk-sym{font-size:12px}
  .tk-name{font-size:9px;max-width:80px}
}
@media(max-width:440px){
  .tnav-tab{font-size:0;padding:7px 9px;gap:0}
  .tnav-tab svg{display:block;width:16px;height:16px}
  .topnav-inner{padding:0 8px}
}
@media(max-width:480px){.stats{grid-template-columns:1fr}}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:var(--bg-1)}::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:3px}::-webkit-scrollbar-thumb:hover{background:var(--text-3)}

/* SHIMMER LOADING */
@keyframes shimmer{0%{background-position:-800px 0}100%{background-position:800px 0}}
.shimmer-row td{background:linear-gradient(90deg,var(--bg-2) 25%,var(--bg-3) 50%,var(--bg-2) 75%);background-size:800px 100%;animation:shimmer 1.5s infinite;color:transparent!important;border-radius:4px}
.shimmer-row td *{opacity:0}

/* TOP NAV */
.topnav{position:sticky;top:0;z-index:200;background:rgba(2,4,8,0.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.07);box-shadow:0 1px 0 rgba(255,255,255,0.03)}
.topnav-inner{max-width:1700px;margin:0 auto;padding:0 24px;height:56px;display:flex;align-items:center;gap:0}
.tnav-brand{display:flex;align-items:center;gap:10px;flex-shrink:0;text-decoration:none}
.tnav-logo{width:32px;height:32px;background:linear-gradient(135deg,#f59e0b,#ea580c);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;font-family:'IBM Plex Mono',monospace;font-weight:800;box-shadow:0 2px 8px rgba(245,158,11,0.3)}
.tnav-name{font-size:14px;font-weight:700;letter-spacing:-0.3px;color:var(--text-2)}
.tnav-divider{width:1px;height:20px;background:var(--border-1);margin:0 16px;flex-shrink:0}
.tnav-scroll{flex:1;overflow-x:auto;scrollbar-width:none}
.tnav-scroll::-webkit-scrollbar{display:none}
.tnav-tabs{display:flex;align-items:center;gap:2px;flex-shrink:0;white-space:nowrap;padding:0 4px}
.tnav-tab{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.18s;border:1px solid transparent;background:transparent;color:var(--text-3);font-family:'Inter',sans-serif;letter-spacing:-0.2px;text-decoration:none;flex-shrink:0;position:relative}
.tnav-tab:hover{background:var(--bg-3);color:var(--text-2)}
.tnav-tab.active{color:var(--text-1)}
.tnav-tab.active.binance{background:rgba(240,185,11,0.08);color:#F0B90B;border-color:rgba(240,185,11,0.15)}
.tnav-tab.active.binance::after{content:'';position:absolute;bottom:-1px;left:16px;right:16px;height:2px;background:#F0B90B;border-radius:2px 2px 0 0}
.tnav-tab.active.coinbase{background:rgba(0,82,255,0.08);color:#6b9fff;border-color:rgba(0,82,255,0.15)}
.tnav-tab.active.coinbase::after{content:'';position:absolute;bottom:-1px;left:16px;right:16px;height:2px;background:#6b9fff;border-radius:2px 2px 0 0}
.tnav-tab.stablecoins{color:var(--text-3)}
.tnav-tab.stablecoins:hover{background:rgba(34,197,94,0.07);color:#22c55e}
.tnav-right{display:flex;align-items:center;gap:12px;flex-shrink:0;min-width:fit-content;margin-left:8px}
/* EXCHANGE SECTIONS */
.ex-section{display:none}
.ex-section.active{display:block}

/* STABLECOIN MODULE */
.tk-chains{font-size:9px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:2px}
.chain-icons{display:flex;gap:3px;align-items:center;flex-wrap:nowrap}
.chain-ico{width:18px;height:18px;border-radius:50%;overflow:hidden;flex-shrink:0;background:var(--bg-3);border:1px solid var(--border-1);display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:700;color:var(--text-3);text-decoration:none;transition:transform 0.15s,border-color 0.15s}
.chain-ico:hover{transform:scale(1.15);border-color:var(--border-2)}
.chain-ico img{width:18px;height:18px;border-radius:50%;display:block}
.chain-more{font-size:9px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;white-space:nowrap;margin-left:1px}
.ex-badges{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.ex-icon-link{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:5px;border:1px solid var(--border-1);background:var(--bg-3);transition:all 0.15s;text-decoration:none;overflow:hidden;flex-shrink:0}
.ex-icon-link:hover{border-color:var(--border-2);transform:scale(1.1)}
.ex-icon-link img{width:16px;height:16px;border-radius:2px;display:block}
.mech{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:600;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:0.04em}
.mech.fiat{background:var(--blue-soft);color:var(--blue);border:1px solid rgba(59,130,246,0.15)}
.mech.cdp{background:var(--purple-soft);color:var(--purple);border:1px solid rgba(167,139,250,0.15)}
.mech.algo{background:var(--amber-soft);color:var(--amber);border:1px solid rgba(245,158,11,0.15)}
.mech.rwa{background:var(--cyan-soft);color:var(--cyan);border:1px solid rgba(6,182,212,0.15)}
.mech.unknown{background:rgba(93,97,120,0.12);color:var(--text-3);border:1px solid rgba(93,97,120,0.15)}
.price-cell{font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600}
.price-cell.g{color:var(--green)}.price-cell.a{color:var(--amber)}.price-cell.r{color:var(--red)}
.peg-delta{font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:700;letter-spacing:-0.2px}
.peg-delta.g{color:var(--green)}.peg-delta.a{color:var(--amber)}.peg-delta.r{color:var(--red)}
.chain-count{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-2)}
.rank-num{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3);font-weight:500}
.empty-state{padding:48px;text-align:center;color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-size:13px}
.tnav-tab.active.stablecoins{background:rgba(34,197,94,0.08);color:#22c55e;border-color:rgba(34,197,94,0.15)}
.tnav-tab.active.stablecoins::after{content:'';position:absolute;bottom:-1px;left:16px;right:16px;height:2px;background:#22c55e;border-radius:2px 2px 0 0}
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      "@id": "https://shitcoin.io/#app",
      "name": "shitcoin.io — Crypto Delisting Monitor",
      "url": "https://shitcoin.io/",
      "description": "Real-time monitoring dashboard tracking Binance and Coinbase coins under delisting watch, with algorithmic risk scores, order book depth, market cap data, and cross-exchange presence.",
      "applicationCategory": "FinanceApplication",
      "operatingSystem": "Web",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
      "featureList": [
        "Real-time Binance delisting risk scores",
        "Coinbase delisting risk scores",
        "Order book depth analysis",
        "Market cap tracking",
        "Cross-exchange presence (OKX, Kraken)",
        "Stablecoin peg health monitoring"
      ]
    },
    {
      "@type": "FAQPage",
      "@id": "https://shitcoin.io/#faq",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is shitcoin.io?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "shitcoin.io is a free real-time monitoring dashboard that tracks cryptocurrencies listed on Binance and Coinbase that show signs of potential delisting. It displays risk scores, order book depth, 24-hour volume, market cap, and cross-exchange presence data."
          }
        },
        {
          "@type": "Question",
          "name": "How are delisting risk scores calculated?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Risk scores are algorithmic calculations based on publicly available data including trading volume trends, order book depth, market cap, exchange monitoring tags, and cross-exchange availability. They are not financial advice."
          }
        },
        {
          "@type": "Question",
          "name": "Which exchanges does shitcoin.io monitor?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "shitcoin.io primarily monitors Binance and Coinbase for delisting risk. It also shows cross-exchange presence data from OKX and Kraken to assess coin liquidity health."
          }
        },
        {
          "@type": "Question",
          "name": "How often is data updated?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Market data (prices, volume, order book depth) is refreshed every 2 minutes. Exchange info and coin lists are cached for up to 15 minutes. CoinGecko market cap data is cached for 5 minutes."
          }
        }
      ]
    }
  ]
}
</script>
</head>
<body>

<!-- TOP NAV -->
<nav class="topnav">
    <div class="topnav-inner">
        <div class="tnav-brand">
            <div class="tnav-logo">⚡</div>
            <span class="tnav-name">Crypto Monitor</span>
        </div>
        <div class="tnav-divider"></div>
        <div class="tnav-scroll">
            <div class="tnav-tabs">
                <button class="tnav-tab binance active" id="ex-tab-binance" onclick="switchExchange('binance')">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path fill="#F0B90B" d="M7 1 4.8 3.2 7 5.4 9.2 3.2z"/><path fill="#F0B90B" d="M1 7 3.2 4.8 5.4 7 3.2 9.2z"/><path fill="#F0B90B" d="M13 7 10.8 4.8 8.6 7 10.8 9.2z"/><path fill="#F0B90B" d="M7 8.6 4.8 10.8 7 13 9.2 10.8z"/><path fill="#F0B90B" d="M7 4.8 5.1 6.7 7 8.6 8.9 6.7z"/></svg>
                    Binance
                </button>
                <button class="tnav-tab coinbase" id="ex-tab-coinbase" onclick="switchExchange('coinbase')">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect width="14" height="14" rx="3.5" fill="#0052FF"/><circle cx="7" cy="7" r="3.5" fill="#0052FF"/><circle cx="7" cy="7" r="3.5" stroke="white" stroke-width="1.5" fill="none"/><rect x="3.5" y="5.9" width="7" height="2.2" fill="#0052FF"/></svg>
                    Coinbase
                </button>
                <a class="tnav-tab stablecoins" id="ex-tab-stablecoins" href="https://stablecoin.io">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" stroke="#22c55e" stroke-width="1"/><text x="7" y="10.5" text-anchor="middle" font-size="8" font-weight="700" fill="#22c55e" font-family="IBM Plex Mono,monospace">$</text></svg>
                    Stablecoins
                </a>
            </div>
        </div>
        <div class="tnav-right">
            <div class="live" id="tnav-live" style="display:none"><span class="live-dot"></span>LIVE</div>
        </div>
    </div>
</nav>

<!-- BINANCE SECTION -->
<div class="ex-section active" id="bn-section">
<div class="loading-overlay" id="bn-loader"><div class="loader"><div class="lname">⚡ <span>Binance</span> Monitor</div><div class="spinner"></div><div class="ltxt" id="bn-ltxt">Connecting to Binance...</div><div class="lprog"><div class="lprog-fill" id="bn-lprog"></div></div></div></div>
<div class="wrap">
<div class="hdr">
    <div class="hdr-left">
        <div>
            <h1>Binance Monitor</h1>
            <div class="sub mono">risk scores · monitoring tags · delistings · all coins</div>
        </div>
    </div>
    <div class="hdr-right">
        <span class="meta-text" id="bn-updTime">loading...</span>
        <span class="meta-text" id="bn-refreshTimer"></span>
        <button class="btn" id="bn-refreshBtn" onclick="bnDoRefresh()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            refresh
        </button>
    </div>
</div>
<div class="stats" id="bn-stats"></div>
<div class="pred-bar" id="bn-predBar"></div>
<div class="filters" id="bn-filters"></div>
<div class="recovery-guide" id="bn-recovery-guide">
  <div class="recovery-guide-header">
    <div class="recovery-guide-title">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      Recovery Playbook — How Monitored Coins Get Restored
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <div class="recovery-guide-stat" id="bn-restore-rate">loading…</div>
      <button class="recovery-guide-toggle" onclick="document.getElementById('bn-recovery-guide').classList.toggle('collapsed')">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" id="rg-chevron"><polyline points="18 15 12 9 6 15"/></svg>
        collapse
      </button>
    </div>
  </div>
  <div class="recovery-guide-body">
    <div class="recovery-guide-intro">
      Monitoring status is a warning, not a verdict. Binance reviews tagged coins regularly — <strong>projects that demonstrate improving fundamentals have gotten restored</strong>. Here's what the data shows matters most:
    </div>
    <div class="recovery-steps">
      <div class="recovery-step">
        <div class="recovery-step-icon">📈</div>
        <div class="recovery-step-title">Grow trading volume</div>
        <div class="recovery-step-desc">Sustain consistent daily volume above $500K–$1M USDT. Sudden spikes don't count — Binance looks for sustained organic growth over weeks.</div>
      </div>
      <div class="recovery-step">
        <div class="recovery-step-icon">💧</div>
        <div class="recovery-step-title">Improve liquidity depth</div>
        <div class="recovery-step-desc">Engage market makers to tighten spreads and deepen order book. Bid/ask depth within 2% of price is a key signal this monitor tracks.</div>
      </div>
      <div class="recovery-step">
        <div class="recovery-step-icon">🌐</div>
        <div class="recovery-step-title">List on more exchanges</div>
        <div class="recovery-step-desc">Cross-listings on OKX, Kraken, or Coinbase demonstrate market demand beyond a single venue. Multi-exchange presence reduces delisting risk.</div>
      </div>
      <div class="recovery-step">
        <div class="recovery-step-icon">⛓</div>
        <div class="recovery-step-title">Show on-chain activity</div>
        <div class="recovery-step-desc">Growing active addresses, transaction counts, TVL, or protocol usage show real utility beyond speculation.</div>
      </div>
      <div class="recovery-step">
        <div class="recovery-step-icon">📣</div>
        <div class="recovery-step-title">Maintain community health</div>
        <div class="recovery-step-desc">Regular project updates, active social channels, GitHub commits, and roadmap progress signal a live team. Dead comms is a red flag.</div>
      </div>
      <div class="recovery-step">
        <div class="recovery-step-icon">📬</div>
        <div class="recovery-step-title">Engage the exchange</div>
        <div class="recovery-step-desc">Respond promptly to any exchange communications. Proactively submit evidence of improvements — exchanges do review appeals and project submissions.</div>
      </div>
    </div>
  </div>
</div>
<div class="tbl-wrap">
    <table>
        <thead><tr>
            <th data-sort="symbol" onclick="bnSortBy('symbol')">Token</th>
            <th data-sort="status" onclick="bnSortBy('status')">Status</th>
            <th data-sort="risk" onclick="bnSortBy('risk')" title="Risk score: volume + mcap + depth + status">Risk</th>
            <th class="col-days" data-sort="daysOnMon" onclick="bnSortBy('daysOnMon')" title="Days since monitoring tag added">Days</th>
            <th class="col-mon" data-sort="monDate" onclick="bnSortBy('monDate')">Mon. Added</th>
            <th data-sort="delistDate" onclick="bnSortBy('delistDate')">Delist Date</th>
            <th data-sort="price" onclick="bnSortBy('price')">Price</th>
            <th data-sort="change" onclick="bnSortBy('change')">24h %</th>
            <th class="col-vol" data-sort="vol" onclick="bnSortBy('vol')">24h Vol</th>
            <th class="col-mcap" data-sort="mcap" onclick="bnSortBy('mcap')">Mkt Cap</th>
            <th class="col-bid" data-sort="bidDepth" onclick="bnSortBy('bidDepth')" title="Bid depth within 2% below price">Bid -2%</th>
            <th class="col-ask" data-sort="askDepth" onclick="bnSortBy('askDepth')" title="Ask depth within 2% above price">Ask +2%</th>
            <th class="col-also" title="Also listed on other exchanges">Also On</th>
        </tr></thead>
        <tbody id="bn-tbody"></tbody>
    </table>
</div>
<div class="pagination" id="bn-pagination"></div>
<div class="timeline-section" id="timelineSection">
    <div class="sec-title">📅 Upcoming Events</div>
    <div class="timeline" id="bn-timeline"></div>
</div>
<div class="footer">
  Data from Binance API + CoinGecko · Risk scores based on historical delisting patterns · Auto-refresh every 5 min<br>
  Monitoring tag program started 2023-07-26 · <span id="bn-tokenCount"></span> tokens tracked<br><br>
  <strong style="color:var(--amber)">⚠ Not financial advice.</strong> Data is for informational purposes only. Always do your own research.<br><br>
  <a href="/terms">Terms of Use</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="https://stablecoin.io">Stablecoin Monitor</a><br><br>
  Maintained by <a href="https://mdt.io" target="_blank" rel="noopener">Measurable Data Token</a>
</div>
</div>

</div>

<!-- COINBASE SECTION -->
<div class="ex-section" id="cb-section">
<div class="loading-overlay" id="cb-loader" style="display:none"><div class="loader"><div class="lname">CB <span>Coinbase</span> Monitor</div><div class="spinner"></div><div class="ltxt" id="cb-ltxt">Connecting to Coinbase...</div><div class="lprog"><div class="lprog-fill" id="cb-lprog"></div></div></div></div>
<div class="wrap">
<div class="hdr">
    <div class="hdr-left">
        <div>
            <h1>Coinbase Monitor</h1>
            <div class="sub mono">risk scores · trading status · delistings · all coins</div>
        </div>
    </div>
    <div class="hdr-right">
        <span class="meta-text" id="cb-updTime">loading...</span>
        <span class="meta-text" id="cb-refreshTimer"></span>
        <button class="btn" id="cb-refreshBtn" onclick="cbDoRefresh()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            refresh
        </button>
    </div>
</div>
<div class="stats" id="cb-statsBar">
    <div class="stat g"><div class="stat-label">Online</div><div class="stat-val g" id="cb-sOnline">-</div><div class="stat-sub">trading on Coinbase</div></div>
    <div class="stat a"><div class="stat-label">Limit Only</div><div class="stat-val a" id="cb-sLimit">-</div><div class="stat-sub">post-only mode</div></div>
    <div class="stat r"><div class="stat-label">Delisted</div><div class="stat-val r" id="cb-sDelisted">-</div><div class="stat-sub">removed from trading</div></div>
    <div class="stat b"><div class="stat-label">Total Tracked</div><div class="stat-val b" id="cb-sTotal">-</div><div class="stat-sub">in our database</div></div>
    <div class="stat r"><div class="stat-label">High Risk</div><div class="stat-val r" id="cb-sHighRisk">-</div><div class="stat-sub">risk score ≥ 50</div></div>
    <div class="stat p"><div class="stat-label">Active Pairs</div><div class="stat-val p" id="cb-sPairs">-</div><div class="stat-sub">USD trading pairs</div></div>
</div>
<div class="filters">
    <button class="ftab active" data-f="all" onclick="cbSetFilter('all')">📋 All <span class="cnt" id="cb-cAll"></span></button>
    <button class="ftab" data-f="online" onclick="cbSetFilter('online')">🟢 Online <span class="cnt" id="cb-cOnline"></span></button>
    <button class="ftab" data-f="limit" onclick="cbSetFilter('limit')">⚠ Limit Only <span class="cnt" id="cb-cLimit"></span></button>
    <button class="ftab" data-f="delisted" onclick="cbSetFilter('delisted')">⬛ Delisted <span class="cnt" id="cb-cDelisted"></span></button>
    <button class="ftab" data-f="highrisk" onclick="cbSetFilter('highrisk')">🔴 High Risk <span class="cnt" id="cb-cHighRisk"></span></button>
    <input class="search" type="text" placeholder="Search coins... ( / )" id="cb-searchInput" oninput="cbSetQuery(this.value)">
</div>
<div class="tbl-wrap">
<table>
<thead><tr>
    <th data-sort="symbol" onclick="cbSortBy('symbol')">Token</th>
    <th data-sort="status" onclick="cbSortBy('status')">Status</th>
    <th data-sort="risk" onclick="cbSortBy('risk')" title="Risk score based on volume, mcap, exchange support">Risk</th>
    <th data-sort="price" onclick="cbSortBy('price')">Price</th>
    <th data-sort="change" onclick="cbSortBy('change')">24h %</th>
    <th class="col-vol" data-sort="vol" onclick="cbSortBy('vol')">24h Vol</th>
    <th class="col-mcap" data-sort="mcap" onclick="cbSortBy('mcap')">Mkt Cap</th>
    <th class="col-bid" data-sort="bidDepth" onclick="cbSortBy('bidDepth')" title="Bid depth within 2% below price">Bid -2%</th>
    <th class="col-ask" data-sort="askDepth" onclick="cbSortBy('askDepth')" title="Ask depth within 2% above price">Ask +2%</th>
    <th class="col-also" title="Also listed on other exchanges">Also On</th>
</tr></thead>
<tbody id="cb-tBody"><tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-3)">Loading Coinbase data... If this persists, try hard refresh (Ctrl+Shift+R)</td></tr></tbody>
</table>
</div>
<div class="pagination" id="cb-pagination"></div>
<div class="footer">
  Data from Coinbase Exchange API + CoinGecko · Risk scores based on trading status and volume patterns<br>
  <span id="cb-tokenCount"></span><br><br>
  <strong style="color:var(--amber)">⚠ Not financial advice.</strong> Data is for informational purposes only. Always do your own research.<br><br>
  <a href="/terms">Terms of Use</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="https://stablecoin.io">Stablecoin Monitor</a><br><br>
  Maintained by <a href="https://mdt.io" target="_blank" rel="noopener">Measurable Data Token</a>
</div>
</div>
</div>

<!-- STABLECOIN SECTION -->
<div class="ex-section" id="sc-section">
<div class="loading-overlay hidden" id="sc-loader">
  <div class="loader">
    <div class="lname">💲 <span>Stablecoin</span> Monitor</div>
    <div class="spinner" style="border-top-color:var(--green)"></div>
    <div class="ltxt" id="sc-ltxt">Fetching peg data...</div>
    <div class="lprog"><div class="lprog-fill" id="sc-lprog" style="background:var(--green)"></div></div>
  </div>
</div>
<div class="wrap">
  <div class="hdr">
    <div class="hdr-left">
      <div>
        <h1>Stablecoin Monitor</h1>
        <div class="sub mono">peg health · risk scores · market caps · mechanism analysis</div>
      </div>
    </div>
    <div class="hdr-right">
      <span class="meta-text" id="sc-updTime"></span>
      <span class="meta-text" id="sc-refreshTimer"></span>
      <button class="btn" id="sc-refreshBtn" onclick="scDoRefresh()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        refresh
      </button>
    </div>
  </div>
  <div class="stats" id="sc-stats">
    <div class="stat b"><div class="stat-label">Total Market Cap</div><div class="stat-val b">—</div><div class="stat-sub">all tracked stablecoins</div></div>
    <div class="stat g"><div class="stat-label">At Peg</div><div class="stat-val g">—</div><div class="stat-sub">within 0.5% of $1.00</div></div>
    <div class="stat a"><div class="stat-label">At Risk</div><div class="stat-val a">—</div><div class="stat-sub">0.5% – 2% deviation</div></div>
    <div class="stat r"><div class="stat-label">Depegged</div><div class="stat-val r">—</div><div class="stat-sub">over 2% deviation</div></div>
    <div class="stat p"><div class="stat-label">Largest</div><div class="stat-val p">—</div><div class="stat-sub">by market cap</div></div>
    <div class="stat"><div class="stat-label">Tracked</div><div class="stat-val">—</div><div class="stat-sub">stablecoins monitored</div></div>
  </div>
  <div class="filters" id="sc-filters">
    <button class="ftab active" data-f="all" onclick="scSetFilter('all')">📋 All</button>
    <button class="ftab" data-f="pegged" onclick="scSetFilter('pegged')">✅ Pegged</button>
    <button class="ftab" data-f="atrisk" onclick="scSetFilter('atrisk')">⚠ At Risk</button>
    <button class="ftab" data-f="depegged" onclick="scSetFilter('depegged')">🚨 Depegged</button>
    <button class="ftab" data-f="fiat" onclick="scSetFilter('fiat')">🏦 Fiat</button>
    <button class="ftab" data-f="cdp" onclick="scSetFilter('cdp')">⛓ CDP</button>
    <button class="ftab" data-f="algo" onclick="scSetFilter('algo')">🤖 Algo</button>
    <input class="search" type="text" placeholder="Search stablecoins..." id="sc-search" oninput="scOnSearch(this.value)">
  </div>
  <div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th style="width:38px;cursor:default">#</th>
          <th data-sort="symbol" onclick="scSortBy('symbol')">Stablecoin</th>
          <th data-sort="mech" onclick="scSortBy('mech')">Mechanism</th>
          <th data-sort="price" onclick="scSortBy('price')">Price</th>
          <th data-sort="peg" onclick="scSortBy('peg')">Peg Δ</th>
          <th class="col-mcap" data-sort="mcap" onclick="scSortBy('mcap')">Mkt Cap</th>
          <th class="col-vol" data-sort="vol24h" onclick="scSortBy('vol24h')">24h Vol</th>
          <th class="col-chg" data-sort="change24h" onclick="scSortBy('change24h')">24h %</th>
          <th class="col-chains" data-sort="chainCount" onclick="scSortBy('chainCount')">Chains</th>
          <th class="col-exchanges">Exchanges</th>
          <th data-sort="_risk" onclick="scSortBy('_risk')">Risk</th>
        </tr>
      </thead>
      <tbody id="sc-tbody"></tbody>
    </table>
  </div>
  <div class="pagination" id="sc-pagination"></div>
  <div class="footer">
    Data from <a href="https://defillama.com" target="_blank">DeFi Llama</a> + <a href="https://coingecko.com" target="_blank">CoinGecko</a> · Risk scores based on peg deviation, mechanism, and market cap<br>
    <strong style="color:var(--amber)">⚠ Not financial advice.</strong> Stablecoin data is for informational purposes only.<br><br>
    <a href="/terms">Terms of Use</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="https://stablecoin.io">stablecoin.io</a><br><br>
    Maintained by <a href="https://mdt.io" target="_blank" rel="noopener">Measurable Data Token</a>
  </div>
</div>
</div>

<script>
// Known differences between CoinGecko IDs and CoinMarketCap slugs
const CG_TO_CMC = {
    'avalanche-2':'avalanche','hedera-hashgraph':'hedera','near':'near-protocol',
    'havven':'synthetix-network-token','binancecoin':'bnb',
    'compound-governance-token':'compound','kyber-network-crystal':'kyber-network',
    'melon':'enzyme','blockstack':'stacks','the-open-network':'toncoin',
    'artificial-superintelligence-alliance':'fetch-ai',
    'jito-governance-token':'jito','jupiter-exchange-solana':'jupiter-ag',
    'gigachad-2':'gigachad','internet-computer':'internet-computer-icp',
    'crypto-com-chain':'cronos','elrond-erd-2':'multiversx',
    'orchid-protocol':'orchid','arpa-chain':'arpa',
    'sushi':'sushiswap','pancakeswap-token':'pancakeswap',
    'injective-protocol':'injective','render-token':'render',
    'sei-network':'sei','threshold-network-token':'threshold',
    'dogwifcoin':'dogwifhat','dydx-chain':'dydx','ripple':'xrp',
    'immutable-x':'immutable','sonic-3':'sonic','story-protocol':'story',
    'flare-networks':'flare-networks','holotoken':'holotoken',
    'cosmos':'cosmos','uniswap':'uniswap','solana':'solana',
    'dai':'multi-collateral-dai','nusd':'susd',
    'magic-internet-money':'magic-internet-money',
};

// ===== BINANCE MODULE =====
let bnInitialized = false;
let bnRefreshInterval = null;
let bnTimerInterval = null;
(function() {
const NOW = new Date();
const BINANCE_API = '/api'; // Proxied through our server to avoid CORS/rate-limit issues

// ============ HISTORICAL TOKEN DATA ============
const TRACKED_TOKENS = [
  {sym:'JASMY', name:'JasmyCoin', status:'monitoring', monDate:'2023-07-26', delistDate:null, restoreDate:null},
  {sym:'FTT', name:'FTX Token', status:'monitoring', monDate:'2023-07-26', delistDate:null, restoreDate:null},
  {sym:'ARK', name:'Ark', status:'monitoring', monDate:'2023-07-26', delistDate:null, restoreDate:null},
  {sym:'ARDR', name:'Ardor', status:'monitoring', monDate:'2025-05-07', delistDate:null, restoreDate:null},
  {sym:'PERP', name:'Perpetual Protocol', status:'delisted', monDate:'2025-05-07', delistDate:'2025-11-12', restoreDate:null},
  {sym:'MBL', name:'MovieBloc', status:'monitoring', monDate:'2024-07-01', delistDate:null, restoreDate:null},
  {sym:'AWE', name:'AWE Network', status:'monitoring', monDate:'2025-04-03', delistDate:null, restoreDate:null},
  {sym:'MOVE', name:'Movement', status:'monitoring', monDate:'2025-06-05', delistDate:null, restoreDate:null},
  {sym:'BIFI', name:'Beefy Finance', status:'monitoring', monDate:'2025-06-05', delistDate:null, restoreDate:null},
  {sym:'MDT', name:'Measurable Data', status:'monitoring', monDate:'2025-06-05', delistDate:null, restoreDate:null, resources:[{label:'Transparency Portal', url:'https://mdt.io/transparency', note:'Public on-chain metrics & project health reporting — exactly what exchanges want to see'}]},
  {sym:'PORTAL', name:'Portal', status:'monitoring', monDate:'2025-06-05', delistDate:null, restoreDate:null},
  {sym:'WAN', name:'Wanchain', status:'monitoring', monDate:'2025-10-09', delistDate:null, restoreDate:null},
  {sym:'DENT', name:'Dent', status:'monitoring', monDate:'2025-12-01', delistDate:null, restoreDate:null},
  {sym:'D', name:'DAR Open Network', status:'monitoring', monDate:'2026-01-02', delistDate:null, restoreDate:null},
  {sym:'COS', name:'Contentos', status:'monitoring', monDate:'2026-03-06', delistDate:null, restoreDate:null},
  {sym:'DEGO', name:'Dego Finance', status:'monitoring', monDate:'2026-03-06', delistDate:null, restoreDate:null},
  {sym:'FUN', name:'FUNToken', status:'monitoring', monDate:'2026-03-06', delistDate:null, restoreDate:null},
  {sym:'MBOX', name:'MOBOX', status:'monitoring', monDate:'2026-03-06', delistDate:null, restoreDate:null},
  {sym:'OXT', name:'Orchid', status:'monitoring', monDate:'2026-03-06', delistDate:null, restoreDate:null},
  {sym:'WIF', name:'dogwifhat', status:'monitoring', monDate:'2026-03-06', delistDate:null, restoreDate:null},
  {sym:'ATA', name:'Automata Network', status:'monitoring', monDate:'2026-03-13', delistDate:null, restoreDate:null},
  {sym:'FIO', name:'FIO Protocol', status:'monitoring', monDate:'2026-03-13', delistDate:null, restoreDate:null},
  {sym:'GTC', name:'Gitcoin', status:'monitoring', monDate:'2026-03-13', delistDate:null, restoreDate:null},
  {sym:'PHB', name:'Phoenix', status:'monitoring', monDate:'2026-03-13', delistDate:null, restoreDate:null},
  {sym:'QI', name:'BENQI', status:'monitoring', monDate:'2026-03-13', delistDate:null, restoreDate:null},
  {sym:'A2Z', name:'Arena-Z', status:'delisted', monDate:'2026-03-13', delistDate:'2026-04-01', restoreDate:null},
  {sym:'FORTH', name:'Ampleforth Governance', status:'delisted', monDate:'2026-03-06', delistDate:'2026-04-01', restoreDate:null},
  {sym:'HOOK', name:'Hooked Protocol', status:'delisted', monDate:'2026-03-06', delistDate:'2026-04-01', restoreDate:null},
  {sym:'IDEX', name:'IDEX', status:'delisted', monDate:'2025-06-05', delistDate:'2026-04-01', restoreDate:null},
  {sym:'LRC', name:'Loopring', status:'delisted', monDate:'2026-03-06', delistDate:'2026-04-01', restoreDate:null},
  {sym:'NTRN', name:'Neutron', status:'delisted', monDate:'2026-03-13', delistDate:'2026-04-01', restoreDate:null},
  {sym:'RDNT', name:'Radiant Capital', status:'delisted', monDate:'2026-03-13', delistDate:'2026-04-01', restoreDate:null},
  {sym:'SXP', name:'Solar', status:'delisted', monDate:'2025-12-01', delistDate:'2026-04-01', restoreDate:null},
  {sym:'BTS', name:'BitShares', status:'delisted', monDate:'2023-07-26', delistDate:'2023-12-07', restoreDate:null},
  {sym:'NBS', name:'New BitShares', status:'delisted', monDate:'2023-07-26', delistDate:'2023-12-07', restoreDate:null},
  {sym:'TORN', name:'Tornado Cash', status:'delisted', monDate:'2023-07-26', delistDate:'2023-12-07', restoreDate:null},
  {sym:'MULTI', name:'Multichain', status:'delisted', monDate:'2023-07-26', delistDate:'2024-02-06', restoreDate:null},
  {sym:'WAX', name:'WAX', status:'delisted', monDate:'2023-07-26', delistDate:'2024-02-06', restoreDate:null},
  {sym:'DREP', name:'DREP', status:'delisted', monDate:'2023-07-26', delistDate:'2024-04-03', restoreDate:null},
  {sym:'LINA', name:'Linear', status:'delisted', monDate:'2023-07-26', delistDate:'2024-04-03', restoreDate:null},
  {sym:'LOOM', name:'Loom Network', status:'delisted', monDate:'2023-07-26', delistDate:'2024-04-03', restoreDate:null},
  {sym:'PERL', name:'PERL', status:'delisted', monDate:'2023-07-26', delistDate:'2024-04-03', restoreDate:null},
  {sym:'CVP', name:'PowerPool', status:'delisted', monDate:'2024-07-01', delistDate:'2024-08-26', restoreDate:null},
  {sym:'MDX', name:'Mdex', status:'delisted', monDate:'2024-01-04', delistDate:'2024-08-26', restoreDate:null},
  {sym:'MOB', name:'MobileCoin', status:'delisted', monDate:'2024-01-04', delistDate:'2024-08-26', restoreDate:null},
  {sym:'VAI', name:'Vai', status:'delisted', monDate:'2024-01-04', delistDate:'2024-08-26', restoreDate:null},
  {sym:'OOKI', name:'Ooki Protocol', status:'delisted', monDate:'2023-07-26', delistDate:'2024-11-06', restoreDate:null},
  {sym:'REEF', name:'Reef', status:'delisted', monDate:'2024-01-04', delistDate:'2024-11-06', restoreDate:null},
  {sym:'GFT', name:'Gifto', status:'delisted', monDate:'2023-07-26', delistDate:'2024-12-10', restoreDate:null},
  {sym:'IRIS', name:'IRISnet', status:'delisted', monDate:'2024-07-01', delistDate:'2024-12-10', restoreDate:null},
  {sym:'KEY', name:'SelfKey', status:'delisted', monDate:'2024-10-03', delistDate:'2024-12-10', restoreDate:null},
  {sym:'AKRO', name:'Akropolis', status:'delisted', monDate:'2023-07-26', delistDate:'2024-12-25', restoreDate:null},
  {sym:'BLZ', name:'Bluzelle', status:'delisted', monDate:'2024-10-03', delistDate:'2024-12-25', restoreDate:null},
  {sym:'BAL', name:'Balancer', status:'delisted', monDate:'2024-07-01', delistDate:'2025-02-20', restoreDate:null},
  {sym:'CTXC', name:'Cortex', status:'delisted', monDate:'2024-07-01', delistDate:'2025-02-20', restoreDate:null},
  {sym:'DOCK', name:'Dock', status:'delisted', monDate:'2024-07-01', delistDate:'2025-02-20', restoreDate:null},
  {sym:'HARD', name:'Kava Lend', status:'delisted', monDate:'2024-07-01', delistDate:'2025-02-20', restoreDate:null},
  {sym:'XMR', name:'Monero', status:'delisted', monDate:'2024-01-04', delistDate:'2025-02-20', restoreDate:null},
  {sym:'CLV', name:'Clover Finance', status:'delisted', monDate:'2024-10-03', delistDate:'2025-04-16', restoreDate:null},
  {sym:'CREAM', name:'Cream Finance', status:'delisted', monDate:'2023-07-26', delistDate:'2025-04-16', restoreDate:null},
  {sym:'ELF', name:'aelf', status:'delisted', monDate:'2023-07-26', delistDate:'2025-04-16', restoreDate:null},
  {sym:'POLS', name:'Polkastarter', status:'delisted', monDate:'2024-07-01', delistDate:'2025-04-16', restoreDate:null},
  {sym:'PROS', name:'Prosper', status:'delisted', monDate:'2024-10-03', delistDate:'2025-04-16', restoreDate:null},
  {sym:'SNT', name:'Status', status:'delisted', monDate:'2024-07-01', delistDate:'2025-04-16', restoreDate:null},
  {sym:'STMX', name:'StormX', status:'delisted', monDate:'2025-01-02', delistDate:'2025-04-16', restoreDate:null},
  {sym:'UNFI', name:'Unifi Protocol', status:'delisted', monDate:'2023-07-26', delistDate:'2025-04-16', restoreDate:null},
  {sym:'VITE', name:'VITE', status:'delisted', monDate:'2024-10-03', delistDate:'2025-04-16', restoreDate:null},
  {sym:'ALPACA', name:'Alpaca Finance', status:'delisted', monDate:'2025-03-04', delistDate:'2025-06-02', restoreDate:null},
  {sym:'BURGER', name:'BurgerCities', status:'delisted', monDate:'2025-03-04', delistDate:'2025-06-02', restoreDate:null},
  {sym:'COMBO', name:'COMBO', status:'delisted', monDate:'2025-03-04', delistDate:'2025-06-02', restoreDate:null},
  {sym:'TROY', name:'TROY', status:'delisted', monDate:'2023-07-26', delistDate:'2025-06-02', restoreDate:null},
  {sym:'ALPHA', name:'Stella', status:'delisted', monDate:'2025-06-05', delistDate:'2025-07-04', restoreDate:null},
  {sym:'BSW', name:'Biswap', status:'delisted', monDate:'2025-05-07', delistDate:'2025-07-04', restoreDate:null},
  {sym:'KMD', name:'Komodo', status:'delisted', monDate:'2025-06-05', delistDate:'2025-07-04', restoreDate:null},
  {sym:'LEVER', name:'LeverFi', status:'delisted', monDate:'2025-06-05', delistDate:'2025-07-04', restoreDate:null},
  {sym:'LTO', name:'LTO Network', status:'delisted', monDate:'2025-05-07', delistDate:'2025-07-04', restoreDate:null},
  {sym:'AMB', name:'Ambrosus', status:'delisted', monDate:'2023-07-26', delistDate:'2025-07-25', restoreDate:null},
  {sym:'ANT', name:'Aragon', status:'delisted', monDate:'2024-01-04', delistDate:'2025-07-25', restoreDate:null},
  {sym:'FIRO', name:'Firo', status:'delisted', monDate:'2024-01-04', delistDate:'2025-07-25', restoreDate:null},
  {sym:'AERGO', name:'Aergo', status:'delisted', monDate:'2025-03-04', delistDate:'2025-09-30', restoreDate:null},
  {sym:'AST', name:'AirSwap', status:'delisted', monDate:'2025-03-04', delistDate:'2025-09-30', restoreDate:null},
  {sym:'BADGER', name:'Badger', status:'delisted', monDate:'2025-03-04', delistDate:'2025-09-30', restoreDate:null},
  {sym:'KP3R', name:'Keep3rV1', status:'delisted', monDate:'2024-01-04', delistDate:'2025-09-30', restoreDate:null},
  {sym:'NULS', name:'NULS', status:'delisted', monDate:'2025-03-04', delistDate:'2025-09-30', restoreDate:null},
  {sym:'PDA', name:'PlayDapp', status:'delisted', monDate:'2025-05-07', delistDate:'2025-09-30', restoreDate:null},
  {sym:'UFT', name:'UniLend', status:'delisted', monDate:'2025-04-03', delistDate:'2025-09-30', restoreDate:null},
  {sym:'VIB', name:'Viberate', status:'delisted', monDate:'2025-05-07', delistDate:'2025-09-30', restoreDate:null},
  {sym:'VIDT', name:'VIDT DAO', status:'delisted', monDate:'2025-04-03', delistDate:'2025-09-30', restoreDate:null},
  {sym:'VOXEL', name:'Voxies', status:'delisted', monDate:'2025-05-07', delistDate:'2025-09-30', restoreDate:null},
  {sym:'WING', name:'Wing Finance', status:'delisted', monDate:'2025-05-07', delistDate:'2025-09-30', restoreDate:null},
  {sym:'FLM', name:'Flamingo', status:'delisted', monDate:'2025-05-07', delistDate:'2025-11-12', restoreDate:null},
  {sym:'HIFI', name:'Hifi Finance', status:'delisted', monDate:'2025-06-05', delistDate:'2025-11-12', restoreDate:null},
  {sym:'FIS', name:'StaFi', status:'delisted', monDate:'2025-06-05', delistDate:'2025-12-17', restoreDate:null},
  {sym:'REI', name:'REI Network', status:'delisted', monDate:'2025-06-05', delistDate:'2025-12-17', restoreDate:null},
  {sym:'ACA', name:'Acala Token', status:'delisted', monDate:'2026-01-02', delistDate:'2026-02-13', restoreDate:null},
  {sym:'CHESS', name:'Tranchess', status:'delisted', monDate:'2025-12-01', delistDate:'2026-02-13', restoreDate:null},
  {sym:'DATA', name:'Streamr', status:'delisted', monDate:'2026-01-02', delistDate:'2026-02-13', restoreDate:null},
  {sym:'DF', name:'dForce', status:'delisted', monDate:'2025-12-01', delistDate:'2026-02-13', restoreDate:null},
  {sym:'GHST', name:'Aavegotchi', status:'delisted', monDate:'2025-12-01', delistDate:'2026-02-13', restoreDate:null},
  {sym:'NKN', name:'NKN', status:'delisted', monDate:'2025-05-07', delistDate:'2026-02-13', restoreDate:null},
  {sym:'BETA', name:'Beta Finance', status:'delisted', monDate:'2023-10-04', delistDate:'2026-02-13', restoreDate:null},
  {sym:'MLN', name:'Enzyme', status:'restored', monDate:'2023-07-26', delistDate:null, restoreDate:'2024-07-01'},
  {sym:'ZEN', name:'Horizen', status:'restored', monDate:'2024-01-04', delistDate:null, restoreDate:'2024-07-01'},
  {sym:'ZEC', name:'Zcash', status:'restored', monDate:'2024-01-04', delistDate:null, restoreDate:'2025-07-09'},
  {sym:'CVX', name:'Convex Finance', status:'restored', monDate:'2024-07-01', delistDate:null, restoreDate:'2025-01-02'},
  {sym:'SUN', name:'SUN', status:'restored', monDate:'2023-07-26', delistDate:null, restoreDate:'2025-01-02'},
  {sym:'GPS', name:'GoPlus Security', status:'restored', monDate:'2025-06-05', delistDate:null, restoreDate:'2025-10-09'},
  {sym:'FLOW', name:'Flow', status:'restored', monDate:'2026-01-02', delistDate:null, restoreDate:'2026-03-06'},
];

// Total: 108 tokens
// delisted: 68
// delisting: 8
// monitoring: 25
// restored: 7

// Build lookup from tracked tokens
const trackedMap = {};
TRACKED_TOKENS.forEach(t => { trackedMap[t.sym] = t; });

// ============ LIVE DATA ============
let allCoins = []; // Combined: tracked + discovered active coins
let liveData = {};
let exchangeData = { coinbase: new Set(), okx: new Set(), kraken: new Set() };
let filter = 'monitoring'; // default: show officially flagged coins
let query = '';
let sort = { key: 'risk', dir: 'desc' };
let page = 0;
const PAGE_SIZE = 100;

// Leveraged/stable tokens to exclude
const EXCLUDE = new Set([
    // Stablecoins
    'USDC','BUSD','TUSD','FDUSD','USDP','DAI','USDD','AEUR','XUSD','BFUSD','RLUSD','USD1','USDE',
    // Leveraged tokens
    'BTCUP','BTCDOWN','ETHUP','ETHDOWN','BNBUP','BNBDOWN','XRPUP','XRPDOWN',
    'TRXUP','TRXDOWN','LINKUP','LINKDOWN','DOTUP','DOTDOWN','ADAUP','ADADOWN',
    'EOSUP','EOSDOWN','LTCUP','LTCDOWN','XLMUP','XLMDOWN','UNIUP','UNIDOWN',
    'SXPUP','SXPDOWN','FILUP','FILDOWN','AAVEUP','AAVEDOWN','SUSHIUP','SUSHIDOWN',
    // Wrapped / legacy tokens
    'WBTC','WBETH','BNSOL','LUNC','USTC','PAXG','EUR','EURI','OCEAN','AGIX','MATIC','FTM','UST','LUNA','BTCST','MFT','BOND',
    // Blue chip coins — never at delisting risk
    'BTC','ETH','BNB','XRP','ADA','SOL','DOGE','TRX','DOT','SHIB',
    'LTC','AVAX','LINK','ATOM','TON','UNI','XLM','BCH','NEAR','APT',
    'ICP','OP','ARB','ETC','HBAR','FIL','VET','CAKE','STX','SUI',
    'SEI','TIA','INJ','RUNE','KAS','THETA','EOS','XTZ','ALGO','EGLD',
    'SAND','MANA','AXS','GALA','ENJ','CRO','GRT','SNX','AAVE','MKR',
    'COMP','CRV','1INCH','SUSHI','YFI','BAT','ZRX','LDO','RNDR','FET']);

// ============ HELPERS ============
const daysBetween = (a,b) => Math.round((new Date(b)-new Date(a))/(864e5));
const daysUntil = d => daysBetween(NOW.toISOString().slice(0,10), d);
const fmtDate = d => d ? new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) : null;
const fmtNum = (n, d=2) => {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e9) return '$' + (n/1e9).toFixed(d) + 'B';
    if (n >= 1e6) return '$' + (n/1e6).toFixed(d) + 'M';
    if (n >= 1e3) return '$' + (n/1e3).toFixed(d) + 'K';
    return '$' + n.toFixed(d);
};
const fmtPrice = p => {
    if (p == null) return '—';
    if (p >= 1000) return '$' + p.toFixed(0);
    if (p >= 1) return '$' + p.toFixed(2);
    if (p >= 0.01) return '$' + p.toFixed(4);
    if (p >= 0.0001) return '$' + p.toFixed(6);
    return '$' + p.toFixed(8);
};

// ============ DATA FETCHING ============
async function fetchAllData() {
    // Step 0+1: Fetch exchangeInfo and ticker in parallel
    let tradingPairs = null;
    let _tickerJson = null;
    await Promise.all([
        fetch(BINANCE_API + '/exchangeInfo').then(r => r.ok ? r.json() : null).then(ei => {
            if (!ei) return;
            tradingPairs = new Set();
            ei.symbols.forEach(s => {
                if (s.quoteAsset === 'USDT' && s.status === 'TRADING') tradingPairs.add(s.baseAsset);
            });
            console.log('ExchangeInfo: ' + tradingPairs.size + ' active USDT pairs');
        }).catch(e => console.warn('ExchangeInfo failed:', e.message)),
        fetch(BINANCE_API + '/ticker/24hr').then(r => r.ok ? r.json() : null).then(j => { _tickerJson = j; }).catch(() => {}),
    ]);

    // Step 1: Process ticker data
    let tickerOk = false;
    try {
        if (!_tickerJson || !Array.isArray(_tickerJson) || _tickerJson.length === 0) throw new Error('Empty ticker response');
        const all = _tickerJson;
        const activePairs = new Set();
        all.forEach(t => {
            if (!t.symbol.endsWith('USDT')) return;
            const sym = t.symbol.slice(0, -4);
            if (EXCLUDE.has(sym)) return;
            // Only include if actually TRADING (or if exchangeInfo failed, include all)
            if (tradingPairs && !tradingPairs.has(sym)) return;
            liveData[sym] = {
                ...(liveData[sym] || {}),
                price: parseFloat(t.lastPrice),
                change: parseFloat(t.priceChangePercent),
                vol: parseFloat(t.quoteVolume),
                count: parseInt(t.count),
                high: parseFloat(t.highPrice),
                low: parseFloat(t.lowPrice),
            };
            if (parseFloat(t.quoteVolume) > 0) {
                activePairs.add(sym);
            }
        });

        // Step 2: Build allCoins from tracked tokens + ALL active coins from exchangeInfo
        const newCoins = [...TRACKED_TOKENS];
        const trackedSyms = new Set(TRACKED_TOKENS.map(t => t.sym));
        if (tradingPairs) {
            // Add ALL coins from exchangeInfo that are TRADING (authoritative source)
            tradingPairs.forEach(sym => {
                if (!trackedSyms.has(sym) && !EXCLUDE.has(sym)) {
                    newCoins.push({ sym, name: sym, status: 'active', monDate: null });
                }
            });
        } else {
            // Fallback: use ticker data but be conservative
            activePairs.forEach(sym => {
                if (!trackedSyms.has(sym) && liveData[sym]?.count > 100 && liveData[sym]?.vol > 10000) {
                    newCoins.push({ sym, name: sym, status: 'active', monDate: null });
                }
            });
        }
        allCoins = newCoins;
        tickerOk = true;
    } catch(e) {
        console.warn('Ticker fetch failed, keeping previous data:', e.message);
        // On first load with no data, use tracked tokens as fallback
        if (allCoins.length === 0) allCoins = [...TRACKED_TOKENS];
    }

    const lprog = document.getElementById('bn-lprog');
    const ltxt = document.getElementById('bn-ltxt');
    if (lprog) lprog.style.width = '40%';
    if (ltxt) ltxt.textContent = 'Processing ' + allCoins.length + ' coins...';

    // Step 3: Compute risk scores (volume-based first pass)
    computeRiskScores();

    // Render immediately with volume data
    if (lprog) lprog.style.width = '70%';
    if (ltxt) ltxt.textContent = 'Rendering table...';
    bnRenderAll();
    if (lprog) lprog.style.width = '100%';
    setTimeout(() => { document.getElementById('bn-loader').classList.add('hidden'); const nl = document.getElementById('tnav-live'); if (nl) nl.style.display = 'flex'; }, 200);

    // Step 4: Fetch market caps from CoinGecko (async, renders update when done)
    fetchMarketCaps();

    // Step 5: Fetch depth for high-risk + monitoring tokens
    fetchDepthData();

    // Step 6: Fetch cross-exchange listing data
    fetchExchangeData();
}

async function fetchMarketCaps() {
    try {
        // Get active tokens for CoinGecko lookup (include delisted for icon-only fetch)
        const activeSyms = allCoins
            .filter(t => t.status !== 'delisted' && liveData[t.sym])
            .map(t => t.sym);
        // Add delisted tracked tokens for icon fetch (no live data needed, just icons)
        const delistedSyms = TRACKED_TOKENS
            .filter(t => t.status === 'delisted' && !liveData[t.sym]?.icon)
            .map(t => t.sym);
        const allSymsForIcons = [...new Set([...activeSyms, ...delistedSyms])];

        // Manual overrides for ambiguous symbols
        const overrides = {
            '1MBABYDOGE':'baby-doge-coin',
            'FTT':'ftx-token','ELF':'aelf','JASMY':'jasmycoin','MLN':'melon','SUN':'sun-token',
            'ZEC':'zcash','ZEN':'horizen','BAL':'balancer','CVX':'convex-finance','SNT':'status',
            'KEY':'selfkey','ARK':'ark','LOOM':'loom-network-new','ANT':'aragon','FIRO':'zcoin',
            'MBL':'moviebloc','POLS':'polkastarter','IRIS':'iris-network','PERP':'perpetual-protocol',
            'ALPHA':'stella-2','MOVE':'movement','PORTAL':'portal-2','BIFI':'beefy-finance',
            'FLOW':'flow','FORTH':'ampleforth-governance-token','HOOK':'hooked-protocol',
            'LRC':'loopring','WIF':'dogwifcoin','GTC':'gitcoin','NTRN':'neutron-3',
            'RDNT':'radiant-capital','GPS':'goplus-security','D':'dar-open-network',
            'DENT':'dent','SXP':'swipe','QI':'benqi','IDEX':'idex',
            'AWE':'stp-network','OXT':'orchid-protocol','FUN':'funfair','ARDR':'ardor',
            'WAN':'wanchain','COS':'contentos','DEGO':'dego-finance','MBOX':'mobox',
            'ATA':'automata','FIO':'fio-protocol','PHB':'phoenix-global','A2Z':'arena-z',
            'MDT':'measurable-data-token','FLM':'flamingo-finance','NKN':'nkn',
            'CHESS':'tranchess','GHST':'aavegotchi','ACA':'acala',
            'BETA':'beta-finance','VOXEL':'voxies','HIFI':'hifi-finance',
            'DATA':'streamr','DF':'dforce-token','COMBO':'furucombo',
            'ALPACA':'alpaca-finance','BURGER':'burger-swap','STMX':'storm',
            'AERGO':'aergo','AST':'airswap','BADGER':'badger-dao',
            'NULS':'nuls','PDA':'playdapp','UFT':'unlend-finance',
            'VIB':'viberate','VIDT':'vidt-dao','WING':'wing-finance',
            'KP3R':'keep3rv1','DOCK':'dock','HARD':'kava-lend',
            'CTXC':'cortex','CLV':'clover-finance','CREAM':'cream-2',
            'PROS':'prosper','UNFI':'unifi-protocol-dao','VITE':'vite',
            'KMD':'komodo','LEVER':'leverfi','BSW':'biswap','LTO':'lto-network',
            'AMB':'ambrosus','FIRO':'zcoin','REI':'rei-network',
            'FIS':'stafi','AKRO':'akropolis','BLZ':'bluzelle',
            'REEF':'reef','OOKI':'ooki','GFT':'gifto',
            'DREP':'drep-new','LINA':'linear-finance',
            'BTC':'bitcoin','ETH':'ethereum','BNB':'binancecoin','SOL':'solana',
            'XRP':'ripple','DOGE':'dogecoin','ADA':'cardano','AVAX':'avalanche-2',
            'DOT':'polkadot','LINK':'chainlink','SHIB':'shiba-inu','UNI':'uniswap',
            'ATOM':'cosmos','FIL':'filecoin','APT':'aptos','ARB':'arbitrum',
            'OP':'optimism','SUI':'sui','NEAR':'near','INJ':'injective-protocol',
            'ONDO':'ondo-finance','RENDER':'render-token','FET':'artificial-superintelligence-alliance',
            'PEPE':'pepe','BONK':'bonk','FLOKI':'floki','WLD':'worldcoin-wld',
            'TIA':'celestia','SEI':'sei-network','STRK':'starknet','STX':'blockstack',
            'IMX':'immutable-x','MANA':'decentraland','SAND':'the-sandbox',
            'AAVE':'aave','CRV':'curve-dao-token','MKR':'maker','COMP':'compound-governance-token',
            'LDO':'lido-dao','ENS':'ethereum-name-service','DYDX':'dydx-chain',
            'GMX':'gmx','SNX':'havven','SUSHI':'sushi','CAKE':'pancakeswap-token',
            'PENDLE':'pendle','TAO':'bittensor','HBAR':'hedera-hashgraph',
            // Common active altcoins
            'QKC':'quark-chain','ICX':'icon','LSK':'lisk','BNT':'bancor',
            'IOST':'iostoken','KGST':'kanga-exchange','RPL':'rocket-pool',
            'POND':'marlin','REQ':'request-network','BICO':'biconomy',
            'XNO':'nano','OSMO':'osmosis','HOT':'holotoken','CVC':'civic',
            'WIN':'wink','TFUEL':'theta-fuel','ONE':'harmony','CHZ':'chiliz',
            'ARPA':'arpa-chain','IOTX':'iotex','RLC':'iexec-rlc','OGN':'origin-protocol',
            'CTSI':'cartesi','HIVE':'hive','CHR':'chromia','KNC':'kyber-network-crystal',
            'SC':'siacoin','VTHO':'vethor-token','DGB':'digibyte','DCR':'decred',
            'STORJ':'storj','JST':'just','NMR':'numeraire','RSR':'reserve-rights-token',
            'TRB':'tellor','KSM':'kusama','DIA':'dia-data','UMA':'uma',
            'BEL':'bella-protocol','UTK':'utrust','XVS':'venus','AUDIO':'audius',
            'CTK':'certik','STRAX':'stratis','ROSE':'oasis-network','AVA':'concierge-io',
            'SKL':'skale','PSG':'paris-saint-germain-fan-token','JUV':'juventus-fan-token',
            'CELO':'celo','RIF':'rif-token','CELR':'celer-network','DASH':'dash',
            'RVN':'ravencoin','BAND':'band-protocol','ZIL':'zilliqa',
            'ONT':'ontology','ONG':'ong','MDX':'mdex','VAI':'vai',
            'MOB':'mobilecoin','TORN':'tornado-cash','WAX':'wax',
            'MULTI':'multichain','IRIS':'iris-network','CVP':'powerpool',
        };

        const getGeckoId = sym => overrides[sym] || sym.toLowerCase();

        // Batch fetch from CoinGecko markets API (100 at a time)
        const batches = [];
        for (let i = 0; i < allSymsForIcons.length; i += 100) {
            batches.push(allSymsForIcons.slice(i, i + 100));
        }

        for (const batch of batches) {
            const ids = batch.map(getGeckoId).join(',');
            try {
                const resp = await fetch(\`/cg/coins/markets?vs_currency=usd&ids=\${ids}&per_page=250\`);
                if (!resp.ok) continue;
                const data = await resp.json();
                data.forEach(coin => {
                    // Find matching symbol
                    const sym = batch.find(s => getGeckoId(s) === coin.id);
                    if (sym) {
                        if (!liveData[sym]) liveData[sym] = {};
                        // Only update price/mcap for non-delisted coins with live data
                        if (liveData[sym].price !== undefined) {
                            liveData[sym].mcap = coin.market_cap || coin.fully_diluted_valuation || 0;
                            liveData[sym].fdv = coin.fully_diluted_valuation;
                        }
                        if (coin.image) liveData[sym].icon = coin.image;
                        if (coin.id) liveData[sym].cgId = coin.id;
                    }
                });
            } catch(e) { /* continue */ }
            await new Promise(r => setTimeout(r, 200)); // Cloudflare worker caches these
        }

        // Recompute risk scores with market cap data
        computeRiskScores();
        bnRenderAll();
    } catch(e) { console.error('CoinGecko error:', e); }
}

async function fetchDepthData() {
    // Only fetch depth for monitoring + delisting + top 30 high-risk active tokens
    const candidates = allCoins.filter(t => {
        if (t.status === 'monitoring' || t.status === 'delisting') return true;
        if (t.status === 'active' && t._risk >= 70) return true;
        return false;
    }).filter(t => liveData[t.sym]?.price).slice(0, 20);

    for (let i = 0; i < candidates.length; i += 5) {
        const batch = candidates.slice(i, i + 5);
        await Promise.all(batch.map(async tk => {
            try {
                const resp = await fetch(BINANCE_API + \`/depth?symbol=\${tk.sym}USDT&limit=1000\`);
                if (!resp.ok) return;
                const ob = await resp.json();
                const price = liveData[tk.sym].price;
                const low2 = price * 0.98, high2 = price * 1.02;
                let bidDepth = 0, askDepth = 0;
                for (const [p, q] of ob.bids) {
                    const px = parseFloat(p);
                    if (px >= low2) bidDepth += parseFloat(q) * px; else break;
                }
                for (const [p, q] of ob.asks) {
                    const px = parseFloat(p);
                    if (px <= high2) askDepth += parseFloat(q) * px; else break;
                }
                liveData[tk.sym].bidDepth = bidDepth;
                liveData[tk.sym].askDepth = askDepth;
            } catch(e) {}
        }));
        if (i + 5 < candidates.length) await new Promise(r => setTimeout(r, 500));
    }
    computeRiskScores();
    bnRenderAll();
}

async function fetchExchangeData() {
    // Coinbase
    try {
        const resp = await fetch('/ex/coinbase');
        if (resp.ok) {
            const products = await resp.json();
            if (Array.isArray(products)) {
                products.forEach(p => {
                    if (p.quote_currency === 'USD' || p.quote_currency === 'USDT') {
                        exchangeData.coinbase.add(p.base_currency);
                    }
                });
            }
        }
    } catch(e) { console.warn('Coinbase fetch failed:', e.message); }

    // OKX
    try {
        const resp = await fetch('/ex/okx');
        if (resp.ok) {
            const data = await resp.json();
            (data.data || []).forEach(inst => {
                if (inst.quoteCcy === 'USDT') exchangeData.okx.add(inst.baseCcy);
            });
        }
    } catch(e) { console.warn('OKX fetch failed:', e.message); }

    // Kraken
    try {
        const resp = await fetch('/ex/kraken');
        if (resp.ok) {
            const data = await resp.json();
            Object.values(data.result || {}).forEach(info => {
                if (['ZUSD','USD','USDT'].includes(info.quote)) {
                    let base = info.base || '';
                    if (base.startsWith('X') && base.length > 3) base = base.slice(1);
                    exchangeData.kraken.add(base);
                }
            });
        }
    } catch(e) { console.warn('Kraken fetch failed:', e.message); }

    console.log('Exchanges loaded: CB=' + exchangeData.coinbase.size + ' OKX=' + exchangeData.okx.size + ' KR=' + exchangeData.kraken.size);
    bnRenderAll();
}

// ============ RISK SCORING ============
function computeRiskScores() {
    // Gather volume/mcap stats from all active coins for percentile calculation
    const vols = [], mcaps = [], depths = [];
    allCoins.forEach(t => {
        const ld = liveData[t.sym];
        if (!ld) return;
        if (ld.vol > 0) vols.push(ld.vol);
        if (ld.mcap > 0) mcaps.push(ld.mcap);
        if (ld.bidDepth > 0) depths.push(ld.bidDepth + (ld.askDepth || 0));
    });
    vols.sort((a,b) => a-b);
    mcaps.sort((a,b) => a-b);
    depths.sort((a,b) => a-b);

    const pctile = (arr, val) => {
        if (!arr.length || val <= 0) return 0;
        let i = 0;
        while (i < arr.length && arr[i] < val) i++;
        return (i / arr.length) * 100;
    };

    allCoins.forEach(t => {
        const ld = liveData[t.sym] || {};

        // Delisted tokens with no live data - skip scoring
        if (t.status === 'delisted' && !ld.vol) {
            t._risk = 0;
            t._riskLabel = 'DELISTED';
            return;
        }

        // ---- Calculate metrics-based risk for EVERY coin individually ----
        let risk = 0;

        // Factor 1: Volume percentile (0-35 points) - lower volume = higher risk
        const volPct = pctile(vols, ld.vol || 0);
        const volRisk = Math.max(0, 35 - (volPct * 0.35));
        risk += volRisk;

        // Factor 2: Market cap percentile (0-25 points) - smaller cap = higher risk
        const mcapPct = pctile(mcaps, ld.mcap || 0);
        const mcapRisk = ld.mcap ? Math.max(0, 25 - (mcapPct * 0.25)) : 20; // Unknown mcap = moderate risk
        risk += mcapRisk;

        // Factor 3: Order book depth (0-20 points) - thinner book = higher risk
        const totalDepth = (ld.bidDepth || 0) + (ld.askDepth || 0);
        const depthPct = pctile(depths, totalDepth);
        const depthRisk = depths.length > 0 ? Math.max(0, 20 - (depthPct * 0.2)) : 10;
        risk += depthRisk;

        // Factor 4: Trade count (0-10 points) - fewer trades = higher risk
        const countRisk = ld.count ? Math.max(0, 10 - Math.min(10, Math.log10(ld.count) * 2.5)) : 8;
        risk += countRisk;

        // Factor 5: Price decline (0-10 points) - big 24h drops increase risk
        const changeRisk = ld.change < -10 ? 10 : ld.change < -5 ? 5 : ld.change < 0 ? 2 : 0;
        risk += changeRisk;

        // ---- Status modifiers (added on top of real metrics) ----
        if (t.status === 'monitoring') {
            // Already tagged: their metrics-based score IS their real risk,
            // but add a small floor since Binance already flagged them
            risk = Math.max(risk, 40);
        } else if (t.status === 'delisting') {
            // Confirmed for removal: floor at 85
            risk = Math.max(risk, 85);
        } else if (t.status === 'restored') {
            // Survived and restored: reduce risk, proven resilient
            risk = Math.max(0, risk * 0.6);
        }

        t._risk = Math.min(100, Math.max(0, Math.round(risk)));

        // Labels
        if (t._risk >= 70) t._riskLabel = 'CRITICAL';
        else if (t._risk >= 50) t._riskLabel = 'HIGH';
        else if (t._risk >= 30) t._riskLabel = 'MEDIUM';
        else if (t._risk >= 15) t._riskLabel = 'LOW';
        else t._riskLabel = 'SAFE';
    });
}

// ============ ANALYSIS ============
function getMedianMonToDelist() {
    const durations = TRACKED_TOKENS
        .filter(t => t.delistDate && t.monDate)
        .map(t => daysBetween(t.monDate, t.delistDate));
    if (!durations.length) return null;
    durations.sort((a,b) => a-b);
    return durations[Math.floor(durations.length / 2)];
}

// ============ RENDERING ============

function getExchangeIcons(sym) {
    const icons = [];
    if (exchangeData.coinbase.has(sym)) {
        icons.push('<a href="https://www.coinbase.com/price/' + sym.toLowerCase() + '" target="_blank" title="Coinbase"><img src="https://www.google.com/s2/favicons?domain=coinbase.com&sz=32" alt="CB"></a>');
    }
    if (exchangeData.okx.has(sym)) {
        icons.push('<a href="https://www.okx.com/trade-spot/' + sym.toLowerCase() + '-usdt" target="_blank" title="OKX"><img src="https://www.google.com/s2/favicons?domain=okx.com&sz=32" alt="OKX"></a>');
    }
    if (exchangeData.kraken.has(sym)) {
        icons.push('<a href="https://www.kraken.com/prices/' + sym.toLowerCase() + '" target="_blank" title="Kraken"><img src="https://www.google.com/s2/favicons?domain=kraken.com&sz=32" alt="KR"></a>');
    }
    return icons.length ? '<div class="ex-icons">' + icons.join('') + '</div>' : '<span class="na">—</span>';
}


function getCMCSlug(sym) {
    // 1. Check explicit known slugs (highest confidence)
    const slugs = {
        'BTC':'bitcoin','ETH':'ethereum','BNB':'bnb','SOL':'solana','XRP':'xrp',
        'DOGE':'dogecoin','ADA':'cardano','AVAX':'avalanche','DOT':'polkadot',
        'LINK':'chainlink','SHIB':'shiba-inu','UNI':'uniswap','ATOM':'cosmos',
        'FIL':'filecoin','APT':'aptos','ARB':'arbitrum','OP':'optimism',
        'SUI':'sui','NEAR':'near-protocol','INJ':'injective','ONDO':'ondo-finance',
        'RENDER':'render','FET':'fetch-ai','PEPE':'pepe','BONK':'bonk',
        'FLOKI':'floki','WLD':'worldcoin-wld','WIF':'dogwifhat',
        'MLN':'enzyme','ZEN':'horizen','ZEC':'zcash','CVX':'convex-finance',
        'BAL':'balancer','GRT':'the-graph','IMX':'immutable','SAND':'the-sandbox',
        'MANA':'decentraland','AAVE':'aave','CRV':'curve-dao-token','LDO':'lido-dao',
        'ENS':'ethereum-name-service','SNX':'synthetix-network-token','SUSHI':'sushiswap',
        'HBAR':'hedera','ALGO':'algorand','TAO':'bittensor','FLOW':'flow',
        'JASMY':'jasmycoin','FTT':'ftx-token','ARK':'ark','ARDR':'ardor',
        'PERP':'perpetual-protocol','MBL':'moviebloc','AWE':'stp-network',
        'MOVE':'movement','BIFI':'beefy-finance','MDT':'measurable-data-token',
        'PORTAL':'portal-gaming','WAN':'wanchain','DENT':'dent',
        'COS':'contentos','DEGO':'dego-finance','FUN':'funfair','MBOX':'mobox',
        'OXT':'orchid','ATA':'automata','FIO':'fio-protocol','GTC':'gitcoin',
        'PHB':'phoenix-global','QI':'benqi','A2Z':'arena-z',
        'FORTH':'ampleforth-governance-token','HOOK':'hooked-protocol','IDEX':'idex',
        'LRC':'loopring','NTRN':'neutron-3','RDNT':'radiant-capital','SXP':'swipe',
        'GPS':'goplus-security','SUN':'sun-token',
        'BSW':'biswap','KMD':'komodo','LEVER':'leverfi','LTO':'lto-network',
        'FLM':'flamingo-finance','HIFI':'hifi-finance','FIS':'stafi','REI':'rei-network',
        'NKN':'nkn','ACA':'acala','CHESS':'tranchess','DATA':'streamr',
        'DF':'dforce-token','GHST':'aavegotchi','BETA':'beta-finance',
        'AERGO':'aergo','AST':'airswap','BADGER':'badger-dao','D':'mines-of-dalarnia',
        'NULS':'nuls','VOXEL':'voxies','WING':'wing-finance',
        'XMR':'monero','ALPACA':'alpaca-finance','STMX':'stormx',
        'AKRO':'akropolis','BLZ':'bluzelle','REEF':'reef-finance',
        'TIA':'celestia','SEI':'sei','STX':'stacks','STRK':'starknet',
        'TRUMP':'official-trump','KSM':'kusama','EGLD':'multiversx',
        'DASH':'dash','MINA':'mina-protocol','RSR':'reserve-rights-token',
        'SKL':'skale','ANKR':'ankr','STORJ':'storj','CHZ':'chiliz',
        'BAT':'basic-attention-token','QNT':'quant-network','TON':'toncoin',
        'HNT':'helium','PENDLE':'pendle','ROSE':'oasis-network',
        'KAVA':'kava','GRT':'the-graph','COMP':'compound',
        'MKR':'maker','ENA':'ethena','W':'wormhole','PYTH':'pyth-network',
        'JTO':'jito','EIGEN':'eigenlayer','MORPHO':'morpho','KAITO':'kaito',
        'HYPE':'hyperliquid','BERA':'berachain','S':'sonic','IP':'story',
        'PENGU':'pengu','FARTCOIN':'fartcoin','SPX':'spx6900','MOG':'mog-coin',
        'GIGA':'gigachad','POPCAT':'popcat',
    };
    if (slugs[sym]) return slugs[sym];
    // 2. Use CoinGecko ID (fetched from API) with known CG→CMC corrections
    const cgId = liveData[sym]?.cgId;
    if (cgId) return CG_TO_CMC[cgId] || cgId;
    // 3. Unknown — return null so caller skips the CMC link
    return null;
}
function getFiltered() {
    let list = [...allCoins];

    // Filter by tab
    if (filter === 'monitoring') list = list.filter(t => t.status === 'monitoring');
    else if (filter === 'delisting') list = list.filter(t => t.status === 'delisting');
    else if (filter === 'delisted') list = list.filter(t => t.status === 'delisted');
    else if (filter === 'restored') list = list.filter(t => t.status === 'restored');
    else if (filter === 'active') list = list.filter(t => t.status === 'active' || t.status === 'monitoring' || t.status === 'delisting' || t.status === 'restored');
    else if (filter === 'highrisk') list = list.filter(t => (t.status === 'active' && t._risk >= 50) || t.status === 'monitoring' || t.status === 'delisting');
    else if (filter === 'all') { /* show everything */ }

    // Search
    if (query) {
        const q = query.toLowerCase();
        list = list.filter(t => t.sym.toLowerCase().includes(q) || (t.name||'').toLowerCase().includes(q));
    }

    // Sort
    const today = NOW.toISOString().slice(0,10);
    // Status priority: active=0, monitoring=1, delisting=2, restored=3, delisted=4
    const statusOrder = {active:0, monitoring:1, delisting:2, restored:3, delisted:4};
    list.sort((a,b) => {
        // Primary: group by status (active first, delisted last)
        const sa = statusOrder[a.status] ?? 5, sb = statusOrder[b.status] ?? 5;
        if (sa !== sb) return sa - sb;
        // Secondary: user-selected sort
        let va, vb;
        const ld = liveData;
        switch(sort.key) {
            case 'symbol': va=a.sym; vb=b.sym; break;
            case 'status': va=sa; vb=sb; break;
            case 'risk': va=a._risk||0; vb=b._risk||0; break;
            case 'daysOnMon':
                va = a.monDate ? daysBetween(a.monDate, today) : -1;
                vb = b.monDate ? daysBetween(b.monDate, today) : -1; break;
            case 'monDate': va=a.monDate||'0'; vb=b.monDate||'0'; break;
            case 'delistDate': va=a.delistDate||'9999'; vb=b.delistDate||'9999'; break;
            case 'price': va=ld[a.sym]?.price||0; vb=ld[b.sym]?.price||0; break;
            case 'change': va=ld[a.sym]?.change||0; vb=ld[b.sym]?.change||0; break;
            case 'vol': va=ld[a.sym]?.vol||0; vb=ld[b.sym]?.vol||0; break;
            case 'mcap': va=ld[a.sym]?.mcap||0; vb=ld[b.sym]?.mcap||0; break;
            case 'bidDepth': va=ld[a.sym]?.bidDepth||0; vb=ld[b.sym]?.bidDepth||0; break;
            case 'askDepth': va=ld[a.sym]?.askDepth||0; vb=ld[b.sym]?.askDepth||0; break;
            default: va=a.sym; vb=b.sym;
        }
        if (va < vb) return sort.dir==='asc' ? -1 : 1;
        if (va > vb) return sort.dir==='asc' ? 1 : -1;
        return 0;
    });
    return list;
}

function renderStats() {
    const mon = allCoins.filter(t => t.status === 'monitoring').length;
    const deling = allCoins.filter(t => t.status === 'delisting').length;
    const deled = allCoins.filter(t => t.status === 'delisted').length;
    const rest = allCoins.filter(t => t.status === 'restored').length;
    const active = allCoins.filter(t => t.status === 'active').length;
    const highRisk = allCoins.filter(t => t.status === 'active' && t._risk >= 50).length;
    const medDays = getMedianMonToDelist();
    document.getElementById('bn-stats').innerHTML = \`
        <div class="stat"><div class="stat-label">Active Coins</div><div class="stat-val b">\${active}</div><div class="stat-sub">trading on Binance</div></div>
        <div class="stat"><div class="stat-label">⚠ High Risk</div><div class="stat-val r">\${highRisk}</div><div class="stat-sub">risk score ≥ 50</div></div>
        <div class="stat"><div class="stat-label">Monitoring</div><div class="stat-val a">\${mon}</div><div class="stat-sub">tagged by Binance</div></div>
        <div class="stat"><div class="stat-label">Delisting</div><div class="stat-val r">\${deling}</div><div class="stat-sub">scheduled removal</div></div>
        <div class="stat"><div class="stat-label">Restored</div><div class="stat-val g">\${rest}</div><div class="stat-sub">tag removed</div></div>
        <div class="stat"><div class="stat-label">Delisted</div><div class="stat-val">\${deled}</div><div class="stat-sub">since Jul 2023</div></div>
        <div class="stat"><div class="stat-label">Median to Delist</div><div class="stat-val p">\${medDays||'—'}d</div><div class="stat-sub">tag → removal</div></div>
    \`;
}

function renderPredBar() {
    // Compute next expected announcement date dynamically
    // Collect all unique monDates, find the latest, add median interval
    const dates = [...new Set(TRACKED_TOKENS.map(t => t.monDate).filter(Boolean))].sort();
    let nextWave = '—';
    if (dates.length >= 2) {
        const intervals = [];
        for (let i = 1; i < dates.length; i++) {
            intervals.push(daysBetween(dates[i-1], dates[i]));
        }
        intervals.sort((a,b) => a-b);
        const medInterval = intervals[Math.floor(intervals.length / 2)];
        const lastDate = dates[dates.length - 1];
        const nextDate = new Date(lastDate + 'T00:00:00');
        nextDate.setDate(nextDate.getDate() + medInterval);
        const today = NOW.toISOString().slice(0,10);
        if (nextDate.toISOString().slice(0,10) > today) {
            nextWave = '~' + nextDate.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
        } else {
            nextWave = 'Due soon';
        }
    }
    document.getElementById('bn-predBar').innerHTML = \`
        <span class="pred-label">🔮 Pattern Analysis</span>
        <span class="pred-val">Next tag wave: \${nextWave}</span>
        <span class="pred-sep"></span>
        <span class="pred-val">Delist rate: \${Math.round(TRACKED_TOKENS.filter(t=>t.status==='delisted').length / TRACKED_TOKENS.length * 100)}%</span>
        <span class="pred-sep"></span>
        <span class="pred-val">Restore rate: \${Math.round(TRACKED_TOKENS.filter(t=>t.status==='restored').length / TRACKED_TOKENS.length * 100)}%</span>
    \`;
}

function renderFilters() {
    const all = allCoins.length;
    const active = allCoins.filter(t => t.status === 'active' || t.status === 'monitoring' || t.status === 'delisting' || t.status === 'restored').length;
    const mon = allCoins.filter(t => t.status === 'monitoring').length;
    const deling = allCoins.filter(t => t.status === 'delisting').length;
    const deled = allCoins.filter(t => t.status === 'delisted').length;
    const rest = allCoins.filter(t => t.status === 'restored').length;
    const highrisk = allCoins.filter(t => (t.status === 'active' && t._risk >= 50) || t.status === 'monitoring' || t.status === 'delisting').length;

    const tabs = [
        ['active', '🟢 Active', active],
        ['highrisk', '🔴 At Risk', highrisk],
        ['monitoring', '⚠ Monitoring', mon],
        ['delisting', '🚨 Delisting', deling],
        ['restored', '✅ Restored', rest],
        ['delisted', '⬛ Delisted', deled],
        ['all', '📋 All', all],
    ];
    document.getElementById('bn-filters').innerHTML = tabs.map(([k,l,c]) =>
        \`<button class="ftab \${filter===k?'active':''}" onclick="bnSetFilter('\${k}')">\${l}<span class="cnt">\${c}</span></button>\`
    ).join('') + \`<input class="search" type="text" placeholder="Search token... ( / )" value="\${query}" oninput="bnSetQuery(this.value)">\`;
}

function renderTable() {
    const list = getFiltered();
    const today = NOW.toISOString().slice(0,10);
    const paged = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    document.getElementById('bn-tbody').innerHTML = paged.map(t => {
        const ld = liveData[t.sym] || {};
        const isTracked = !!trackedMap[t.sym];
        
        // Days on monitoring
        let domHtml = '<span class="na">—</span>';
        if (t.monDate) {
            const endDate = t.status === 'restored' ? (t.removedDate || today) : t.status === 'delisted' ? (t.delistDate || today) : today;
            const dom = daysBetween(t.monDate, endDate);
            let domClass = 'ok';
            if (dom > 90) domClass = 'over';
            else if (dom > 45) domClass = 'near';
            domHtml = \`<span class="days-ref \${domClass}">\${dom}d</span>\`;
        }

        // "NEW" label for tokens recently added to monitoring (within 30 days)
        const isNew = t.monDate && daysBetween(t.monDate, today) <= 30 && (t.status === 'monitoring' || t.status === 'delisting');
        const newBadge = isNew ? \`<span class="badge new-tag">NEW</span> \` : '';

        // Status badge
        const badges = {
            monitoring: \`\${newBadge}<span class="badge monitoring"><span class="bdot a"></span>MON</span>\`,
            delisting: \`\${newBadge}<span class="badge delisting"><span class="bdot r"></span>DELIST</span>\`,
            delisted: \`<span class="badge delisted">DELISTED</span>\`,
            restored: \`<span class="badge restored"><span class="bdot g"></span>RESTORED</span>\`,
            active: \`<span class="badge active">ACTIVE</span>\`,
        };

        // Risk score
        let riskHtml = '';
        if (t._risk != null) {
            let cls = 'safe';
            if (t._riskLabel === 'CRITICAL' || t._riskLabel === 'DELISTED') cls = 'critical';
            else if (t._riskLabel === 'HIGH') cls = 'high';
            else if (t._riskLabel === 'MEDIUM') cls = 'medium';
            else if (t._riskLabel === 'LOW') cls = 'low';

            const fillColor = cls === 'critical' ? 'var(--red)' : cls === 'high' ? '#f87171' : cls === 'medium' ? 'var(--amber)' : cls === 'low' ? '#6ee7b7' : 'var(--green)';
            riskHtml = \`<span class="risk-score \${cls}">\${t._risk}<div class="risk-bar"><div class="risk-fill" style="width:\${t._risk}%;background:\${fillColor}"></div></div></span>\`;
        }

        // Delist date
        let delistHtml = '<span class="na">—</span>';
        if (t.delistDate) {
            const dl = daysUntil(t.delistDate);
            if (dl <= 0) delistHtml = \`<span class="past">\${fmtDate(t.delistDate)}</span>\`;
            else delistHtml = \`\${fmtDate(t.delistDate)}<div class="cd" style="font-size:10px;color:var(--red)">\${dl}d left</div>\`;
        }

        // Price change
        let changeHtml = '—';
        if (ld.change !== undefined) {
            const cls = ld.change >= 0 ? 'up' : 'dn';
            changeHtml = \`<span class="pct \${cls}">\${ld.change >= 0 ? '+' : ''}\${ld.change.toFixed(2)}%</span>\`;
        }

        const rowClass = t.status === 'delisting' ? 'delisting-row' : t.status === 'delisted' ? 'delisted-row' : t.status === 'restored' ? 'restored-row' : (t.status === 'active' && t._risk >= 70) ? 'highrisk-row' : '';
        const isClickable = t.status === 'monitoring' || t.status === 'delisting';
        const domVal = t.monDate ? daysBetween(t.monDate, t.status === 'delisting' ? today : today) : null;
        if (isClickable) bnDetailStore.set(t.sym, { t, ld, dom: domVal });

        const ghIconUrl = \`https://cdn.jsdelivr.net/gh/ErikThiart/cryptocurrency-icons@master/32/\${t.sym.toLowerCase()}.png\`;
        const primaryIconUrl = ld.icon || ghIconUrl;
        const fallbackIconUrl = ld.icon ? ghIconUrl : '';
        const coinIconHtml = \`<div class="tk-ico"><img src="\${primaryIconUrl}" alt="\${t.sym}" data-fb="\${fallbackIconUrl}" loading="lazy" onerror="if(this.dataset.fb){var f=this.dataset.fb;this.dataset.fb='';this.src=f;return;}this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="coin-letter-icon" style="display:none">\${t.sym.charAt(0)}</span></div>\`;
        const bnIcon = '<img src="https://www.google.com/s2/favicons?domain=binance.com&sz=32" alt="Binance">';
        const cgIcon = '<img src="https://www.google.com/s2/favicons?domain=coingecko.com&sz=32" alt="CoinGecko">';
        const cmcIcon = '<img src="https://www.google.com/s2/favicons?domain=coinmarketcap.com&sz=32" alt="CMC">';
        const linkTitle = t.status === 'delisted' ? 'CoinGecko' : 'Binance Trade';
        const linkPrimaryIcon = t.status === 'delisted' ? cgIcon : bnIcon;
        const binanceLink = (t.status === 'delisted')
            ? 'https://www.coingecko.com/en/coins/' + (liveData[t.sym]?.cgId || t.sym.toLowerCase())
            : 'https://www.binance.com/en/trade/' + t.sym + '_USDT?type=spot';
        const cmcSlug = getCMCSlug(t.sym);
        const cmcLink = cmcSlug ? 'https://coinmarketcap.com/currencies/' + cmcSlug + '/' : '';
        const cmcHtml = cmcLink ? '<a href="' + cmcLink + '" target="_blank" title="CoinMarketCap"><img src="https://www.google.com/s2/favicons?domain=coinmarketcap.com&sz=32" alt="CMC"></a>' : '';

        const clickAttr = isClickable ? \`onclick="bnToggleDetail('\${t.sym}',this)"\` : '';
        const expandHint = isClickable ? \`<span style="float:right;font-size:9px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);opacity:0.5;margin-top:2px">▶ actions</span>\` : '';

        return \`<tr class="\${rowClass}\${isClickable?' mon-clickable':''}" \${clickAttr}>
            <td><div class="tk">\${coinIconHtml}<div><div class="tk-sym">\${t.sym}\${expandHint}</div><div class="tk-name">\${t.name||t.sym}</div><div class="tk-links"><a href="\${binanceLink}" target="_blank" title="\${linkTitle}" onclick="event.stopPropagation()">\${linkPrimaryIcon}</a>\${cmcHtml ? cmcHtml.replace('href=', 'onclick="event.stopPropagation()" href=') : ''}</div></div></div></td>
            <td>\${badges[t.status]||''}</td>
            <td>\${riskHtml}</td>
            <td class="col-days">\${domHtml}</td>
            <td class="col-mon"><span class="dt">\${t.monDate ? fmtDate(t.monDate) : '<span class="na">—</span>'}</span></td>
            <td><div class="dt">\${delistHtml}</div></td>
            <td><span class="vol">\${fmtPrice(ld.price)}</span></td>
            <td>\${changeHtml}</td>
            <td class="col-vol"><span class="vol">\${ld.vol ? fmtNum(ld.vol,1) : '—'}</span></td>
            <td class="col-mcap"><span class="mcap">\${ld.mcap ? fmtNum(ld.mcap,0) : '—'}</span></td>
            <td class="col-bid"><span class="depth">\${ld.bidDepth ? fmtNum(ld.bidDepth,0) : '—'}</span></td>
            <td class="col-ask"><span class="depth">\${ld.askDepth ? fmtNum(ld.askDepth,0) : '—'}</span></td>
            <td class="col-also">\${getExchangeIcons(t.sym)}</td>
        </tr>\`;
    }).join('');

    // Sort indicators
    document.querySelectorAll('#bn-section th[data-sort]').forEach(th => {
        th.classList.remove('sorted', 'asc-dir');
        if (th.dataset.sort === sort.key) {
            th.classList.add('sorted');
            if (sort.dir === 'asc') th.classList.add('asc-dir');
        }
    });

    // Pagination
    const total = list.length;
    const pages = Math.ceil(total / PAGE_SIZE);
    document.getElementById('bn-pagination').innerHTML = pages > 1 ? \`
        <button onclick="bnSetPage(\${page-1})" \${page===0?'disabled':''}>← Prev</button>
        <span class="pg-info">Page \${page+1} of \${pages} (\${total} tokens)</span>
        <button onclick="bnSetPage(\${page+1})" \${page>=pages-1?'disabled':''}>Next →</button>
    \` : \`<span class="pg-info">\${total} tokens</span>\`;
}

function renderTimeline() {
    const events = [];
    allCoins.filter(t => t.status === 'delisting' && t.delistDate).forEach(t => {
        const dl = daysUntil(t.delistDate);
        if (dl > 0) events.push({ date: t.delistDate, sym: t.sym, type: 'delist', days: dl });
    });
    events.sort((a,b) => a.days - b.days);

    // Group by date
    const grouped = {};
    events.forEach(e => {
        if (!grouped[e.date]) grouped[e.date] = [];
        grouped[e.date].push(e);
    });

    document.getElementById('bn-timeline').innerHTML = Object.entries(grouped).map(([date, evts]) => {
        const dl = daysUntil(date);
        const urgent = dl <= 14;
        return \`<div class="tcard \${urgent?'urgent':''}">
            <div class="tdate">\${fmtDate(date)} (\${dl}d)</div>
            <div class="tevt">Delisting \${evts.length} token\${evts.length>1?'s':''}</div>
            <div class="ttokens">\${evts.map(e => \`<span class="ttk">\${e.sym}</span>\`).join('')}</div>
        </div>\`;
    }).join('') || '<div style="color:var(--text-3);font-size:13px">No upcoming events</div>';

    document.getElementById('bn-tokenCount').textContent = allCoins.length;
}

function bnRenderAll() {
    renderStats();
    renderPredBar();
    renderFilters();
    renderTable();
    renderTimeline();
    document.getElementById('bn-updTime').textContent = new Date().toLocaleTimeString();
}

// ============ COIN DETAIL EXPAND ============
const bnDetailStore = new Map();

function bnToggleDetail(sym, rowEl) {
    const next = rowEl.nextElementSibling;
    if (next && next.classList.contains('coin-detail-row')) {
        next.remove();
        rowEl.classList.remove('expanded');
        return;
    }
    document.querySelectorAll('.coin-detail-row').forEach(r => r.remove());
    document.querySelectorAll('.mon-clickable.expanded').forEach(r => r.classList.remove('expanded'));

    const data = bnDetailStore.get(sym);
    if (!data) return;
    rowEl.classList.add('expanded');

    const { items, restoreCount } = bnBuildDetailItems(data.t, data.ld, data.dom);
    const itemsHtml = items.map(item =>
        \`<div class="cdr-item \${item.urgent?'urgent':item.ok?'good':''}">
            <div class="cdr-item-title">\${item.icon} \${item.title}</div>
            <div class="cdr-item-desc">\${item.desc}</div>
        </div>\`
    ).join('');

    const tr = document.createElement('tr');
    tr.className = 'coin-detail-row';
    tr.innerHTML = \`<td colspan="13"><div class="coin-detail-panel">
        <div class="cdr-head">
            <div class="cdr-title">📋 RECOVERY ACTIONS — \${sym}</div>
            <div style="display:flex;align-items:center;gap:8px">
                <span class="cdr-hint">click row again to close</span>
                <button class="cdr-close" onclick="event.stopPropagation();this.closest('tr').previousElementSibling.click()">✕</button>
            </div>
        </div>
        <div class="cdr-items">\${itemsHtml}</div>
        <div class="cdr-footer">💡 \${restoreCount} coins have recovered from monitoring status — consistent improvement gets results.</div>
    </div></td>\`;
    rowEl.after(tr);
}

function bnBuildDetailItems(t, ld, dom) {
    const vol = ld.vol || 0;
    const bid = ld.bidDepth;
    const mcap = ld.mcap || 0;
    const onCB  = exchangeData.coinbase.has(t.sym);
    const onOKX = exchangeData.okx.has(t.sym);
    const onKR  = exchangeData.kraken.has(t.sym);
    const crossCount = [onCB, onOKX, onKR].filter(Boolean).length;
    const restoreCount = allCoins.filter(c => c.status === 'restored').length;
    const items = [];

    // 1. Time window
    if (dom !== null && dom !== undefined) {
        if (dom < 30)        items.push({ ok:true,  icon:'🟢', title:\`\${dom}d on monitoring — still early\`,       desc:\`The 195-day median to delist means you have time. Start immediately — early consistent improvement has the highest recovery rate.\` });
        else if (dom < 90)   items.push({ ok:false, icon:'⏱',  title:\`\${dom}d on monitoring — keep up momentum\`,  desc:\`Past one month. Exchanges review tagged coins regularly. Demonstrate measurable improvement every 30 days to show a positive trend.\` });
        else if (dom < 150)  items.push({ ok:false, urgent:true, icon:'⚠️', title:\`\${dom}d — past halfway\`,       desc:\`Past the halfway point of the 195-day median. Prioritize volume and order book depth — they're the fastest metrics to visibly move.\` });
        else                 items.push({ ok:true,  icon:'💪', title:\`\${dom}d — still listed past the median\`,   desc:\`The median delist timeline is 195 days — you're past it and Binance has still kept you active. That's a signal they're watching for improvement. Keep delivering: consistent volume growth and transparent team updates now could tip the decision in your favor.\` });
    }

    // 2. Volume
    if (vol > 0) {
        if (vol < 100000)        items.push({ ok:false, urgent:true, icon:'📉', title:\`Volume critical — \${fmtNum(vol,0)}/day\`,     desc:\`Far below the $500K–$1M threshold. Priority #1. Organic community trading, ecosystem integrations, and liquidity mining can help — avoid wash trading.\` });
        else if (vol < 500000)   items.push({ ok:false, icon:'📈', title:\`Volume low — \${fmtNum(vol,0)}/day\`,                       desc:\`Below $500K. Sustained growth over weeks counts more than spikes. Target organic drivers: new exchange listings, product launches, community campaigns.\` });
        else if (vol < 1000000)  items.push({ ok:false, icon:'📈', title:\`Volume near threshold — \${fmtNum(vol,0)}/day\`,            desc:\`Getting close. Sustain $1M+ consistently for several weeks — that trend is what the exchange sees as a positive signal.\` });
        else                     items.push({ ok:true,  icon:'✅', title:\`Volume healthy — \${fmtNum(vol,0)}/day\`,                   desc:\`Strong volume. Focus on liquidity depth and cross-exchange presence as the next priorities.\` });
    }

    // 3. Order book depth
    if (bid !== undefined && bid !== null) {
        if (bid < 10000)        items.push({ ok:false, urgent:true, icon:'🔴', title:\`Order book empty — \${bid>0?fmtNum(bid,0):'$0'} bid depth\`,  desc:\`Near-empty book signals poor price discovery. Engage a professional market maker immediately — this is the fastest fix available.\` });
        else if (bid < 50000)   items.push({ ok:false, icon:'💧', title:\`Order book thin — \${fmtNum(bid,0)} bid depth\`,                           desc:\`Thin books amplify volatility and concern exchanges. A market maker providing consistent 2% depth can move this metric within days.\` });
        else                    items.push({ ok:true,  icon:'✅', title:\`Liquidity acceptable — \${fmtNum(bid,0)} bid depth\`,                       desc:\`Bid/ask depth looks reasonable. Keep it consistent and focus on volume and exchange presence.\` });
    }

    // 4. Cross-exchange presence
    if (crossCount === 0) {
        items.push({ ok:false, icon:'🌐', title:'Only on Binance',
            desc:\`Single-venue coins carry the highest delisting risk. Pursue Coinbase, OKX, or Kraken listings to demonstrate broader market demand — each listing is evidence in your favor.\` });
    } else if (crossCount < 3) {
        const have = [onCB&&'Coinbase',onOKX&&'OKX',onKR&&'Kraken'].filter(Boolean).join(', ');
        const missing = [!onCB&&'Coinbase',!onOKX&&'OKX',!onKR&&'Kraken'].filter(Boolean);
        items.push({ ok:false, icon:'🌐', title:\`Listed on \${crossCount} other exchange\${crossCount>1?'s':''}\`,
            desc:\`On \${have}. Adding \${missing[0]} would strengthen your multi-venue case. Use this in exchange communications as proof of market demand.\` });
    } else {
        items.push({ ok:true, icon:'✅', title:'Strong cross-exchange presence',
            desc:\`Listed on Coinbase, OKX, and Kraken — excellent. Mention this prominently in any exchange appeal or status update submission.\` });
    }

    // 5. Market cap context (only flag if very low)
    if (mcap > 0 && mcap < 5000000) {
        items.push({ ok:false, icon:'💎', title:\`Market cap low — \${fmtNum(mcap,0)}\`,
            desc:\`Low market cap signals limited adoption. Prioritize demonstrating real utility: DeFi integrations, active on-chain usage, and meaningful partnerships help build organic value.\` });
    }

    // 6. Project-specific resources (positive signals already in place)
    if (t.resources && t.resources.length > 0) {
        t.resources.forEach(r => {
            items.push({ ok:true, icon:'🔗', title:\`✅ \${r.label}\`,
                desc:\`\${r.note} — <a href="\${r.url}" target="_blank" style="color:#4ade80;text-decoration:underline">\${r.url.replace('https://','')}</a>\` });
        });
    }

    return { items, restoreCount };
}

// ============ INTERACTIONS ============
function bnSortBy(key) {
    if (sort.key === key) sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
    else { sort.key = key; sort.dir = 'desc'; }
    page = 0;
    renderTable();
}
function bnSetFilter(f) {
    filter = f;
    page = 0;
    bnRenderAll();
    const guide = document.getElementById('bn-recovery-guide');
    if (guide) {
        const show = (f === 'monitoring' || f === 'highrisk');
        guide.classList.toggle('visible', show);
        if (show) {
            // populate restore rate stat from live data
            const mon = allCoins.filter(t => t.status === 'monitoring').length;
            const rest = allCoins.filter(t => t.status === 'restored').length;
            const everTagged = allCoins.filter(t => t.monDate).length;
            const rateEl = document.getElementById('bn-restore-rate');
            if (rateEl && everTagged > 0) {
                const pct = Math.round(rest / everTagged * 100);
                rateEl.textContent = \`\${pct}% of tagged coins restored\`;
            }
        }
    }
}
function bnSetQuery(q) { query = q; page = 0; renderTable(); }
function bnSetPage(p) { page = Math.max(0, p); renderTable(); window.scrollTo({top: document.querySelector('.tbl-wrap').offsetTop - 80, behavior:'smooth'}); }

async function bnDoRefresh() {
    const btn = document.getElementById('bn-refreshBtn');
    btn.classList.add('spinning');
    // Don't clear liveData - keep old data as fallback if refresh fails
    await fetchAllData();
    btn.classList.remove('spinning');
    window._lastRefresh = Date.now();
}

// ============ INIT ============
window.bnInit = fetchAllData; bnInitialized = false;
setInterval(bnDoRefresh, 5 * 60 * 1000); // Auto-refresh every 5 min

// Countdown timer
setInterval(() => {
    const el = document.getElementById('bn-refreshTimer');
    if (!el) return;
    const elapsed = (Date.now() - (window._lastRefresh || Date.now())) / 1000;
    const remaining = Math.max(0, 300 - elapsed);
    el.textContent = \`next: \${Math.floor(remaining/60)}:\${String(Math.floor(remaining%60)).padStart(2,'0')}\`;
}, 1000);
window._lastRefresh = Date.now();

// Export needed functions to global scope
window.bnSetFilter = bnSetFilter;
window.bnSortBy = bnSortBy;
window.bnSetQuery = bnSetQuery;
window.bnSetPage = bnSetPage;
window.bnDoRefresh = bnDoRefresh;
window.bnToggleDetail = bnToggleDetail;

})();

// ===== COINBASE MODULE =====
let cbInitialized = false;
(function() {
// ===== STATE =====
const PAGE_SIZE = 50;
let allCoins = [];
let liveData = {}; // sym -> {price, change, vol, mcap, icon, cgId, bidDepth, askDepth}
let exchangeData = { binance: new Set(), okx: new Set(), kraken: new Set() };
let filter = 'all', sortCol = 'risk', sortAsc = false, page = 0, query = '';
let lastRefresh = 0;

const EXCLUDE = new Set([
    // Stablecoins
    'USDC','USDT','DAI','USDS','USD1','EURC','AUDD','XSGD','PAX','PYUSD','GUSD','GYEN','MUSD','BUSD',
    // Blue chip coins — never at delisting risk on Coinbase
    'BTC','ETH','SOL','XRP','ADA','DOGE','DOT','SHIB','LTC','AVAX',
    'LINK','ATOM','TON','UNI','XLM','BCH','NEAR','APT','ICP','OP',
    'ARB','ETC','HBAR','FIL','VET','STX','SUI','SEI','TIA','INJ',
    'RNDR','FET','AAVE','MKR','COMP','SNX','CRV','1INCH','LDO','GRT',
    'ENS','THETA','ALGO','EOS','XTZ','SAND','MANA','AXS','GALA']);

// CoinGecko ID overrides
const CG_OVERRIDES = {
    'CGLD':'celo','COSMOSDYDX':'dydx-chain','LSETH':'liquid-staked-ethereum','CBETH':'coinbase-wrapped-staked-eth',
    'MSOL':'msol','JITOSOL':'jito-staked-sol','POL':'polygon-ecosystem-token','RENDER':'render-token',
    'FET':'artificial-superintelligence-alliance','BERA':'berachain','HYPE':'hyperliquid','PEPE':'pepe',
    'BONK':'bonk','WIF':'dogwifcoin','FLOKI':'floki','SHIB':'shiba-inu','DOGE':'dogecoin','SOL':'solana',
    'ETH':'ethereum','BTC':'bitcoin','ADA':'cardano','DOT':'polkadot','LINK':'chainlink','AVAX':'avalanche-2',
    'ATOM':'cosmos','NEAR':'near','ICP':'internet-computer','FIL':'filecoin','ARB':'arbitrum','OP':'optimism',
    'SUI':'sui','SEI':'sei-network','TIA':'celestia','INJ':'injective-protocol','STX':'blockstack',
    'TAO':'bittensor','XLM':'stellar','ALGO':'algorand','HBAR':'hedera-hashgraph','VET':'vechain',
    'ETC':'ethereum-classic','BCH':'bitcoin-cash','LTC':'litecoin','CRO':'crypto-com-chain','GRT':'the-graph',
    'IMX':'immutable-x','SAND':'the-sandbox','MANA':'decentraland','APE':'apecoin','AXS':'axie-infinity',
    'AAVE':'aave','SNX':'havven','CRV':'curve-dao-token','COMP':'compound-governance-token','UNI':'uniswap',
    'LDO':'lido-dao','ENS':'ethereum-name-service','BNB':'binancecoin','ONDO':'ondo-finance',
    'TRUMP':'official-trump','JASMY':'jasmycoin','KSM':'kusama','FLOW':'flow','EGLD':'elrond-erd-2',
    'DASH':'dash','MINA':'mina-protocol','RSR':'reserve-rights-token','SKL':'skale','ANKR':'ankr',
    'STORJ':'storj','COTI':'coti','CHZ':'chiliz','BAT':'basic-attention-token','PAXG':'pax-gold',
    'QNT':'quant-network','SPELL':'spell-token','S':'sonic-3','IP':'story-protocol','PENGU':'pudgy-penguins',
    'FARTCOIN':'fartcoin','SPX':'spx6900','MOG':'mog-coin','GIGA':'gigachad-2','POPCAT':'popcat',
    'WLD':'worldcoin-wld','ENA':'ethena','STRK':'starknet','W':'wormhole','PYTH':'pyth-network',
    'JTO':'jito-governance-token','JUPITER':'jupiter-exchange-solana','FUN1':'funfair','EIGEN':'eigenlayer',
    'MORPHO':'morpho','KAITO':'kaito','TON':'the-open-network','HNT':'helium','PENDLE':'pendle',
    'ACH':'alchemy-pay','GLM':'golem','NKN':'nkn','OXT':'orchid-protocol','AMP':'amp-token',
    'ROSE':'oasis-network','FLR':'flare-networks','KAVA':'kava','XCN':'onyxcoin','BLZ':'bluzelle',
    'DNT':'district0x','CTSI':'cartesi','RLC':'iexec-rlc','OGN':'origin-protocol','REQ':'request-network',
    'NMR':'numeraire','PERP':'perpetual-protocol','SUSHI':'sushi','BNT':'bancor','KNC':'kyber-network-crystal',
    'LPT':'livepeer','BAL':'balancer','FARM':'harvest-finance','MLN':'melon','RPL':'rocket-pool',
    'CVX':'convex-finance','T':'threshold-network-token','LQTY':'liquity','FORTH':'ampleforth-governance-token',
    'LRC':'loopring','GTC':'gitcoin','OCEAN':'ocean-protocol','IDEX':'idex',
    // Additional Coinbase coins
    'XRP':'ripple','ZRX':'0x','BAT':'basic-attention-token','MKR':'maker','ZEC':'zcash',
    'XTZ':'tezos','BAND':'band-protocol','OMG':'omisego','OGN':'origin-protocol',
    'SUSHI':'sushi','UMA':'uma','YFI':'yearn-finance','YFII':'yfii','COMP':'compound-governance-token',
    'REN':'republic-protocol','CVC':'civic','WBTC':'wrapped-bitcoin','RUNE':'thorchain',
    'AUDIO':'audius','ANC':'anchor-protocol','ALICE':'my-neighbor-alice','CELR':'celer-network',
    'CLV':'clover-finance','CTX':'cryptex-finance','DYDX':'dydx-chain','ERN':'ethernity-chain',
    'POND':'marlin','QUICK':'quickswap','SHPING':'shping','WCFG':'wrapped-centrifuge',
    'BTRST':'braintrust','AGLD':'adventure-gold','RBN':'ribbon-finance','UNFI':'unifi-protocol-dao',
    'GODS':'gods-unchained','ARPA':'arpa-chain','DREP':'drep-new','TVK':'terra-virtua-kolect',
    'DEXT':'dextools','POLS':'polkastarter','XYO':'xyo-network','SUPER':'superfarm',
    'FLY':'franklin','BOBA':'boba-network','RARE':'superrare','POWR':'power-ledger',
    'GNS':'gains-network','SYN':'synapse-2','COVAL':'circuits-of-value',
    'MAGIC':'magic','DYP':'defi-yield-protocol','FORT':'forta',
    'STPT':'stp-network','VELO':'velo','LCNX':'lightcoin','BLUR':'blur',
    'PRIME':'echelon-prime','ZETA':'zetachain','PYUSD':'paypal-usd',
};

function getCgId(sym) { return CG_OVERRIDES[sym] || sym.toLowerCase(); }
function getCmcSlug(sym) {
    // 1. Use CoinGecko ID from API (correct after data loads) with CG→CMC corrections
    const cgId = liveData[sym]?.cgId;
    if (cgId) return CG_TO_CMC[cgId] || cgId;
    // 2. Use static CG override with corrections
    const staticCgId = CG_OVERRIDES[sym];
    if (staticCgId) return CG_TO_CMC[staticCgId] || staticCgId;
    // 3. Unknown — return null so caller skips CMC link
    return null;
}

// ===== FORMAT =====
function fmtNum(n, d) {
    if (!n || n === 0) return '\\u2014';
    if (n >= 1e12) return '$' + (n/1e12).toFixed(2) + 'T';
    if (n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n/1e3).toFixed(d) + 'K';
    return '$' + n.toFixed(d);
}
function fmtPrice(p) {
    if (!p || p === 0) return '\\u2014';
    if (p >= 1000) return '$' + p.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    if (p >= 1) return '$' + p.toFixed(4);
    if (p >= 0.01) return '$' + p.toFixed(6);
    if (p >= 0.0001) return '$' + p.toFixed(8);
    const s = p.toFixed(20), m = s.match(/0\\.(0*)/), z = m ? m[1].length : 0;
    if (z >= 4) return '$0.0{' + z + '}' + s.slice(z+2, z+6);
    return '$' + p.toPrecision(4);
}

// ===== DATA PROCESSING =====
function processProducts(products, stats) {
    const map = {};
    for (const p of products) {
        const base = p.base_currency;
        if (EXCLUDE.has(base)) continue;
        if (!map[base]) map[base] = { sym: base, status: 'delisted', limitOnly: false, pairs: [], pairsOnline: 0, pairsDelisted: 0 };
        const c = map[base];
        c.pairs.push(p.id);
        if (p.status === 'online') {
            c.status = 'online';
            c.pairsOnline++;
            if (p.limit_only) c.limitOnly = true;
        } else c.pairsDelisted++;

        // Get USD stats
        const st = stats[p.id];
        if (st && p.quote_currency === 'USD') {
            const s24 = st.stats_24hour || {};
            if (!liveData[base]) liveData[base] = {};
            const ld = liveData[base];
            const price = parseFloat(s24.last || s24.open || '0');
            const open = parseFloat(s24.open || '0');
            const vol = parseFloat(s24.volume || '0') * price;
            if (price) ld.price = price;
            if (open && price) ld.change = ((price - open) / open) * 100;
            if (vol) ld.vol = (ld.vol || 0) + vol;
        } else if (st && p.quote_currency === 'USDT' && !liveData[base]?.price) {
            const s24 = st.stats_24hour || {};
            if (!liveData[base]) liveData[base] = {};
            const price = parseFloat(s24.last || s24.open || '0');
            const open = parseFloat(s24.open || '0');
            if (price) liveData[base].price = price;
            if (open && price) liveData[base].change = ((price - open) / open) * 100;
        }
    }
    return Object.values(map);
}

function calcRisk(c) {
    if (c.status === 'delisted') return 100;
    if (c.limitOnly) return 85;
    let r = 0;
    const ld = liveData[c.sym] || {};
    const vol = ld.vol || 0;
    if (vol < 1000) r += 40; else if (vol < 10000) r += 30; else if (vol < 50000) r += 20;
    else if (vol < 200000) r += 10; else if (vol < 1000000) r += 5;
    const mc = ld.mcap || 0;
    if (mc > 0) { if (mc < 1e6) r += 25; else if (mc < 1e7) r += 15; else if (mc < 5e7) r += 10; else if (mc < 2e8) r += 5; }
    else r += 10;
    let ex = 0;
    if (exchangeData.binance.has(c.sym)) ex++;
    if (exchangeData.okx.has(c.sym)) ex++;
    if (exchangeData.kraken.has(c.sym)) ex++;
    if (ex === 0) r += 15; else if (ex === 1) r += 5;
    if (c.pairsOnline > 0 && c.pairsDelisted > 0 && c.pairsDelisted / (c.pairsOnline + c.pairsDelisted) > 0.5) r += 10;
    return Math.min(r, 99);
}
function riskLabel(s) { return s >= 80 ? 'critical' : s >= 60 ? 'high' : s >= 40 ? 'medium' : s >= 20 ? 'low' : 'safe'; }
function riskColor(s) { return s >= 80 ? 'var(--red)' : s >= 60 ? '#f87171' : s >= 40 ? 'var(--amber)' : s >= 20 ? '#6ee7b7' : 'var(--green)'; }

// ===== EXCHANGE ICONS =====
function getExchangeIcons(sym) {
    const icons = [];
    if (exchangeData.binance.has(sym)) icons.push('<a href="https://www.binance.com/en/trade/' + sym + '_USDT" target="_blank" title="Binance"><img src="https://www.google.com/s2/favicons?domain=binance.com&sz=32" alt="Binance"></a>');
    if (exchangeData.okx.has(sym)) icons.push('<a href="https://www.okx.com/trade-spot/' + sym.toLowerCase() + '-usdt" target="_blank" title="OKX"><img src="https://www.google.com/s2/favicons?domain=okx.com&sz=32" alt="OKX"></a>');
    if (exchangeData.kraken.has(sym)) icons.push('<a href="https://www.kraken.com/prices/' + sym.toLowerCase() + '" target="_blank" title="Kraken"><img src="https://www.google.com/s2/favicons?domain=kraken.com&sz=32" alt="KR"></a>');
    return icons.length ? '<div class="ex-icons">' + icons.join('') + '</div>' : '<span class="na" style="color:var(--text-3)">\\u2014</span>';
}

// ===== RENDER =====
function getFiltered() {
    let list = [...allCoins];
    if (filter === 'online') list = list.filter(c => c.status === 'online' && !c.limitOnly);
    else if (filter === 'limit') list = list.filter(c => c.limitOnly);
    else if (filter === 'delisted') list = list.filter(c => c.status === 'delisted');
    else if (filter === 'highrisk') list = list.filter(c => (c._risk >= 50 || c.limitOnly) && c.status !== 'delisted');
    if (query) { const q = query.toLowerCase(); list = list.filter(c => c.sym.toLowerCase().includes(q)); }
    // Status priority: online=0, limit-only=1, delisted=2
    const cbStatusOrder = c => c.status === 'delisted' ? 2 : c.limitOnly ? 1 : 0;
    list.sort((a, b) => {
        // Primary: group by status (online first, delisted last)
        const sa = cbStatusOrder(a), sb = cbStatusOrder(b);
        if (sa !== sb) return sa - sb;
        // Secondary: user-selected sort
        const la = liveData[a.sym] || {}, lb = liveData[b.sym] || {};
        let va, vb;
        switch (sortCol) {
            case 'symbol': va = a.sym; vb = b.sym; return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
            case 'status': return 0;
            case 'price': va = la.price||0; vb = lb.price||0; break;
            case 'change': va = la.change||0; vb = lb.change||0; break;
            case 'vol': va = la.vol||0; vb = lb.vol||0; break;
            case 'mcap': va = la.mcap||0; vb = lb.mcap||0; break;
            case 'risk': va = a._risk||0; vb = b._risk||0; break;
            case 'bidDepth': va = la.bidDepth||0; vb = lb.bidDepth||0; break;
            case 'askDepth': va = la.askDepth||0; vb = lb.askDepth||0; break;
            default: va = a._risk||0; vb = b._risk||0;
        }
        return sortAsc ? va - vb : vb - va;
    });
    return list;
}

function cbRenderAll() {
    const list = getFiltered();
    const pages = Math.ceil(list.length / PAGE_SIZE);
    if (page >= pages) page = Math.max(0, pages - 1);
    const slice = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const cbIcon = '<img src="https://www.google.com/s2/favicons?domain=coinbase.com&sz=32" alt="CB">';
    const cmcIcon = '<img src="https://www.google.com/s2/favicons?domain=coinmarketcap.com&sz=32" alt="CMC">';
    const cgIcon = '<img src="https://www.google.com/s2/favicons?domain=coingecko.com&sz=32" alt="CG">';

    document.getElementById('cb-tBody').innerHTML = slice.map(c => {
        const ld = liveData[c.sym] || {};
        const rl = riskLabel(c._risk);
        const rc = riskColor(c._risk);
        const ghIconUrlCb = \`https://cdn.jsdelivr.net/gh/ErikThiart/cryptocurrency-icons@master/32/\${c.sym.toLowerCase()}.png\`;
        const primaryIconUrlCb = ld.icon || ghIconUrlCb;
        const fallbackIconUrlCb = ld.icon ? ghIconUrlCb : '';
        const coinIconHtmlCb = \`<div class="tk-ico"><img src="\${primaryIconUrlCb}" alt="\${c.sym}" data-fb="\${fallbackIconUrlCb}" loading="lazy" onerror="if(this.dataset.fb){var f=this.dataset.fb;this.dataset.fb='';this.src=f;return;}this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="coin-letter-icon" style="display:none">\${c.sym.charAt(0)}</span></div>\`;
        const cgId = ld.cgId || getCgId(c.sym);
        const cmcSlug = getCmcSlug(c.sym);

        // Links
        const cbLink = c.status === 'delisted' ? \`https://www.coingecko.com/en/coins/\${cgId}\` : \`https://www.coinbase.com/price/\${c.sym.toLowerCase()}\`;
        const primaryIcon = c.status === 'delisted' ? cgIcon : cbIcon;
        const cmcHtml = cmcSlug ? \`<a href="https://coinmarketcap.com/currencies/\${cmcSlug}/" target="_blank" title="CoinMarketCap">\${cmcIcon}</a>\` : '';

        // Status badge
        let badge;
        if (c.status === 'delisted') badge = '<span class="badge delisted">DELISTED</span>';
        else if (c.limitOnly) badge = '<span class="badge limit"><span class="bdot a"></span>LIMIT</span>';
        else badge = '<span class="badge online"><span class="bdot g"></span>ONLINE</span>';

        // Risk
        const riskHtml = \`<span class="risk-score \${rl}">\${c._risk}<div class="risk-bar"><div class="risk-fill" style="width:\${c._risk}%;background:\${rc}"></div></div></span>\`;

        // Change
        let changeHtml = '\\u2014';
        if (ld.change !== undefined && ld.change !== null) {
            const cls = ld.change >= 0 ? 'up' : 'dn';
            changeHtml = \`<span class="pct \${cls}">\${ld.change >= 0 ? '+' : ''}\${ld.change.toFixed(2)}%</span>\`;
        }

        const rowClass = c.status === 'delisted' ? 'delisted-row' : c.limitOnly ? 'limit-row' : (c._risk >= 60 ? 'highrisk-row' : '');

        return \`<tr class="\${rowClass}">
            <td><div class="tk">\${coinIconHtmlCb}<div><div class="tk-sym">\${c.sym}</div><div class="tk-name">\${c.pairs.length} pair\${c.pairs.length > 1 ? 's' : ''}</div><div class="tk-links"><a href="\${cbLink}" target="_blank" title="\${c.status==='delisted'?'CoinGecko':'Coinbase'}">\${primaryIcon}</a>\${cmcHtml}</div></div></div></td>
            <td>\${badge}</td>
            <td>\${riskHtml}</td>
            <td><span class="vol">\${fmtPrice(ld.price)}</span></td>
            <td>\${changeHtml}</td>
            <td class="col-vol"><span class="vol">\${ld.vol ? fmtNum(ld.vol,1) : '\\u2014'}</span></td>
            <td class="col-mcap"><span class="mcap">\${ld.mcap ? fmtNum(ld.mcap,0) : '\\u2014'}</span></td>
            <td class="col-bid"><span class="depth">\${ld.bidDepth ? fmtNum(ld.bidDepth,0) : '\\u2014'}</span></td>
            <td class="col-ask"><span class="depth">\${ld.askDepth ? fmtNum(ld.askDepth,0) : '\\u2014'}</span></td>
            <td class="col-also">\${getExchangeIcons(c.sym)}</td>
        </tr>\`;
    }).join('');

    // Pagination
    document.getElementById('cb-pagination').innerHTML = pages > 1 ? \`
        <button onclick="cbSetPage(\${page-1})" \${page===0?'disabled':''}>← Prev</button>
        <span>\${page+1} / \${pages} (\${list.length} coins)</span>
        <button onclick="cbSetPage(\${page+1})" \${page>=pages-1?'disabled':''}>Next →</button>
    \` : \`<span>\${list.length} coins</span>\`;

    // Sort indicators
    document.querySelectorAll('#cb-section th[data-sort]').forEach(th => {
        th.classList.remove('sorted', 'asc-dir');
        if (th.dataset.sort === sortCol) {
            th.classList.add('sorted');
            if (sortAsc) th.classList.add('asc-dir');
        }
    });

    // Update stats
    const online = allCoins.filter(c => c.status === 'online' && !c.limitOnly);
    const limit = allCoins.filter(c => c.limitOnly);
    const delisted = allCoins.filter(c => c.status === 'delisted');
    const highrisk = allCoins.filter(c => c._risk >= 60 && c.status !== 'delisted');
    document.getElementById('cb-sOnline').textContent = online.length;
    document.getElementById('cb-sLimit').textContent = limit.length;
    document.getElementById('cb-sDelisted').textContent = delisted.length;
    document.getElementById('cb-sTotal').textContent = allCoins.length;
    document.getElementById('cb-sHighRisk').textContent = highrisk.length;
    document.getElementById('cb-sPairs').textContent = allCoins.reduce((s, c) => s + c.pairsOnline, 0);
    document.getElementById('cb-cAll').textContent = allCoins.length;
    document.getElementById('cb-cOnline').textContent = online.length;
    document.getElementById('cb-cLimit').textContent = limit.length;
    document.getElementById('cb-cDelisted').textContent = delisted.length;
    document.getElementById('cb-cHighRisk').textContent = highrisk.length;
}

// ===== CONTROLS =====
function cbSetFilter(f) { filter = f; page = 0; document.querySelectorAll('#cb-section .ftab').forEach(b => b.classList.toggle('active', b.dataset.f === f)); cbRenderAll(); }
function cbSortBy(col) { if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = col === 'symbol'; } cbRenderAll(); }
function cbSetQuery(q) { query = q; page = 0; cbRenderAll(); }
function cbSetPage(p) { page = Math.max(0, p); cbRenderAll(); window.scrollTo({top: document.querySelector('#cb-section .tbl-wrap').offsetTop - 80, behavior:'smooth'}); }

// ===== FETCHERS =====
async function fetchExchanges() {
    for (const ex of ['binance', 'okx', 'kraken']) {
        try {
            const r = await fetch('/ex/' + ex);
            const d = await r.json();
            if (ex === 'binance') {
                (d.symbols || []).forEach(s => { if (s.status === 'TRADING' && s.quoteAsset === 'USDT') exchangeData.binance.add(s.baseAsset); });
            } else if (ex === 'okx') {
                ((d.data || d) || []).forEach(s => { if (s.instId?.endsWith('-USDT') && s.state === 'live') exchangeData.okx.add(s.instId.split('-')[0]); });
            } else if (ex === 'kraken') {
                Object.values(d.result || {}).forEach(p => { if (p.wsname) exchangeData.kraken.add(p.wsname.split('/')[0]); });
            }
        } catch(e) {}
    }
}

async function fetchDepth(sym) {
    try {
        const r = await fetch(\`/cb/products/\${sym}-USD/book?level=2\`);
        if (!r.ok) return;
        const d = await r.json();
        if (!liveData[sym]) liveData[sym] = {};
        const price = liveData[sym].price || 0;
        if (!price) return;
        const low = price * 0.98, high = price * 1.02;
        let bidSum = 0, askSum = 0;
        (d.bids || []).forEach(([p, s]) => { const px = parseFloat(p); if (px >= low) bidSum += px * parseFloat(s); });
        (d.asks || []).forEach(([p, s]) => { const px = parseFloat(p); if (px <= high) askSum += px * parseFloat(s); });
        liveData[sym].bidDepth = bidSum;
        liveData[sym].askDepth = askSum;
    } catch(e) {}
}

async function fetchCoinGeckoData() {
    try {
        const getGeckoId = sym => CG_OVERRIDES[sym] || sym.toLowerCase();

        // Batch fetch from CoinGecko markets API
        const activeSyms = allCoins.filter(c => c.status !== 'delisted').map(c => c.sym);
        const batches = [];
        for (let i = 0; i < activeSyms.length; i += 100) batches.push(activeSyms.slice(i, i + 100));

        for (const batch of batches) {
            const ids = batch.map(getGeckoId).join(',');
            try {
                const resp = await fetch(\`/cg/coins/markets?vs_currency=usd&ids=\${ids}&per_page=250\`);
                if (!resp.ok) continue;
                const data = await resp.json();
                data.forEach(coin => {
                    const sym = batch.find(s => getGeckoId(s) === coin.id);
                    if (sym) {
                        if (!liveData[sym]) liveData[sym] = {};
                        liveData[sym].mcap = coin.market_cap || coin.fully_diluted_valuation || 0;
                        if (coin.image) liveData[sym].icon = coin.image;
                        if (coin.id) liveData[sym].cgId = coin.id;
                    }
                });
            } catch(e) {}
            await new Promise(r => setTimeout(r, 200));
        }

        // Recompute risks with mcap data
        allCoins.forEach(c => c._risk = calcRisk(c));
        cbRenderAll();
    } catch(e) { console.error('CG error:', e); }
}

async function fetchDepthBatch() {
    // Fetch depth for top risk coins (non-delisted, risk >= 30)
    const targets = allCoins.filter(c => c.status !== 'delisted' && c._risk >= 30 && liveData[c.sym]?.price).map(c => c.sym);
    for (const sym of targets.slice(0, 40)) {
        await fetchDepth(sym);
        await new Promise(r => setTimeout(r, 200));
    }
    cbRenderAll();
}

async function cbDoRefresh() {
    const btn = document.getElementById('cb-refreshBtn');
    btn.classList.add('spinning');
    try {
        const [products, stats] = await Promise.all([
            fetchWithTimeout('/cb/products', 20000),
            fetchWithTimeout('/cb/products/stats', 20000),
        ]);
        if (products.length > 0) {
            allCoins = processProducts(products, stats);
            allCoins.forEach(c => c._risk = calcRisk(c));
            cbRenderAll();
            lastRefresh = Date.now();
            document.getElementById('cb-updTime').textContent = 'updated ' + new Date().toLocaleTimeString();
        }
    } catch(e) { console.error('[CB] refresh error:', e); }
    btn.classList.remove('spinning');
}

// ===== INIT =====
// Timeout wrapper for fetch
function fetchWithTimeout(url, ms = 15000) {
    return Promise.race([
        fetch(url).then(r => r.json()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + url)), ms))
    ]);
}

async function init() {
    console.log('[CB] init starting');
    let products = [], stats = {};
    
    try {
        [products, stats] = await Promise.all([
            fetchWithTimeout('/cb/products', 20000),
            fetchWithTimeout('/cb/products/stats', 20000),
        ]);
        console.log('[CB] fetched', products.length, 'products');
    } catch(e) {
        console.error('[CB] fetch error:', e);
        // Try products alone
        try {
            products = await fetchWithTimeout('/cb/products', 20000);
            console.log('[CB] fetched products only:', products.length);
        } catch(e2) {
            console.error('[CB] products fetch also failed:', e2);
        }
    }
    
    // Don't block on exchange data
    fetchExchanges().catch(e => console.error('[CB] exchanges error:', e));

    if (products.length > 0) {
        allCoins = processProducts(products, stats);
        allCoins.forEach(c => c._risk = calcRisk(c));
        cbRenderAll();
        lastRefresh = Date.now();
        document.getElementById('cb-updTime').textContent = 'updated ' + new Date().toLocaleTimeString();
        console.log('[CB] rendered', allCoins.length, 'coins');
    } else {
        console.error('[CB] no products to render');
    }

    document.getElementById('cb-loader').style.display = 'none';

    // Background enrichment
    fetchCoinGeckoData();
    fetchDepthBatch();

    // Auto-refresh every 3 min
    setInterval(cbDoRefresh, 180000);
    setInterval(() => {
        if (lastRefresh) {
            const rem = Math.max(0, 180 - Math.floor((Date.now() - lastRefresh) / 1000));
            const m = Math.floor(rem / 60), s = rem % 60;
            document.getElementById('cb-refreshTimer').textContent = \`next: \${m}:\${String(s).padStart(2, '0')}\`;
        }
    }, 1000);
}

window.cbInit = async function() { try { await init(); } catch(e) { console.error("CB INIT ERROR:", e); document.getElementById("cb-loader").classList.add("hidden"); } }; cbInitialized = false;

window.cbSetFilter = cbSetFilter;
window.cbSortBy = cbSortBy;
window.cbSetQuery = cbSetQuery;
window.cbSetPage = cbSetPage;
window.cbDoRefresh = cbDoRefresh;
})();

// ===== STABLECOIN MODULE =====
let scInitialized = false;
(function() {
const SC_HARDCODED = [
  { llamaId:'1',  sym:'USDT',  name:'Tether',           cgId:'tether',               mech:'fiat', chains_hint:20, icon:'https://coin-images.coingecko.com/coins/images/325/small/Tether.png',    exchanges:['binance','coinbase','kraken','okx','bybit','bitfinex','kucoin','gate'] },
  { llamaId:'2',  sym:'USDC',  name:'USD Coin',          cgId:'usd-coin',             mech:'fiat', chains_hint:15, icon:'https://coin-images.coingecko.com/coins/images/6319/small/usdc.png',      exchanges:['binance','coinbase','kraken','okx','bybit','kucoin','bitget'] },
  { llamaId:'4',  sym:'DAI',   name:'Dai',               cgId:'dai',                  mech:'cdp',  chains_hint:12, icon:'https://coin-images.coingecko.com/coins/images/9956/small/Badge_Dai.png', exchanges:['coinbase','kraken','binance','okx','kucoin','gate'] },
  { llamaId:'149',sym:'USDE',  name:'USDe',              cgId:'ethena-usde',          mech:'cdp',  chains_hint:5,  icon:'https://coin-images.coingecko.com/coins/images/33613/small/USDE.png',     exchanges:['binance','okx','bybit','kucoin','bitget'] },
  { llamaId:'161',sym:'FDUSD', name:'First Digital USD', cgId:'first-digital-usd',   mech:'fiat', chains_hint:3,  icon:'https://coin-images.coingecko.com/coins/images/31079/small/firstfigital.png', exchanges:['binance'] },
  { llamaId:'5',  sym:'FRAX',  name:'Frax',              cgId:'frax',                 mech:'algo', chains_hint:12, icon:'https://coin-images.coingecko.com/coins/images/13422/small/FRAX_icon.png', exchanges:['okx','gate','kucoin'] },
  { llamaId:'6',  sym:'TUSD',  name:'TrueUSD',           cgId:'true-usd',             mech:'fiat', chains_hint:5,  icon:'https://coin-images.coingecko.com/coins/images/3449/small/tusd.png',       exchanges:['binance','okx','kucoin','gate'] },
  { llamaId:'146',sym:'PYUSD', name:'PayPal USD',        cgId:'paypal-usd',           mech:'fiat', chains_hint:2,  icon:'https://coin-images.coingecko.com/coins/images/31212/small/PYUSD.png',     exchanges:['coinbase','kraken'] },
  { llamaId:'8',  sym:'USDD',  name:'USDD',              cgId:'usdd',                 mech:'algo', chains_hint:4,  icon:'https://coin-images.coingecko.com/coins/images/25380/small/USDD.png',      exchanges:['bybit','okx','kucoin','gate','bitget'] },
  { llamaId:'7',  sym:'USDP',  name:'Pax Dollar',        cgId:'paxos-standard',       mech:'fiat', chains_hint:2,  icon:'https://coin-images.coingecko.com/coins/images/6013/small/Pax_Dollar.png', exchanges:['kraken','bitfinex'] },
  { llamaId:'9',  sym:'GUSD',  name:'Gemini Dollar',     cgId:'gemini-dollar',        mech:'fiat', chains_hint:2,  icon:'https://coin-images.coingecko.com/coins/images/5992/small/gemini-dollar-gusd.png', exchanges:['kraken','bitfinex'] },
  { llamaId:'11', sym:'LUSD',  name:'Liquity USD',       cgId:'liquity-usd',          mech:'cdp',  chains_hint:3,  icon:'https://coin-images.coingecko.com/coins/images/14666/small/Group_3.png',   exchanges:['kraken','kucoin','gate'] },
  { llamaId:'133',sym:'GHO',   name:'GHO',               cgId:'gho',                  mech:'cdp',  chains_hint:2,  icon:'https://coin-images.coingecko.com/coins/images/30663/small/gho-token-logo.png', exchanges:['kraken','okx'] },
  { llamaId:'132',sym:'crvUSD',name:'Curve USD',         cgId:'crvusd',               mech:'cdp',  chains_hint:1,  icon:'https://coin-images.coingecko.com/coins/images/30118/small/crvusd.png',    exchanges:['okx','gate'] },
  { llamaId:'10', sym:'sUSD',  name:'Synthetix USD',     cgId:'nusd',                 mech:'cdp',  chains_hint:2,  icon:'https://coin-images.coingecko.com/coins/images/5013/small/sUSD.png',       exchanges:['kraken','kucoin'] },
  { llamaId:'12', sym:'MIM',   name:'Magic Internet $',  cgId:'magic-internet-money', mech:'cdp',  chains_hint:7,  icon:'https://coin-images.coingecko.com/coins/images/16786/small/mimlogopng.png', exchanges:['gate','kucoin'] },
  { llamaId:'3',  sym:'BUSD',  name:'Binance USD',       cgId:'binance-usd',          mech:'fiat', chains_hint:3,  icon:'https://coin-images.coingecko.com/coins/images/9576/small/BUSD.png',       exchanges:['binance'] },
  { llamaId:'15', sym:'UST',   name:'TerraUSD (Classic)',cgId:'terrausd',             mech:'algo', chains_hint:2, depegged:true, icon:'https://coin-images.coingecko.com/coins/images/21150/small/UST.png', exchanges:[] },
  { llamaId:'23', sym:'EURS',  name:'STASIS EURO',       cgId:'stasis-eurs',          mech:'fiat', chains_hint:2,  icon:'https://coin-images.coingecko.com/coins/images/5164/small/EURS_300x300.png', exchanges:['kraken','bitfinex','gate'] },
  { llamaId:'29', sym:'EURT',  name:'Euro Tether',       cgId:'tether-eurt',          mech:'fiat', chains_hint:2,  icon:'https://coin-images.coingecko.com/coins/images/17385/small/Tether_logo.png', exchanges:['kraken','bitfinex'] },
];
const SC_CHAIN_SLUG={Ethereum:'ethereum',BSC:'bsc',Tron:'tron',Solana:'solana',Arbitrum:'arbitrum',Polygon:'polygon',Optimism:'optimism',Avalanche:'avalanche',Base:'base',Fantom:'fantom',Algorand:'algorand',Near:'near',Stellar:'stellar',Cosmos:'cosmos',Aptos:'aptos',Sui:'sui',Celo:'celo',Gnosis:'gnosis',Moonbeam:'moonbeam','zkSync Era':'zksync-era',Linea:'linea',Scroll:'scroll',Manta:'manta',Mantle:'mantle',Blast:'blast',TON:'ton',Cardano:'cardano',Hedera:'hedera'};
const SC_CONTRACTS={USDT:{Ethereum:'https://etherscan.io/token/0xdAC17F958D2ee523a2206206994597C13D831ec7',BSC:'https://bscscan.com/token/0x55d398326f99059fF775485246999027B3197955',Tron:'https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',Solana:'https://solscan.io/token/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',Arbitrum:'https://arbiscan.io/token/0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',Polygon:'https://polygonscan.com/token/0xc2132D05D31c914a87C6611C10748AEb04B58e8F',Avalanche:'https://snowtrace.io/token/0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',Optimism:'https://optimistic.etherscan.io/token/0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',Base:'https://basescan.org/token/0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',TON:'https://tonscan.org/jetton/EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'},USDC:{Ethereum:'https://etherscan.io/token/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',BSC:'https://bscscan.com/token/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',Solana:'https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',Arbitrum:'https://arbiscan.io/token/0xaf88d065e77c8cC2239327C5EDb3A432268e5831',Polygon:'https://polygonscan.com/token/0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',Optimism:'https://optimistic.etherscan.io/token/0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',Base:'https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'},DAI:{Ethereum:'https://etherscan.io/token/0x6B175474E89094C44Da98b954EedeAC495271d0F',BSC:'https://bscscan.com/token/0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',Polygon:'https://polygonscan.com/token/0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',Arbitrum:'https://arbiscan.io/token/0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',Base:'https://basescan.org/token/0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'}};
const SC_EX_META={binance:{name:'Binance',domain:'binance.com',url:s=>\`https://www.binance.com/en/price/\${s}\`},coinbase:{name:'Coinbase',domain:'coinbase.com',url:s=>\`https://www.coinbase.com/price/\${s}\`},kraken:{name:'Kraken',domain:'kraken.com',url:s=>\`https://www.kraken.com/en-us/prices/\${s}\`},okx:{name:'OKX',domain:'okx.com',url:s=>\`https://www.okx.com/web3/detail/usdt/\${s}\`},bybit:{name:'Bybit',domain:'bybit.com',url:s=>\`https://www.bybit.com/en/coin-price/\${s}/\`},bitfinex:{name:'Bitfinex',domain:'bitfinex.com',url:s=>\`https://trading.bitfinex.com/t/\${s.toUpperCase()}:USD\`},kucoin:{name:'KuCoin',domain:'kucoin.com',url:s=>\`https://www.kucoin.com/price/\${s}\`},bitget:{name:'Bitget',domain:'bitget.com',url:s=>\`https://www.bitget.com/price/\${s}\`},gate:{name:'Gate.io',domain:'gate.io',url:s=>\`https://www.gate.io/price/\${s}\`}};

let scCoins=[], scFilter='all', scSearch='', scSortKey='mcap', scSortAsc=false, scPage=1, scRefreshTimer=null, scTimerSec=180;
const SC_PAGE_SIZE=50;

function scFmtUSD(n){if(!n||n===0)return'—';if(n>=1e12)return'$'+(n/1e12).toFixed(2)+'T';if(n>=1e9)return'$'+(n/1e9).toFixed(2)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(0)+'K';return'$'+n.toFixed(0)}
function scFmtPrice(p){if(!p)return'—';return'$'+p.toFixed(p>0.999&&p<1.001?4:6)}
function scPegDelta(p){const d=(p-1)*100,s=d>=0?'+':'';return s+d.toFixed(4)+'%'}
function scPegCls(p){const d=Math.abs(p-1);return d<=0.001?'g':d<=0.01?'a':'r'}
function scNormMech(r){if(!r)return'unknown';const s=r.toLowerCase();if(s.includes('fiat'))return'fiat';if(s.includes('algo'))return'algo';if(s.includes('crypto')||s.includes('cdp')||s.includes('collateral'))return'cdp';if(s.includes('rwa'))return'rwa';return'unknown'}
function scCalcRisk(c){if(c.depegged)return 95;let s=0;const d=Math.abs((c.price||1)-1);if(d>0.10)s+=50;else if(d>0.05)s+=40;else if(d>0.02)s+=30;else if(d>0.01)s+=20;else if(d>0.005)s+=10;else if(d>0.001)s+=3;const m=c.mech||'unknown';if(m==='algo')s+=30;else if(m==='cdp')s+=12;else if(m==='rwa')s+=8;else if(m==='fiat')s+=2;else s+=18;const mc=c.mcap||0;if(mc<5e6)s+=18;else if(mc<5e7)s+=12;else if(mc<5e8)s+=6;else if(mc<5e9)s+=2;return Math.min(s,100)}
function scStatus(c){if(c.depegged)return'depegged';const d=Math.abs((c.price||1)-1);return d>0.02?'depegged':d>0.005?'atrisk':'pegged'}
function scRiskBadge(s){let c=s<=10?'safe':s<=25?'low':s<=50?'medium':s<=75?'high':'critical';return\`<span class="risk-score \${c}">\${s}</span>\`}
function scMechBadge(m){const l={fiat:'Fiat',cdp:'CDP',algo:'Algo',rwa:'RWA',unknown:'?'};return\`<span class="mech \${m}">\${l[m]||m}</span>\`}
function scChainUrl(sym,ch){return(SC_CONTRACTS[sym]&&SC_CONTRACTS[sym][ch])||\`https://defillama.com/stablecoin/\${sym.toLowerCase()}\`}
function scChainIcons(chains,sym,max=6){if(!chains||!chains.length)return'<span class="chain-more">—</span>';const show=chains.slice(0,max),extra=chains.length-show.length;const icons=show.map(ch=>{const slug=SC_CHAIN_SLUG[ch]||ch.toLowerCase().replace(/\\s+/g,'-');const img=\`https://icons.llamao.fi/icons/chains/rsz_\${slug}.jpg\`;const link=scChainUrl(sym,ch);const init=ch.slice(0,2).toUpperCase();return\`<a class="chain-ico" href="\${link}" target="_blank" rel="noopener" title="\${sym} on \${ch}"><img src="\${img}" alt="\${ch}" loading="lazy" onerror="this.textContent='\${init}'"></a>\`}).join('');const more=extra>0?\`<span class="chain-more">+\${extra}</span>\`:'';return\`<div class="chain-icons">\${icons}\${more}</div>\`}
function scExBadges(exchanges,sym,cgId){if(!exchanges||!exchanges.length)return'<span style="color:var(--text-3);font-size:11px">—</span>';const slug=cgId||sym.toLowerCase();return\`<div class="ex-badges">\${exchanges.map(ex=>{const m=SC_EX_META[ex];if(!m)return'';const href=m.url(slug);const fav=\`https://www.google.com/s2/favicons?domain=\${m.domain}&sz=32\`;return\`<a class="ex-icon-link" href="\${href}" target="_blank" rel="noopener" title="\${m.name}"><img src="\${fav}" alt="\${m.name}" width="14" height="14" loading="lazy"></a>\`}).join('')}</div>\`}

function scSetFilter(f){scFilter=f;scPage=1;document.querySelectorAll('#sc-section .ftab').forEach(t=>t.classList.toggle('active',t.dataset.f===f));scRenderTable()}
window.scSetFilter=scSetFilter;
function scOnSearch(q){scSearch=q;scPage=1;scRenderTable()}
window.scOnSearch=scOnSearch;
function scSortBy(key){if(scSortKey===key)scSortAsc=!scSortAsc;else{scSortKey=key;scSortAsc=false;}document.querySelectorAll('#sc-section th[data-sort]').forEach(th=>{th.classList.toggle('sorted',th.dataset.sort===key);th.classList.toggle('asc-dir',th.dataset.sort===key&&scSortAsc)});scRenderTable()}
window.scSortBy=scSortBy;
function scGoPage(p){scPage=p;scRenderTable();document.getElementById('sc-section').scrollIntoView({behavior:'smooth'})}
window.scGoPage=scGoPage;

function scGetFiltered(){return scCoins.filter(c=>{if(scFilter==='pegged')return c._status==='pegged';if(scFilter==='atrisk')return c._status==='atrisk';if(scFilter==='depegged')return c._status==='depegged';if(scFilter==='fiat')return c.mech==='fiat';if(scFilter==='cdp')return c.mech==='cdp';if(scFilter==='algo')return c.mech==='algo';return true}).filter(c=>{if(!scSearch)return true;const q=scSearch.toLowerCase();return c.sym.toLowerCase().includes(q)||c.name.toLowerCase().includes(q)})}
function scGetSorted(list){return[...list].sort((a,b)=>{let av=a[scSortKey],bv=b[scSortKey];if(scSortKey==='peg'){av=Math.abs((a.price||1)-1);bv=Math.abs((b.price||1)-1)}if(scSortKey==='symbol'){av=a.sym;bv=b.sym}if(typeof av==='string')return scSortAsc?av.localeCompare(bv):bv.localeCompare(av);return scSortAsc?(av||0)-(bv||0):(bv||0)-(av||0)})}

function scRenderStats(){const all=scCoins;const totalMcap=all.reduce((s,c)=>s+(c.mcap||0),0);const atPeg=all.filter(c=>c._status==='pegged').length;const atRisk=all.filter(c=>c._status==='atrisk').length;const dep=all.filter(c=>c._status==='depegged').length;const lg=all.reduce((b,c)=>(c.mcap||0)>(b?.mcap||0)?c:b,null);document.getElementById('sc-stats').innerHTML=\`<div class="stat"><div class="stat-label">Total Market Cap</div><div class="stat-val b">\${scFmtUSD(totalMcap)}</div><div class="stat-sub">all tracked stablecoins</div></div><div class="stat"><div class="stat-label">✅ At Peg</div><div class="stat-val g">\${atPeg}</div><div class="stat-sub">within 0.5% of $1.00</div></div><div class="stat"><div class="stat-label">⚠ At Risk</div><div class="stat-val a">\${atRisk}</div><div class="stat-sub">0.5% – 2% deviation</div></div><div class="stat"><div class="stat-label">🚨 Depegged</div><div class="stat-val r">\${dep}</div><div class="stat-sub">over 2% deviation</div></div><div class="stat"><div class="stat-label">Largest</div><div class="stat-val p">\${lg?.sym||'—'}</div><div class="stat-sub">\${scFmtUSD(lg?.mcap||0)}</div></div><div class="stat"><div class="stat-label">Tracked</div><div class="stat-val">\${all.length}</div><div class="stat-sub">stablecoins monitored</div></div>\`}

function scRenderTable(){const filtered=scGetFiltered();const sorted=scGetSorted(filtered);const total=sorted.length;const maxPage=Math.max(1,Math.ceil(total/SC_PAGE_SIZE));if(scPage>maxPage)scPage=maxPage;const start=(scPage-1)*SC_PAGE_SIZE;const pg=sorted.slice(start,start+SC_PAGE_SIZE);const tbody=document.getElementById('sc-tbody');if(!tbody)return;if(!pg.length){tbody.innerHTML=\`<tr><td colspan="11"><div class="empty-state">No stablecoins match your filter.</div></td></tr>\`;document.getElementById('sc-pagination').innerHTML='';return}const rankMap={};[...scCoins].sort((a,b)=>(b.mcap||0)-(a.mcap||0)).forEach((c,i)=>{rankMap[c.sym+c.llamaId]=i+1});tbody.innerHTML=pg.map(c=>{const rank=rankMap[c.sym+c.llamaId]||'—';const price=c.price||1;const pdCls=scPegCls(price);const ghFb=\`https://cdn.jsdelivr.net/gh/ErikThiart/cryptocurrency-icons@master/32/\${c.sym.toLowerCase()}.png\`;const iconHtml=c.icon?\`<img src="\${c.icon}" alt="\${c.sym}" data-fb="\${ghFb}" loading="lazy" onerror="if(this.dataset.fb){var f=this.dataset.fb;this.dataset.fb='';this.src=f;return;}this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="coin-letter-icon" style="display:none">\${c.sym.charAt(0)}</span>\`:\`<span class="coin-letter-icon">\${c.sym.charAt(0)}</span>\`;const scCgUrl=c.cgId?\`https://www.coingecko.com/en/coins/\${c.cgId}\`:null;const scCmcSlug=c.cgId?(CG_TO_CMC[c.cgId]||c.cgId):null;const scLinks=\`<div class="tk-links">\${scCgUrl?\`<a href="\${scCgUrl}" target="_blank" title="CoinGecko"><img src="https://www.google.com/s2/favicons?domain=coingecko.com&sz=32" alt="CG"></a>\`:''}\${scCmcSlug?\`<a href="https://coinmarketcap.com/currencies/\${scCmcSlug}/" target="_blank" title="CoinMarketCap"><img src="https://www.google.com/s2/favicons?domain=coinmarketcap.com&sz=32" alt="CMC"></a>\`:''}</div>\`;const chgCls=(c.change24h||0)>=0?'up':'dn';const chgSign=(c.change24h||0)>=0?'+':'';return\`<tr><td><span class="rank-num">\${rank}</span></td><td><div class="tk"><div class="tk-ico">\${iconHtml}</div><div><div class="tk-sym">\${c.sym}</div><div class="tk-name">\${c.name}</div><div class="tk-chains">\${c.chainCount>0?c.chainCount+' chain'+(c.chainCount!==1?'s':''):''}</div>\${scLinks}</div></div></td><td>\${scMechBadge(c.mech)}</td><td><span class="price-cell \${scPegCls(price)}">\${scFmtPrice(price)}</span></td><td><span class="peg-delta \${pdCls}">\${scPegDelta(price)}</span></td><td class="col-mcap"><span class="mcap">\${scFmtUSD(c.mcap)}</span></td><td class="col-vol"><span class="vol">\${scFmtUSD(c.vol24h)}</span></td><td class="col-chg"><span class="pct \${chgCls}">\${c.vol24h>0?chgSign+(c.change24h||0).toFixed(2)+'%':'—'}</span></td><td class="col-chains">\${scChainIcons(c.chains,c.sym,6)}</td><td class="col-exchanges">\${scExBadges(c.exchanges,c.sym,c.cgId)}</td><td>\${scRiskBadge(c._risk)}</td></tr>\`}).join('');const pg2=document.getElementById('sc-pagination');if(!pg2)return;if(maxPage<=1){pg2.innerHTML='';return}pg2.innerHTML=\`<button onclick="scGoPage(\${scPage-1})" \${scPage<=1?'disabled':''}>← Prev</button><span class="pg-info">Page \${scPage} of \${maxPage} · \${total} coins</span><button onclick="scGoPage(\${scPage+1})" \${scPage>=maxPage?'disabled':''}>Next →</button>\`}

function scRenderAll(){scRenderStats();scRenderTable()}

function scSetProgress(pct,txt){const f=document.getElementById('sc-lprog');const l=document.getElementById('sc-ltxt');if(f)f.style.width=pct+'%';if(l)l.textContent=txt}

async function scFetchData(){scSetProgress(10,'Fetching peg data...');let llamaCoins=[];try{const r=await fetch('/llama/stablecoins?includePrices=true');const d=await r.json();llamaCoins=d.peggedAssets||[];scSetProgress(50,'Fetching market data...')}catch(e){scSetProgress(50,'Using fallback data...')}const llamaById={};llamaCoins.forEach(c=>{llamaById[String(c.id)]=c});let cgData=[];try{const ids=SC_HARDCODED.map(h=>h.cgId).join(',');const r=await fetch(\`/cg/coins/markets?vs_currency=usd&ids=\${ids}&per_page=50\`);cgData=await r.json().catch(()=>[]);scSetProgress(80,'Processing...')}catch(e){scSetProgress(80,'CoinGecko unavailable...')}const cgById={};(Array.isArray(cgData)?cgData:[]).forEach(c=>{cgById[c.id]=c});scCoins=SC_HARDCODED.map(hc=>{const llama=llamaById[hc.llamaId]||{};const cg=cgById[hc.cgId]||{};const circ=llama.circulating||{};const mcap=Object.values(circ).reduce((a,v)=>a+(typeof v==='number'?v:0),0);return{...hc,price:llama.price||cg.current_price||1.0,mcap:mcap||cg.market_cap||0,vol24h:cg.total_volume||0,change24h:cg.price_change_percentage_24h||0,chains:llama.chains||[],chainCount:(llama.chains||[]).length||hc.chains_hint||0,icon:hc.icon||cg.image||null,pegType:llama.pegType||'peggedUSD'}});llamaCoins.forEach(lc=>{if(SC_HARDCODED.find(h=>h.llamaId===String(lc.id)))return;const circ=lc.circulating||{};const mcap=circ.peggedUSD||0;if(mcap<10e6)return;if(!(lc.pegType||'').includes('USD'))return;scCoins.push({llamaId:String(lc.id),sym:lc.symbol||'?',name:lc.name||lc.symbol||'?',cgId:lc.gecko_id||null,mech:scNormMech(lc.pegMechanism),price:lc.price||1.0,mcap,vol24h:0,change24h:0,chains:lc.chains||[],chainCount:(lc.chains||[]).length,icon:null,pegType:lc.pegType})});const _discIds=[...new Set(scCoins.filter(c=>c.cgId&&!c.icon).map(c=>c.cgId))];if(_discIds.length){try{const _r=await fetch(\`/cg/coins/markets?vs_currency=usd&ids=\${_discIds.join(',')}&per_page=250\`);const _d=await _r.json().catch(()=>[]);if(Array.isArray(_d))_d.forEach(coin=>{scCoins.forEach(c=>{if(c.cgId===coin.id){if(!c.icon&&coin.image)c.icon=coin.image;if(!c.vol24h)c.vol24h=coin.total_volume||0;if(!c.change24h)c.change24h=coin.price_change_percentage_24h||0;if(!c.mcap&&coin.market_cap)c.mcap=coin.market_cap}})});}catch(e){}}scCoins.sort((a,b)=>(b.mcap||0)-(a.mcap||0));scCoins.forEach(c=>{c._risk=scCalcRisk(c);c._status=scStatus(c)});scSetProgress(100,'Done!');setTimeout(()=>{const l=document.getElementById('sc-loader');if(l)l.classList.add('hidden');const nl=document.getElementById('tnav-live');if(nl)nl.style.display='flex'},400);const now=new Date();const el=document.getElementById('sc-updTime');if(el)el.textContent='updated '+now.toLocaleTimeString();scStartTimer();scRenderAll()}

function scStartTimer(){if(scRefreshTimer)clearInterval(scRefreshTimer);scTimerSec=180;scUpdateTimer();scRefreshTimer=setInterval(()=>{scTimerSec--;if(scTimerSec<=0){clearInterval(scRefreshTimer);scFetchData()}else scUpdateTimer()},1000)}
function scUpdateTimer(){const m=Math.floor(scTimerSec/60),s=scTimerSec%60;const el=document.getElementById('sc-refreshTimer');if(el)el.textContent=\`next: \${m}:\${String(s).padStart(2,'0')}\`}
function scDoRefresh(){const btn=document.getElementById('sc-refreshBtn');if(btn)btn.classList.add('spinning');if(scRefreshTimer)clearInterval(scRefreshTimer);scFetchData().finally(()=>{if(btn)btn.classList.remove('spinning')})}
window.scDoRefresh=scDoRefresh;

window.scInit=async function(){if(!scInitialized){scInitialized=true;await scFetchData()}};
})();

// ===== EXCHANGE TAB SWITCHER =====
function switchExchange(ex) {
    const bnSection = document.getElementById('bn-section');
    const cbSection = document.getElementById('cb-section');
    const scSection = document.getElementById('sc-section');
    const bnTab = document.getElementById('ex-tab-binance');
    const cbTab = document.getElementById('ex-tab-coinbase');
    const scTab = document.getElementById('ex-tab-stablecoins');

    // Hide all sections, deactivate all tabs
    bnSection.classList.remove('active');
    cbSection.classList.remove('active');
    scSection.classList.remove('active');
    bnTab.classList.remove('active');
    cbTab.classList.remove('active');
    scTab.classList.remove('active');

    if (ex === 'binance') {
        bnSection.classList.add('active');
        bnTab.classList.add('active');
        if (!bnInitialized) {
            bnInitialized = true;
            Promise.resolve(window.bnInit()).catch(e => {
                console.error('[BN] init failed:', e);
                document.getElementById('bn-loader').classList.add('hidden');
            });
            setTimeout(() => {
                const loader = document.getElementById('bn-loader');
                if (loader && !loader.classList.contains('hidden')) {
                    loader.classList.add('hidden');
                    console.warn('[BN] loader timeout — showing cached data');
                }
            }, 15000);
        }
    } else if (ex === 'coinbase') {
        cbSection.classList.add('active');
        cbTab.classList.add('active');
        if (!cbInitialized) {
            cbInitialized = true;
            document.getElementById('cb-loader').classList.remove('hidden');
            try {
                window.cbInit().then(() => {
                    document.getElementById('cb-loader').style.display = 'none';
                }).catch(e => {
                    console.error('[CB] init failed:', e);
                    document.getElementById('cb-loader').innerHTML = '<div style="color:#f87171;text-align:center;padding:40px"><h3>Failed to load Coinbase data</h3><p>' + e.message + '</p><button onclick="location.reload()" style="margin-top:16px;padding:8px 16px;background:#f59e0b;color:#000;border:none;border-radius:4px;cursor:pointer">Reload</button></div>';
                });
            } catch(e) {
                console.error('[CB] sync error:', e);
                document.getElementById('cb-loader').innerHTML = '<div style="color:#f87171;text-align:center;padding:40px"><h3>Error</h3><p>' + e.message + '</p></div>';
            }
            setTimeout(() => {
                const loader = document.getElementById('cb-loader');
                if (loader && !loader.classList.contains('hidden')) {
                    loader.style.display = 'none';
                    console.error('[CB] loader timeout - hiding');
                }
            }, 30000);
        }
    } else if (ex === 'stablecoins') {
        scSection.classList.add('active');
        scTab.classList.add('active');
        if (typeof window.scInit === 'function') {
            window.scInit().catch(e => {
                console.error('[SC] init failed:', e);
                const loader = document.getElementById('sc-loader');
                if (loader) loader.innerHTML = '<div style="color:#f87171;text-align:center;padding:40px"><h3>Failed to load stablecoin data</h3><p>' + e.message + '</p><button onclick="scDoRefresh()" style="margin-top:16px;padding:8px 16px;background:#22c55e;color:#000;border:none;border-radius:4px;cursor:pointer">Retry</button></div>';
            });
        }
    }
    history.replaceState(null, '', '#' + ex);
}

document.addEventListener('DOMContentLoaded', () => {
    const hash = location.hash.replace('#', '') || 'binance';
    if (hash === 'coinbase') switchExchange('coinbase');
    else if (hash === 'stablecoins') switchExchange('stablecoins');
    else switchExchange('binance');
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';

    // Press '/' to focus the active section's search box
    if (e.key === '/' && !inInput) {
        e.preventDefault();
        const activeSection = document.querySelector('.ex-section.active');
        const search = activeSection?.querySelector('input.search');
        if (search) search.focus();
    }

    // Press 'Escape' to clear search and blur
    if (e.key === 'Escape' && inInput) {
        e.preventDefault();
        const input = document.activeElement;
        if (input.classList.contains('search')) {
            input.value = '';
            input.blur();
            if (input.closest('#bn-section')) bnSetQuery('');
            else if (input.closest('#cb-section')) cbSetQuery('');
            else if (input.closest('#sc-section')) scOnSearch('');
        }
    }

    // 'b' / 'c' / 's' to switch exchange tabs (when not in input)
    if (!inInput) {
        if (e.key === 'b' || e.key === 'B') switchExchange('binance');
        if (e.key === 'c' || e.key === 'C') switchExchange('coinbase');
        if (e.key === 's' || e.key === 'S') switchExchange('stablecoins');
    }
});

</script>

<!-- COOKIE CONSENT BAR -->
<div class="cookie-bar hidden" id="cookie-bar">
  <div class="cookie-bar-inner">
    <div class="cookie-bar-left">
      <div class="cookie-bar-text">We use Google Analytics (only with consent) to understand traffic. No personal data collected. <a href="/privacy">Privacy Policy</a></div>
    </div>
    <div class="cookie-bar-actions">
      <button class="cookie-btn decline" onclick="declineCookies()">Reject</button>
      <button class="cookie-btn accept" onclick="acceptCookies()">Accept Analytics</button>
    </div>
  </div>
</div>

<script>
// ===== COOKIE CONSENT + ANALYTICS =====
(function() {
  const KEY = 'cm_consent_v1';
  const GA_ID = 'G-4MY2VXRGJJ';

  function loadGA() {
    if (window._gaLoaded) return;
    window._gaLoaded = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function(){dataLayer.push(arguments);};
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
  }

  function showBar() {
    document.getElementById('cookie-bar').classList.remove('hidden');
    document.body.style.paddingBottom = '70px';
  }
  function hideBar() {
    document.getElementById('cookie-bar').classList.add('hidden');
    document.body.style.paddingBottom = '';
  }

  window.acceptCookies = function() {
    localStorage.setItem(KEY, 'granted');
    hideBar();
    loadGA();
  };

  window.declineCookies = function() {
    localStorage.setItem(KEY, 'denied');
    hideBar();
  };

  const stored = localStorage.getItem(KEY);
  if (stored === 'granted') {
    loadGA();
  } else if (!stored) {
    setTimeout(showBar, 2000);
  }
})();
</script>
</body></html>
`;
