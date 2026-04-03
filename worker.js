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

const HTML = `__HTML_PLACEHOLDER__`;
