# Binance relay — build brief

> ⚠️ **This repo is PUBLIC. Never put the IPRoyal proxy URL, the Render API key, or any
> token in this file or anywhere else in the repo.** Values live in the Render dashboard,
> Cloudflare secrets, and `~/Code/bnbscan/.render-api-key` (mode 600, gitignored).

## Why this exists

The Worker cannot fetch Binance. Two independent reasons, both verified 2026-08-12:

1. **Binance blocks Cloudflare egress.** Disable the proxy and `/api/exchangeInfo` returns
   `{"error":"upstream error"}` — a non-OK response from `data-api.binance.vision` itself.
2. **The CONNECT tunnel workaround is dead.** `proxyFetch()` opens a raw socket, issues
   CONNECT (which **succeeds** — `HTTP/1.1 200 Connection Established`), then calls
   `socket.startTls()`, which fails with `TLS Handshake Failed.` Probed live across
   2 proxies × 4 option variants × 4 targets. **`example.com` fails too**, which rules out
   anything upstream-specific: Workers' `startTls()` cannot handshake with a *different*
   host through a CONNECT tunnel. It is built for STARTTLS with the host you dialled.
   curl through the same proxies reaches all four hosts fine. Full write-up in the comment
   above `proxyFetch` in `worker.js`.

**Do not try to fix this with a different proxy.** No proxy fixes it. The credentials are
fine; the Workers socket API is the blocker.

Today the site works because `smartFetch` in `index.html` falls back to fetching Binance
**from the visitor's own browser**. That works (374 active coins, live prices) but means
every visitor hits Binance themselves — so anyone behind a corporate DNS filter, a privacy
extension, or a national restriction sees an empty Binance tab.

## Goal

A small Node service on Render that *can* use the proxy properly (Node's `undici` does
CONNECT+TLS correctly — proven daily by `scripts/check-delistings.mjs` in CI). The Worker
then calls it over ordinary HTTPS. No raw sockets anywhere.

```
Render (Node + undici) ──proxy──> data-api.binance.vision
        ▲
        │ plain HTTPS + bearer token
   Cloudflare Worker  ──> existing cache layer ──> visitors
```

## Step 1 before writing any code

**Check whether Render can reach Binance directly.** Render is a datacenter IP so it is
*probably* blocked like Cloudflare — but it has never been tested, and if it works the
relay needs no proxy at all and gets much simpler.

Deploy a one-route service and curl it:

```js
// probe.js
import http from 'node:http';
http.createServer(async (_, res) => {
  const out = {};
  try { const r = await fetch('https://data-api.binance.vision/api/v3/ping'); out.direct = r.status; }
  catch (e) { out.direct = 'ERR ' + e.message; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
}).listen(process.env.PORT || 3000);
```

- `direct: 200` → **no proxy needed.** Skip all proxy wiring below.
- `direct: 4xx/5xx/ERR` → proxy required; continue as designed.

Also confirm Render's egress can reach the proxy's port (**12323**, non-standard — some
hosts restrict outbound ports).

## Relay spec

**Routes** — mirror `BINANCE_ALLOWED` in `worker.js:15` exactly, no open proxy:

| route | upstream | cache TTL |
|---|---|---|
| `GET /binance/ticker/24hr` | `/api/v3/ticker/24hr` | 120s |
| `GET /binance/exchangeInfo` | `/api/v3/exchangeInfo` | 900s |
| `GET /binance/ticker/price` | `/api/v3/ticker/price` | 120s |
| `GET /binance/depth?symbol=` | `/api/v3/depth` | 300s |
| `GET /ping` | — | health check, no auth |

**Auth.** Every `/binance/*` route requires `Authorization: Bearer $RELAY_TOKEN`. Without
this you have published an open Binance proxy on the internet.

**Env vars** (set in the Render dashboard, `sync: false` in `render.yaml`):
- `PROXY_URL` — IPRoyal, `http://user:pass@host:12323`. Same value as the Cloudflare
  `PROXY_URL` secret. Only needed if step 1 says the proxy is required.
- `RELAY_TOKEN` — generate a fresh random token; do not reuse anything.

**Implementation notes**
- Node 22, `undici` `ProxyAgent` — copy the pattern from `scripts/check-delistings.mjs`
  (`binanceDispatcher`), which is the known-good version of exactly this.
- In-memory cache keyed by path with the TTLs above. The Worker caches too, so the relay
  should see very little traffic.
- Return upstream JSON unchanged so the Worker's existing parsing is untouched.

## Worker changes (`worker.js`)

- Add `env.RELAY_URL` + `env.RELAY_TOKEN` (Cloudflare secrets).
- In `cachedProxy`, for Binance upstreams: if `RELAY_URL` is set, `fetch()` the relay with
  the bearer header **instead of** `proxyFetch()`. Leave CoinGecko alone — `31d11e8`
  already routes it direct with `CG_DEMO_KEY` and that works.
- **Use a short timeout (~5s) on the relay fetch.** On a free Render plan a cold start can
  take tens of seconds; the Worker must fail fast so `smartFetch`'s client-side fallback
  takes over rather than the page hanging.
- **Do not remove the client-side fallback.** It is the safety net and it is what is
  keeping the site working today.
- Keep `proxyFetch()` and its post-mortem comment — dead code for now, but the comment is
  the record of why this approach cannot be revived.

## Render plan choice

Free web services sleep after ~15 min idle and cold-start slowly, which is a bad failure
mode in a page's load path. Options:

- **Free** — acceptable only because the Worker cache (120–900s) plus the client fallback
  absorb cold starts. Expect occasional slow first loads.
- **Starter (~$7/mo)** — always on. Recommended if this is meant to be reliable.

Reference `render.yaml` pattern: `~/Code/bnbscan/render.yaml` (services, `sync: false`
secrets, `healthCheckPath`). That project is a much bigger blueprint — copy the shape, not
the scale.

## Verify before declaring done

1. `curl https://<relay>.onrender.com/ping` → 200
2. `curl -H "Authorization: Bearer $RELAY_TOKEN" https://<relay>.onrender.com/binance/exchangeInfo` → 200 with real JSON
3. Same call **without** the header → 401 (not an open proxy)
4. After deploying the Worker: `curl https://shitcoin.io/api/exchangeInfo` → 200, **not**
   `{"error":...}`. This is the actual goal — it has returned 502 for months.
5. Load `https://shitcoin.io` in a browser with the network tab open: Binance requests
   should go to **shitcoin.io**, not to `data-api.binance.vision`.
6. Deploy discipline: **commit before the GA fill-and-revert** (`git checkout index.html`
   wipes uncommitted work), and wait ~30s for edge propagation before verifying live.

## Opener prompt for a fresh session

```
Build the Binance relay for shitcoin.io. Full brief: docs/RELAY-HANDOFF.md in
/Users/heatherm/Documents/Claude/shitcoin — read it first, it explains why the
Worker cannot reach Binance and why no proxy can fix it.

Short version: Binance blocks Cloudflare's IPs, and the CONNECT-tunnel workaround
in worker.js proxyFetch() is dead — CONNECT succeeds but Workers' startTls() fails
against every host including example.com. Node's undici does this correctly, so the
fix is a small Node relay on Render that the Worker calls over plain HTTPS.

Start with Step 1 in the brief: deploy a throwaway probe to find out whether Render
can reach data-api.binance.vision DIRECTLY. If it can, the relay needs no proxy and
gets much simpler. Don't skip this — it has never been tested.

Credentials (never commit any of these — the repo is PUBLIC):
- Render API key: ~/Code/bnbscan/.render-api-key  (RENDER_API_KEY=rnd_…, mode 600)
- IPRoyal proxy: same value as the Cloudflare PROXY_URL secret; set it in the Render
  dashboard only if Step 1 shows the proxy is needed.
- render.yaml pattern to copy: ~/Code/bnbscan/render.yaml

Constraints:
- Token-gate every /binance/* route or you have published an open Binance proxy.
- Mirror BINANCE_ALLOWED (worker.js:15) exactly — no arbitrary path passthrough.
- Short timeout on the Worker's relay fetch, and KEEP the client-side smartFetch
  fallback. It is what keeps the site working today.
- Success = curl https://shitcoin.io/api/exchangeInfo returns 200 with real JSON.
  It has returned 502 for months.
```
