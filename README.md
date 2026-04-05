# shitcoin.io — Crypto Delisting Monitor

**Live at [shitcoin.io](https://shitcoin.io)**

Real-time risk scores for coins on Binance and Coinbase. Tracks monitoring tags, delisting timelines, order book health, and cross-exchange availability so you can make informed decisions before an exchange pulls the plug.

![shitcoin.io screenshot](https://shitcoin.io/og-image.svg)

---

## What it does

- **Binance monitoring tags** — tracks every coin Binance has tagged for review, with days-on-monitoring, delisting timeline, and historical restore rate (6% of tagged coins make it back)
- **Coinbase risk scores** — flags thinly-traded or low-liquidity coins on Coinbase
- **Order book depth** — live bid/ask depth check to gauge exit liquidity
- **Cross-exchange availability** — shows whether a coin trades on Binance, OKX, Kraken, or Coinbase as a fallback
- **Per-coin recovery panel** — click any monitoring/delisting row for data-driven, coin-specific action items
- **Recovery Playbook** — general guide for monitoring-tagged project teams
- **Stablecoin monitor** — peg health and risk scores for 50+ stablecoins, embedded as a third tab (also at [stablecoin.io](https://stablecoin.io))

---

## Architecture

Single-file Cloudflare Worker. No database, no backend framework, no build pipeline beyond a simple inline script.

```
index.html          — all UI, data, and logic (~2400 lines)
worker.js           — Cloudflare Worker: routing, proxy, legal pages, SEO
build.js            — inlines index.html into worker.js → worker.dist.js
server.js           — local dev server (Node, no deps, stale-while-revalidate)
wrangler.toml       — Cloudflare deploy config
```

**Proxy layer** — the worker proxies three third-party APIs through allowlisted endpoints to avoid CORS issues and protect API quotas:

| Route | Upstream | Allowed endpoints |
|-------|----------|-------------------|
| `/api/*` | Binance data-api | `/ticker/24hr`, `/depth`, `/exchangeInfo`, `/ticker/price` |
| `/cb/*` | Coinbase Exchange API | `/products` and subpaths |
| `/cg/*` | CoinGecko API v3 | `/coins/markets` |
| `/ex/<name>` | OKX / Kraken / Binance / Coinbase (static) | enumerated lookup table |

All proxy responses use stale-while-revalidate caching via the Cloudflare Cache API.

---

## Local development

No npm install needed for local dev — `server.js` has zero dependencies.

```bash
git clone https://github.com/heathermhuang/shitcoin.git
cd shitcoin
node server.js
# open http://localhost:8080
```

The dev server proxies Binance and CoinGecko directly, caches responses to `./cache/`, and serves `index.html` with hot-reload on page refresh.

---

## Deployment

Deploy to Cloudflare Workers via Wrangler:

```bash
npm install          # installs wrangler
node build.js        # inlines index.html → worker.dist.js
npx wrangler deploy  # deploys worker.dist.js to Cloudflare
```

`wrangler deploy` runs `node build.js` automatically via the `[build]` config in `wrangler.toml`, so `npx wrangler deploy` is all you need after the first install.

**Requirements:**
- A Cloudflare account with Workers enabled
- `wrangler login` (authenticates via browser)
- Your domain pointed at Cloudflare (for custom domain routes)

---

## Data sources

All live data is fetched at runtime from public APIs:

| Data | Source |
|------|--------|
| Binance coin list, 24h tickers | [data-api.binance.vision](https://data-api.binance.vision) (public, no key) |
| Coinbase products + stats | [api.exchange.coinbase.com](https://api.exchange.coinbase.com) (public, no key) |
| Market cap, price | [CoinGecko API v3](https://www.coingecko.com/en/api) (free tier, no key) |
| Cross-exchange availability | OKX, Kraken public instruments endpoints |

**Monitoring and delisting dates** are hardcoded in `index.html` and sourced from official Binance announcements. See `VERIFIED_DATA.md` for the full audit trail and known data issues.

---

## Contributing

Contributions welcome. The highest-value work is keeping coin data accurate — delisting dates, monitoring tag dates, and restore events. See [CONTRIBUTING.md](CONTRIBUTING.md).

For code changes, open a PR. The project is intentionally kept as a single-file worker; please avoid introducing build complexity or framework dependencies.

---

## Related

- [stablecoin.io](https://stablecoin.io) — peg health monitor for 50+ stablecoins ([source](https://github.com/heathermhuang/stablecoin))

---

## Disclaimer

This site does not provide financial advice. Risk scores are algorithmic calculations based on public market data. Never make investment decisions based solely on this data. Cryptocurrency markets are volatile and past delisting patterns do not predict future delistings.

---

## License

MIT — see [LICENSE](LICENSE).
