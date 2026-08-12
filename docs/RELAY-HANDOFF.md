# Binance relay — how it works and how to operate it

> ⚠️ **This repo is PUBLIC. Never put the IPRoyal proxy URL, the Render API key, the
> relay token, or any other credential in this file or anywhere else in the repo.**
> Values live in the Render dashboard, Cloudflare secrets, and
> `~/Code/bnbscan/.render-api-key` (mode 600, gitignored).

**Status: live since 2026-08-12.** `curl https://shitcoin.io/api/exchangeInfo` returns
200 with real JSON. It had returned 502 for months.

## Why this exists

The Worker cannot fetch Binance. Two independent reasons, both verified 2026-08-12:

1. **Binance blocks Cloudflare egress.** Disable the proxy and `/api/exchangeInfo`
   returns `{"error":"upstream error"}` — a non-OK response from
   `data-api.binance.vision` itself.
2. **The CONNECT tunnel workaround is dead.** `proxyFetch()` opens a raw socket, issues
   CONNECT (which **succeeds** — `HTTP/1.1 200 Connection Established`), then calls
   `socket.startTls()`, which fails with `TLS Handshake Failed.` Probed live across
   2 proxies × 4 option variants × 4 targets. **`example.com` fails too**, which rules out
   anything upstream-specific: Workers' `startTls()` cannot handshake with a *different*
   host through a CONNECT tunnel. It is built for STARTTLS with the host you dialled.
   curl through the same proxies reaches all four hosts fine. Full write-up in the comment
   above `proxyFetch` in `worker.js`.

**Do not try to fix this with a different proxy.** No proxy fixes it. The credentials are
fine; the Workers socket API is the blocker. `proxyFetch()` is dead code kept only so its
comment stops anyone rebuilding it.

So the Binance call happens in Node instead, where `undici` does CONNECT+TLS correctly,
and the Worker makes an ordinary HTTPS request to that.

```
Render (Node, DIRECT to Binance) <── plain HTTPS + bearer token ── Cloudflare Worker
        │                                                                │
        └──> data-api.binance.vision                    existing cache layer ──> visitors
                                                                │
                        on relay timeout/failure ──> smartFetch fallback (visitor's browser)
```

## Step 1 result: no proxy is needed

The open question was whether Render's datacenter IPs are blocked like Cloudflare's.
**They are not.** From the live service:

```json
{"mode":"direct","node":"v22.23.2","proxyConfigured":false,"direct":{"status":200,"ms":479}}
```

So `PROXY_URL` is **unset** on Render and the IPRoyal proxy is not in the path at all —
one less dependency, one less cost, one less failure mode. Re-check any time with
`curl -H "Authorization: Bearer $RELAY_TOKEN" https://shitcoin-relay.onrender.com/diag`.

If Binance ever starts blocking Render too, the fix needs **no code change**: set
`PROXY_URL` in the Render dashboard to the IPRoyal URL (same value as the Cloudflare
`PROXY_URL` secret) and redeploy. The relay picks its egress mode at boot, exactly like
`scripts/check-delistings.mjs`. `/diag` then also reports whether Render can reach the
proxy's non-standard port 12323 at all.

## What is deployed

| | |
|---|---|
| Render service | `shitcoin-relay` (`srv-d9u1rhrncjis73aas190`), Oregon, **free** plan |
| URL | `https://shitcoin-relay.onrender.com` |
| Source | `relay/` in this repo, branch `claude/binance-relay-shitcoin-ca75fc` ⚠️ see below |
| Render env | `RELAY_TOKEN` (secret), `NODE_VERSION=22`. **No `PROXY_URL`.** |
| Worker secrets | `RELAY_URL`, `RELAY_TOKEN` (`npx wrangler secret list`) |
| Config record | `render.yaml` — the service was created via the API, so keep the two in sync by hand |

**Routes** — mirror `BINANCE_ALLOWED` in `worker.js:15` exactly. Anything else is 404.

| route | upstream | cache TTL |
|---|---|---|
| `GET /binance/ticker/24hr` | `/api/v3/ticker/24hr` | 120s |
| `GET /binance/exchangeInfo` | `/api/v3/exchangeInfo` | 900s |
| `GET /binance/ticker/price` | `/api/v3/ticker/price` | 120s |
| `GET /binance/depth?symbol=` | `/api/v3/depth` | 300s |
| `GET /diag` | — | egress self-test, token required |
| `GET /ping` | — | health check, no auth (Render's monitor has no token) |

**It is not an open proxy.** Every `/binance/*` and `/diag` request needs
`Authorization: Bearer $RELAY_TOKEN`, compared with `timingSafeEqual`. An unset
`RELAY_TOKEN` denies everything rather than allowing everything. Query strings are
rebuilt from a per-endpoint parameter allowlist, so neither the path nor the query can
reach an arbitrary Binance endpoint.

## Things that will bite you

- **The Render service tracks a feature branch.** If
  `claude/binance-relay-shitcoin-ca75fc` is merged and deleted, the service stops
  redeploying and any later relay change silently does nothing. After merging, repoint
  it at `main` in the Render dashboard (Settings → Branch).
- **Free plan sleeps after ~15 min idle** and cold-starts in tens of seconds. The Worker
  gives up after **5s** (`RELAY_TIMEOUT_MS`) and returns 502, at which point
  `smartFetch` in `index.html` fetches Binance from the visitor's own browser — the page
  still works, it just loses the server-side path for that request. In practice the site's
  own 120s refresh keeps the instance warm whenever anyone is looking at it. Upgrade to
  Starter (~$7/mo) to make it always-on.
- **Do not remove the client-side fallback.** It is the safety net for every case above.
- **`exchangeInfo` is 17.5 MB.** The relay gzips it to ~320 KB and memoizes the compressed
  copy on the cache entry; without that, re-compressing on each hit would dominate the
  response on a 0.1-CPU instance. The cache is bounded in **bytes** (64 MB), not entries,
  because 200 × 17.5 MB would OOM a 512 MB box.
- **Deploying the Worker drops Google Analytics unless you fill it in first.** The live
  site runs `G-4MY2VXRGJJ`; the repo has `GA_ID = ''`. Fill it in `index.html`, build,
  deploy, then `git checkout index.html`. **Commit everything before that revert** — it
  discards uncommitted work in that file.
- Wait ~30s after `wrangler deploy` before verifying live; edge propagation is not instant.

## Verify

```bash
# 1. health, no auth
curl https://shitcoin-relay.onrender.com/ping                       # -> 200 {"ok":true,...}

# 2. real data, with auth
curl -H "Authorization: Bearer $RELAY_TOKEN" \
     https://shitcoin-relay.onrender.com/binance/exchangeInfo       # -> 200, 3680 symbols

# 3. still not an open proxy
curl https://shitcoin-relay.onrender.com/binance/exchangeInfo       # -> 401

# 4. the actual goal
curl https://shitcoin.io/api/exchangeInfo                           # -> 200, not {"error":...}
```

5. Load `https://shitcoin.io` with the network tab open: `/api/exchangeInfo` and
   `/api/ticker/24hr` should go to **shitcoin.io**, with no request to
   `data-api.binance.vision`.

Last run 2026-08-12: all five pass. 3680 symbols, 3683 tickers, 374 active coins on the
page, no console errors, and no browser-side Binance requests.

## Rotating the token

Generate a new value, then set it in both places (they must match) and redeploy:

```bash
NEW=$(openssl rand -hex 32)
# Render: dashboard -> shitcoin-relay -> Environment -> RELAY_TOKEN  (triggers a redeploy)
printf '%s' "$NEW" | npx wrangler secret put RELAY_TOKEN
npx wrangler deploy   # remember the GA fill above
```
