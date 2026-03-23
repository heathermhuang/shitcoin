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

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Crypto Monitor · Binance & Coinbase</title>
<meta name="description" content="Real-time monitoring of Binance and Coinbase coins under delisting watch — risk scores, order book depth, and cross-exchange data.">
<meta property="og:title" content="Crypto Monitor · shitcoin.io">
<meta property="og:description" content="Real-time Binance & Coinbase delisting monitor — risk scores, order book depth, and cross-exchange data.">
<meta property="og:url" content="https://shitcoin.io">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Crypto Monitor · shitcoin.io">
<meta name="twitter:description" content="Real-time Binance & Coinbase delisting monitor with risk scores.">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="alternate icon" href="/favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=DM+Sans:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
:root {
    --bg-0: #07080c;
    --bg-1: #0d0f14;
    --bg-2: #13151c;
    --bg-3: #191c25;
    --bg-4: #1f222e;
    --border-1: #1c1f2b;
    --border-2: #252938;
    --text-1: #e4e6ef;
    --text-2: #9498ad;
    --text-3: #5d6178;
    --red: #ef4444;
    --red-soft: rgba(239,68,68,0.12);
    --amber: #f59e0b;
    --amber-soft: rgba(245,158,11,0.12);
    --green: #22c55e;
    --green-soft: rgba(34,197,94,0.12);
    --blue: #3b82f6;
    --blue-soft: rgba(59,130,246,0.12);
    --purple: #a78bfa;
    --purple-soft: rgba(167,139,250,0.12);
    --cyan: #06b6d4;
}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg-0);color:var(--text-1);font-family:'DM Sans',sans-serif;min-height:100vh;overflow-x:hidden}
body::after{content:'';position:fixed;top:0;left:0;width:100%;height:100%;opacity:0.025;background:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");pointer-events:none;z-index:0}
.wrap{position:relative;z-index:1;max-width:1700px;margin:0 auto;padding:28px 24px}
.mono{font-family:'IBM Plex Mono',monospace}

/* HEADER */
.hdr{display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:20px}
.hdr-left{display:flex;align-items:center;gap:14px}
.logo{width:38px;height:38px;background:var(--bg-3);border:1px solid var(--border-2);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:var(--amber);font-family:'IBM Plex Mono',monospace}
.hdr h1{font-size:22px;font-weight:800;letter-spacing:-0.5px}
.hdr .sub{font-size:12px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:2px}
.hdr-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.live{display:flex;align-items:center;gap:6px;font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--green);background:var(--green-soft);padding:5px 12px;border-radius:16px;border:1px solid rgba(34,197,94,0.2)}
.live-dot{width:5px;height:5px;background:var(--green);border-radius:50%;animation:blink 1.4s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}
.meta-text{font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--text-3)}
.btn{background:var(--bg-3);border:1px solid var(--border-1);color:var(--text-2);padding:6px 14px;border-radius:7px;font-family:'IBM Plex Mono',monospace;font-size:11px;cursor:pointer;transition:all 0.15s;display:flex;align-items:center;gap:5px}
.btn:hover{background:var(--bg-4);border-color:var(--border-2);color:var(--text-1)}
.btn.spinning svg{animation:spin 0.8s linear infinite}
@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}

/* STATS */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:20px}
.stat{background:var(--bg-2);border:1px solid var(--border-1);border-radius:10px;padding:14px 16px;transition:border-color 0.15s}
.stat:hover{border-color:var(--border-2)}
.stat-label{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-bottom:5px}
.stat-val{font-size:28px;font-weight:800;letter-spacing:-1.5px;line-height:1}
.stat-val.r{color:var(--red)}.stat-val.a{color:var(--amber)}.stat-val.g{color:var(--green)}.stat-val.b{color:var(--blue)}.stat-val.p{color:var(--purple)}
.stat-sub{font-size:10px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:3px}

/* PREDICTION */
.pred-bar{background:var(--bg-2);border:1px solid var(--border-1);border-radius:10px;padding:14px 18px;margin-bottom:24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.pred-bar .pred-label{font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);text-transform:uppercase;letter-spacing:1px}
.pred-bar .pred-val{font-size:13px;font-weight:600;color:var(--cyan);font-family:'IBM Plex Mono',monospace}
.pred-bar .pred-sep{width:1px;height:20px;background:var(--border-2)}

/* FILTERS */
.filters{display:flex;align-items:center;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.ftab{padding:6px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.15s;border:1px solid var(--border-1);background:transparent;color:var(--text-2);font-family:'DM Sans',sans-serif;white-space:nowrap}
.ftab:hover{background:var(--bg-3);border-color:var(--border-2)}
.ftab.active{background:var(--text-1);color:var(--bg-0);border-color:var(--text-1);font-weight:600}
.ftab .cnt{font-family:'IBM Plex Mono',monospace;font-size:10px;margin-left:4px;opacity:0.6}
.search{margin-left:auto;background:var(--bg-2);border:1px solid var(--border-1);border-radius:7px;padding:6px 14px;color:var(--text-1);font-family:'IBM Plex Mono',monospace;font-size:12px;width:200px;outline:none;transition:all 0.15s}
.search::placeholder{color:var(--text-3)}
.search:focus{border-color:var(--blue);box-shadow:0 0 0 2px rgba(59,130,246,0.1)}

/* TABLE */
.tbl-wrap{background:var(--bg-1);border:1px solid var(--border-1);border-radius:12px;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:1200px}
thead{background:var(--bg-2)}
th{padding:10px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-weight:500;border-bottom:1px solid var(--border-1);white-space:nowrap;cursor:pointer;user-select:none;transition:color 0.15s}
th:hover{color:var(--text-2)}
th.sorted{color:var(--blue)}
th[data-sort]::after{content:'';margin-left:3px;opacity:0.3;font-size:9px}
th[data-sort].sorted::after{content:' ▼';opacity:1}
th[data-sort].sorted.asc-dir::after{content:' ▲';opacity:1}
td{padding:10px 12px;border-bottom:1px solid var(--border-1);font-size:13px;vertical-align:middle}
tr{transition:background 0.1s}
tbody tr:hover{background:var(--bg-3)}
tbody tr:last-child td{border-bottom:none}
tbody tr.delisting-row{background:rgba(239,68,68,0.03)}
tbody tr.delisted-row{opacity:0.45}
tbody tr.restored-row{background:rgba(34,197,94,0.03)}
tbody tr.highrisk-row{background:rgba(239,68,68,0.02)}
tbody tr.limit-row{background:rgba(245,158,11,0.03)}

/* CELLS */
.tk{display:flex;align-items:center;gap:10px}
.tk-ico{width:30px;height:30px;border-radius:50%;background:var(--bg-3);border:1px solid var(--border-1);display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;color:var(--text-2);flex-shrink:0;background-size:cover;background-position:center;overflow:hidden}
.tk-sym{font-weight:700;font-size:13px}
.tk-name{font-size:10px;color:var(--text-3);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tk-links{display:flex;gap:4px;margin-top:2px;align-items:center}
.tk-links a{display:flex;align-items:center;justify-content:center;width:14px;height:14px;opacity:0.5;transition:opacity 0.15s;border-radius:2px}
.tk-links a:hover{opacity:1}
.tk-links a img{width:14px;height:14px;border-radius:2px;display:block}
.ex-icons{display:flex;gap:3px;align-items:center}
.ex-icons a{display:flex;align-items:center;justify-content:center;width:16px;height:16px;opacity:0.45;transition:opacity 0.15s;border-radius:3px}
.ex-icons a:hover{opacity:1}
.ex-icons a img{width:16px;height:16px;border-radius:3px;display:block}

.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:0.3px}
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
.timeline-section{margin-top:36px}
.sec-title{font-size:18px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.timeline{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px}
.tcard{flex-shrink:0;background:var(--bg-2);border:1px solid var(--border-1);border-radius:10px;padding:16px;min-width:240px;transition:all 0.2s}
.tcard:hover{border-color:var(--border-2);transform:translateY(-1px)}
.tcard.urgent{border-color:rgba(239,68,68,0.25);background:linear-gradient(135deg,var(--bg-2),rgba(239,68,68,0.02))}
.tcard .tdate{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:var(--amber);margin-bottom:6px}
.tcard.urgent .tdate{color:var(--red)}
.tcard .tevt{font-size:13px;font-weight:500;margin-bottom:6px;line-height:1.3}
.ttokens{display:flex;flex-wrap:wrap;gap:3px}
.ttk{font-family:'IBM Plex Mono',monospace;font-size:10px;padding:2px 6px;border-radius:3px;background:var(--bg-0);border:1px solid var(--border-1);color:var(--text-2)}

/* FOOTER */
.footer{margin-top:36px;text-align:center;font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;padding:20px 0;border-top:1px solid var(--border-1)}
.footer a{color:var(--blue);text-decoration:none}

/* COOKIE CONSENT */
.cookie-bar{position:fixed;bottom:0;left:0;right:0;z-index:1000;background:var(--bg-2);border-top:1px solid var(--border-2);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;backdrop-filter:blur(12px);transition:transform 0.3s}
.cookie-bar.hidden{transform:translateY(100%);pointer-events:none}
.cookie-bar-left{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.cookie-bar-text{font-size:11px;color:var(--text-2);font-family:'IBM Plex Mono',monospace;line-height:1.5}
.cookie-bar-text a{color:var(--blue);text-decoration:none}
.cookie-bar-actions{display:flex;gap:8px;flex-shrink:0}
.cookie-btn{padding:7px 16px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:'IBM Plex Mono',monospace;transition:all 0.15s;border:1px solid transparent}
.cookie-btn.accept{background:var(--green);color:#000;border-color:var(--green)}
.cookie-btn.accept:hover{opacity:0.88}
.cookie-btn.decline{background:transparent;color:var(--text-3);border-color:var(--border-2)}
.cookie-btn.decline:hover{color:var(--text-2)}

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

@media(max-width:900px){.wrap{padding:16px 12px}.hdr{flex-direction:column}.search{width:100%;margin-left:0}.stats{grid-template-columns:repeat(2,1fr)}}
@media(max-width:640px){.tnav-name{display:none}.tnav-divider{display:none}.tnav-tabs{justify-content:flex-start}.tnav-tab{padding:6px 14px;font-size:12px}.topnav-inner{padding:0 14px}}
@media(max-width:480px){.stats{grid-template-columns:1fr}}
@media(max-width:640px){.col-days,.col-mon,.col-vol,.col-mcap,.col-bid,.col-ask,.col-also{display:none}table{min-width:380px}}
::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:var(--bg-1)}::-webkit-scrollbar-thumb{background:var(--border-2);border-radius:3px}::-webkit-scrollbar-thumb:hover{background:var(--text-3)}

/* TOP NAV */
.topnav{position:sticky;top:0;z-index:200;background:rgba(7,8,12,0.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--border-1)}
.topnav-inner{max-width:1700px;margin:0 auto;padding:0 24px;height:54px;display:flex;align-items:center;gap:0}
.tnav-brand{display:flex;align-items:center;gap:9px;flex-shrink:0;text-decoration:none}
.tnav-logo{width:30px;height:30px;background:var(--bg-3);border:1px solid var(--border-2);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--amber);font-family:'IBM Plex Mono',monospace;font-weight:800}
.tnav-name{font-size:13px;font-weight:700;letter-spacing:-0.3px;color:var(--text-2)}
.tnav-divider{width:1px;height:20px;background:var(--border-1);margin:0 20px;flex-shrink:0}
.tnav-tabs{display:flex;align-items:center;gap:2px;flex:1;justify-content:center}
.tnav-tab{display:inline-flex;align-items:center;gap:8px;padding:7px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.18s;border:1px solid transparent;background:transparent;color:var(--text-3);font-family:'DM Sans',sans-serif;letter-spacing:-0.2px}
.tnav-tab:hover{background:var(--bg-3);color:var(--text-2)}
.tnav-tab.active.binance{background:rgba(240,185,11,0.1);color:#F0B90B;border-color:rgba(240,185,11,0.18)}
.tnav-tab.active.coinbase{background:rgba(0,82,255,0.1);color:#6b9fff;border-color:rgba(0,82,255,0.18)}
.tnav-tab.stablecoins{color:var(--text-3);text-decoration:none}
.tnav-tab.stablecoins:hover{background:rgba(34,197,94,0.07);color:#22c55e}
.tnav-right{display:flex;align-items:center;gap:12px;flex-shrink:0;min-width:fit-content}
/* EXCHANGE SECTIONS */
.ex-section{display:none}
.ex-section.active{display:block}
</style>
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
        <div class="tnav-tabs">
            <button class="tnav-tab binance active" id="ex-tab-binance" onclick="switchExchange('binance')">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path fill="#F0B90B" d="M7 1 4.8 3.2 7 5.4 9.2 3.2z"/><path fill="#F0B90B" d="M1 7 3.2 4.8 5.4 7 3.2 9.2z"/><path fill="#F0B90B" d="M13 7 10.8 4.8 8.6 7 10.8 9.2z"/><path fill="#F0B90B" d="M7 8.6 4.8 10.8 7 13 9.2 10.8z"/><path fill="#F0B90B" d="M7 4.8 5.1 6.7 7 8.6 8.9 6.7z"/></svg>
                Binance
            </button>
            <button class="tnav-tab coinbase" id="ex-tab-coinbase" onclick="switchExchange('coinbase')">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect width="14" height="14" rx="3.5" fill="#0052FF"/><circle cx="7" cy="7" r="3.5" fill="#0052FF"/><circle cx="7" cy="7" r="3.5" stroke="white" stroke-width="1.5" fill="none"/><rect x="3.5" y="5.9" width="7" height="2.2" fill="#0052FF"/></svg>
                Coinbase
            </button>
            <a class="tnav-tab stablecoins" href="https://stablecoin.io" target="_blank">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.5" stroke="#22c55e" stroke-width="1"/><text x="7" y="10.5" text-anchor="middle" font-size="8" font-weight="700" fill="#22c55e" font-family="IBM Plex Mono,monospace">$</text></svg>
                Stablecoins
            </a>
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
    <div class="stat"><div class="stat-label">Online</div><div class="stat-val g" id="cb-sOnline">-</div><div class="stat-sub">trading on Coinbase</div></div>
    <div class="stat"><div class="stat-label">Limit Only</div><div class="stat-val a" id="cb-sLimit">-</div><div class="stat-sub">post-only mode</div></div>
    <div class="stat"><div class="stat-label">Delisted</div><div class="stat-val r" id="cb-sDelisted">-</div><div class="stat-sub">removed from trading</div></div>
    <div class="stat"><div class="stat-label">Total Tracked</div><div class="stat-val b" id="cb-sTotal">-</div><div class="stat-sub">in our database</div></div>
    <div class="stat"><div class="stat-label">High Risk</div><div class="stat-val r" id="cb-sHighRisk">-</div><div class="stat-sub">risk score ≥ 50</div></div>
    <div class="stat"><div class="stat-label">Active Pairs</div><div class="stat-val p" id="cb-sPairs">-</div><div class="stat-sub">USD trading pairs</div></div>
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
<script>
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
  {sym:'MDT', name:'Measurable Data', status:'monitoring', monDate:'2025-06-05', delistDate:null, restoreDate:null},
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
  {sym:'A2Z', name:'Arena-Z', status:'delisting', monDate:'2026-03-13', delistDate:'2026-04-01', restoreDate:null},
  {sym:'FORTH', name:'Ampleforth Governance', status:'delisting', monDate:'2026-03-06', delistDate:'2026-04-01', restoreDate:null},
  {sym:'HOOK', name:'Hooked Protocol', status:'delisting', monDate:'2026-03-06', delistDate:'2026-04-01', restoreDate:null},
  {sym:'IDEX', name:'IDEX', status:'delisting', monDate:'2025-06-05', delistDate:'2026-04-01', restoreDate:null},
  {sym:'LRC', name:'Loopring', status:'delisting', monDate:'2026-03-06', delistDate:'2026-04-01', restoreDate:null},
  {sym:'NTRN', name:'Neutron', status:'delisting', monDate:'2026-03-13', delistDate:'2026-04-01', restoreDate:null},
  {sym:'RDNT', name:'Radiant Capital', status:'delisting', monDate:'2026-03-13', delistDate:'2026-04-01', restoreDate:null},
  {sym:'SXP', name:'Solar', status:'delisting', monDate:'2025-12-01', delistDate:'2026-04-01', restoreDate:null},
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
let filter = 'active'; // default tab
let query = '';
let sort = { key: 'risk', dir: 'desc' };
let page = 0;
const PAGE_SIZE = 100;

// Leveraged/stable tokens to exclude
const EXCLUDE = new Set(['USDC','BUSD','TUSD','FDUSD','USDP','DAI','USDD','AEUR','XUSD','BFUSD','RLUSD','USD1','USDE',
    'BTCUP','BTCDOWN','ETHUP','ETHDOWN','BNBUP','BNBDOWN','XRPUP','XRPDOWN',
    'TRXUP','TRXDOWN','LINKUP','LINKDOWN','DOTUP','DOTDOWN','ADAUP','ADADOWN',
    'EOSUP','EOSDOWN','LTCUP','LTCDOWN','XLMUP','XLMDOWN','UNIUP','UNIDOWN',
    'SXPUP','SXPDOWN','FILUP','FILDOWN','AAVEUP','AAVEDOWN','SUSHIUP','SUSHIDOWN',
    'WBTC','WBETH','BNSOL','LUNC','USTC','PAXG','EUR','EURI','OCEAN','AGIX','MATIC','FTM','UST','LUNA','BTCST','MFT','BOND']);

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
        // Get active tokens for CoinGecko lookup
        const activeSyms = allCoins
            .filter(t => t.status !== 'delisted' && liveData[t.sym])
            .map(t => t.sym);

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
        };

        const getGeckoId = sym => overrides[sym] || sym.toLowerCase();

        // Batch fetch from CoinGecko markets API (100 at a time)
        const batches = [];
        for (let i = 0; i < activeSyms.length; i += 100) {
            batches.push(activeSyms.slice(i, i + 100));
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
                        liveData[sym].mcap = coin.market_cap || coin.fully_diluted_valuation || 0;
                        liveData[sym].fdv = coin.fully_diluted_valuation;
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
        icons.push('<a href="https://www.coinbase.com/price/' + sym.toLowerCase() + '" target="_blank" title="Coinbase"><img src="https://www.coinbase.com/favicon.ico" alt="CB"></a>');
    }
    if (exchangeData.okx.has(sym)) {
        icons.push('<a href="https://www.okx.com/trade-spot/' + sym.toLowerCase() + '-usdt" target="_blank" title="OKX"><img src="https://www.okx.com/favicon.ico" alt="OKX"></a>');
    }
    if (exchangeData.kraken.has(sym)) {
        icons.push('<a href="https://www.kraken.com/prices/' + sym.toLowerCase() + '" target="_blank" title="Kraken"><img src="https://www.kraken.com/favicon.ico" alt="KR"></a>');
    }
    return icons.length ? '<div class="ex-icons">' + icons.join('') + '</div>' : '<span class="na">—</span>';
}


function getCMCSlug(sym) {
    const slugs = {
        'JASMY':'jasmycoin','FTT':'ftx-token','ARK':'ark','ARDR':'ardor',
        'PERP':'perpetual-protocol','MBL':'moviebloc','AWE':'stp-network',
        'MOVE':'movement','BIFI':'beefy-finance','MDT':'measurable-data-token',
        'PORTAL':'portal','WAN':'wanchain','DENT':'dent','D':'mines-of-dalarnia',
        'COS':'contentos','DEGO':'dego-finance','FUN':'funfair','MBOX':'mobox',
        'OXT':'orchid','WIF':'dogwifhat','ATA':'automata-network','FIO':'fio-protocol',
        'GTC':'gitcoin','PHB':'phoenix-global','QI':'benqi','A2Z':'arena-z',
        'FORTH':'ampleforth-governance-token','HOOK':'hooked-protocol','IDEX':'idex',
        'LRC':'loopring','NTRN':'neutron','RDNT':'radiant-capital','SXP':'solar-sxp',
        'BTC':'bitcoin','ETH':'ethereum','BNB':'bnb','SOL':'solana','XRP':'xrp',
        'DOGE':'dogecoin','ADA':'cardano','AVAX':'avalanche','DOT':'polkadot',
        'LINK':'chainlink','SHIB':'shiba-inu','UNI':'uniswap','ATOM':'cosmos',
        'FIL':'filecoin','APT':'aptos','ARB':'arbitrum','OP':'optimism',
        'SUI':'sui','NEAR':'near-protocol','INJ':'injective','ONDO':'ondo-finance',
        'RENDER':'render-token','FET':'artificial-superintelligence-alliance',
        'PEPE':'pepe','BONK':'bonk','FLOKI':'floki','WLD':'worldcoin-wld',
        'MLN':'enzyme','ZEN':'horizen','ZEC':'zcash','CVX':'convex-finance',
        'SUN':'sun-token','GPS':'goplus-security','FLOW':'flow',
        'ALPHA':'stella','BSW':'biswap','KMD':'komodo','LEVER':'leverfi','LTO':'lto-network',
        'FLM':'flamingo','HIFI':'hifi-finance','FIS':'stafi','REI':'rei-network',
        'NKN':'nkn','ACA':'acala','CHESS':'tranchess','DATA':'streamr',
        'DF':'dforce','GHST':'aavegotchi','BETA':'beta-finance',
        'AERGO':'aergo','AST':'airswap','BADGER':'badger-dao',
        'NULS':'nuls','VOXEL':'voxies','WING':'wing-finance','BAL':'balancer',
        'XMR':'monero','ALPACA':'alpaca-finance','STMX':'stormx',
        'AKRO':'akropolis','BLZ':'bluzelle','REEF':'reef',
    };
    return slugs[sym] || sym.toLowerCase();
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

        const iconUrl = ld.icon || \`https://bin.bnbstatic.com/image/admin_mgs_image/20201110/\${t.sym}.png\`;
        const iconStyle = ld.icon ? \`background-image:url('\${ld.icon}')\` : '';
        const bnIcon = '<img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" alt="Binance">';
        const cgIcon = '<img src="https://www.coingecko.com/favicon.ico" alt="CoinGecko">';
        const cmcIcon = '<img src="https://coinmarketcap.com/apple-touch-icon.png" alt="CMC">';
        const linkTitle = t.status === 'delisted' ? 'CoinGecko' : 'Binance Trade';
        const linkPrimaryIcon = t.status === 'delisted' ? cgIcon : bnIcon;
        const binanceLink = (t.status === 'delisted') 
            ? 'https://www.coingecko.com/en/coins/' + (liveData[t.sym]?.cgId || t.sym.toLowerCase())
            : 'https://www.binance.com/en/trade/' + t.sym + '_USDT?type=spot';
        const cmcSlug = getCMCSlug(t.sym);
        const cmcLink = cmcSlug ? 'https://coinmarketcap.com/currencies/' + cmcSlug + '/' : '';
        const cmcHtml = cmcLink ? '<a href="' + cmcLink + '" target="_blank" title="CoinMarketCap"><img src="https://coinmarketcap.com/apple-touch-icon.png" alt="CMC"></a>' : '';

        return \`<tr class="\${rowClass}">
            <td><div class="tk"><div class="tk-ico" style="\${iconStyle}">\${ld.icon ? '' : t.sym.slice(0,2)}</div><div><div class="tk-sym">\${t.sym}</div><div class="tk-name">\${t.name||t.sym}</div><div class="tk-links"><a href="\${binanceLink}" target="_blank" title="\${linkTitle}">\${linkPrimaryIcon}</a>\${cmcHtml}</div></div></div></td>
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

// ============ INTERACTIONS ============
function bnSortBy(key) {
    if (sort.key === key) sort.dir = sort.dir === 'desc' ? 'asc' : 'desc';
    else { sort.key = key; sort.dir = 'desc'; }
    page = 0;
    renderTable();
}
function bnSetFilter(f) { filter = f; page = 0; bnRenderAll(); }
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

const EXCLUDE = new Set(['USDC','USDT','DAI','USDS','USD1','EURC','AUDD','XSGD','PAX','PYUSD','GUSD','GYEN','MUSD','BUSD']);

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
};

// CMC slug overrides
const CMC_SLUGS = {
    'JASMY':'jasmycoin','FORTH':'ampleforth-governance-token','LRC':'loopring','IDEX':'idex',
    'BTC':'bitcoin','ETH':'ethereum','SOL':'solana','DOGE':'dogecoin','ADA':'cardano',
    'AVAX':'avalanche','DOT':'polkadot','LINK':'chainlink','SHIB':'shiba-inu','UNI':'uniswap',
    'ATOM':'cosmos','FIL':'filecoin','ARB':'arbitrum','OP':'optimism','SUI':'sui',
    'NEAR':'near-protocol','INJ':'injective','ONDO':'ondo-finance','RENDER':'render-token',
    'FET':'artificial-superintelligence-alliance','PEPE':'pepe','BONK':'bonk','FLOKI':'floki',
    'WLD':'worldcoin-wld','WIF':'dogwifhat','GTC':'gitcoin','MLN':'enzyme','CVX':'convex-finance',
    'FLOW':'flow','BAL':'balancer','GRT':'the-graph','IMX':'immutable-x','SAND':'the-sandbox',
    'MANA':'decentraland','AAVE':'aave','CRV':'curve-dao-token','LDO':'lido-dao',
    'ENS':'ethereum-name-service','SNX':'synthetix-network-token','SUSHI':'sushiswap',
    'HBAR':'hedera','ALGO':'algorand','TAO':'bittensor','BNB':'bnb',
};

function getCgId(sym) { return CG_OVERRIDES[sym] || sym.toLowerCase(); }
function getCmcSlug(sym) { return CMC_SLUGS[sym] || sym.toLowerCase(); }

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
    if (exchangeData.binance.has(sym)) icons.push('<a href="https://www.binance.com/en/trade/' + sym + '_USDT" target="_blank" title="Binance"><img src="https://bin.bnbstatic.com/static/images/common/favicon.ico" alt="Binance"></a>');
    if (exchangeData.okx.has(sym)) icons.push('<a href="https://www.okx.com/trade-spot/' + sym.toLowerCase() + '-usdt" target="_blank" title="OKX"><img src="https://www.okx.com/favicon.ico" alt="OKX"></a>');
    if (exchangeData.kraken.has(sym)) icons.push('<a href="https://www.kraken.com/prices/' + sym.toLowerCase() + '" target="_blank" title="Kraken"><img src="https://www.kraken.com/favicon.ico" alt="KR"></a>');
    return icons.length ? '<div class="ex-icons">' + icons.join('') + '</div>' : '<span class="na" style="color:var(--text-3)">\\u2014</span>';
}

// ===== RENDER =====
function getFiltered() {
    let list = [...allCoins];
    if (filter === 'online') list = list.filter(c => c.status === 'online' && !c.limitOnly);
    else if (filter === 'limit') list = list.filter(c => c.limitOnly);
    else if (filter === 'delisted') list = list.filter(c => c.status === 'delisted');
    else if (filter === 'highrisk') list = list.filter(c => c._risk >= 60 && c.status !== 'delisted');
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

    const cbIcon = '<img src="https://www.coinbase.com/favicon.ico" alt="CB">';
    const cmcIcon = '<img src="https://coinmarketcap.com/apple-touch-icon.png" alt="CMC">';
    const cgIcon = '<img src="https://www.coingecko.com/favicon.ico" alt="CG">';

    document.getElementById('cb-tBody').innerHTML = slice.map(c => {
        const ld = liveData[c.sym] || {};
        const rl = riskLabel(c._risk);
        const rc = riskColor(c._risk);
        const iconStyle = ld.icon ? \`background-image:url('\${ld.icon}')\` : '';
        const cgId = ld.cgId || getCgId(c.sym);
        const cmcSlug = getCmcSlug(c.sym);

        // Links
        const cbLink = c.status === 'delisted' ? \`https://www.coingecko.com/en/coins/\${cgId}\` : \`https://www.coinbase.com/price/\${c.sym.toLowerCase()}\`;
        const primaryIcon = c.status === 'delisted' ? cgIcon : cbIcon;
        const cmcHtml = \`<a href="https://coinmarketcap.com/currencies/\${cmcSlug}/" target="_blank" title="CoinMarketCap">\${cmcIcon}</a>\`;

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
            <td><div class="tk"><div class="tk-ico" style="\${iconStyle}">\${ld.icon ? '' : c.sym.slice(0,2)}</div><div><div class="tk-sym">\${c.sym}</div><div class="tk-name">\${c.pairs.length} pair\${c.pairs.length > 1 ? 's' : ''}</div><div class="tk-links"><a href="\${cbLink}" target="_blank" title="\${c.status==='delisted'?'CoinGecko':'Coinbase'}">\${primaryIcon}</a>\${cmcHtml}</div></div></div></td>
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

// ===== EXCHANGE TAB SWITCHER =====
function switchExchange(ex) {
    const bnSection = document.getElementById('bn-section');
    const cbSection = document.getElementById('cb-section');
    const bnTab = document.getElementById('ex-tab-binance');
    const cbTab = document.getElementById('ex-tab-coinbase');
    
    if (ex === 'binance') {
        bnSection.classList.add('active');
        cbSection.classList.remove('active');
        bnTab.classList.add('active');
        cbTab.classList.remove('active');
        if (!bnInitialized) {
            bnInitialized = true;
            Promise.resolve(window.bnInit()).catch(e => {
                console.error('[BN] init failed:', e);
                document.getElementById('bn-loader').classList.add('hidden');
            });
            // Safety timeout: if still loading after 15s, show table with cached data
            setTimeout(() => {
                const loader = document.getElementById('bn-loader');
                if (loader && !loader.classList.contains('hidden')) {
                    loader.classList.add('hidden');
                    console.warn('[BN] loader timeout — showing cached data');
                }
            }, 15000);
        }
    } else {
        bnSection.classList.remove('active');
        cbSection.classList.add('active');
        bnTab.classList.remove('active');
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
            // Safety timeout: if still loading after 30s, hide loader
            setTimeout(() => {
                const loader = document.getElementById('cb-loader');
                if (loader && !loader.classList.contains('hidden')) {
                    loader.style.display = 'none';
                    console.error('[CB] loader timeout - hiding');
                }
            }, 30000);
        }
    }
    history.replaceState(null, '', '#' + ex);
}

document.addEventListener('DOMContentLoaded', () => {
    const hash = location.hash.replace('#', '') || 'binance';
    switchExchange(hash === 'coinbase' ? 'coinbase' : 'binance');
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
            // Determine which module's query to clear
            if (input.closest('#bn-section')) bnSetQuery('');
            else if (input.closest('#cb-section')) cbSetQuery('');
        }
    }

    // 'b' / 'c' to switch exchange tabs (when not in input)
    if (!inInput) {
        if (e.key === 'b' || e.key === 'B') switchExchange('binance');
        if (e.key === 'c' || e.key === 'C') switchExchange('coinbase');
    }
});

</script>

<!-- COOKIE CONSENT BAR -->
<div class="cookie-bar hidden" id="cookie-bar">
  <div class="cookie-bar-left">
    <div class="cookie-bar-text">🍪 We use Google Analytics (only with consent) to understand traffic. No personal data collected. <a href="/privacy">Privacy Policy</a></div>
  </div>
  <div class="cookie-bar-actions">
    <button class="cookie-btn accept" onclick="acceptCookies()">Accept Analytics</button>
    <button class="cookie-btn decline" onclick="declineCookies()">Reject</button>
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
