# Auto-Update Pipeline — Design Spec

**Date:** 2026-06-27
**Status:** Design approved; pending implementation

## Goal

Automatically detect new Binance monitoring/delisting announcements and Coinbase
trading-status changes once per day, and open a **ready-to-merge PR** that updates the
site's coin data — preserving a human review gate (no auto-merge).

## Decisions (from brainstorm)

| Question | Decision |
|----------|----------|
| Automation level | Auto-parse → ready-to-merge PR (parser edits files; human merges) |
| Cadence | Daily (cron) |
| Scope | Binance (announcement API) **and** Coinbase (products status diff) |
| Binance geo-block | Proxy via the Cloudflare worker (`binance.com` is US-geo-blocked; GitHub runners are US-based) |

## Components

### 1. `worker.js` — new proxy route `/bnann/*`
- Allowlisted route → `https://www.binance.com/bapi/...` (mirrors the existing `/api/*`, `/cb/*` proxy pattern + caching).
- Reason: `data-api.binance.vision` (used for market data) does **not** serve the CMS/announcement API; that lives on `binance.com`, which 451s from US IPs. The worker's Cloudflare edge is the workaround.
- **Requires a worker redeploy.**

### 2. `scripts/check-delistings.mjs` — Node 22 ESM detector + editor
1. Fetch Binance announcement catalogs via `https://shitcoin.io/bnann/...` (delisting catalog + monitoring/notice catalog).
2. Parse titles:
   - `Binance Will Delist <SYMS> on <YYYY-MM-DD>` → status `delisting`/`delisted` (by date vs today)
   - `Extend the Monitoring Tag to Include <SYMS> on <YYYY-MM-DD>` → status `monitoring`
   - Split symbol lists on `,` / `&` / `and`.
3. Parse the current `TRACKED_TOKENS` array out of `index.html` (per-symbol anchored transform; do not rely on `eval`).
4. Diff → new monitoring adds, new delistings, monitoring→delisting flips.
5. Coinbase: fetch `https://api.exchange.coinbase.com/products`, build `{id: {status, trading_disabled}}`, diff vs `data/coinbase-snapshot.json` → newly delisted / limit-only.
6. If changes found, apply edits:
   - `index.html`: add/flip `TRACKED_TOKENS` entries + update the `// Total: N tokens` counts comment.
   - `VERIFIED_DATA.md`: append a dated section with announcement IDs.
   - `data/coinbase-snapshot.json`: rewrite to current state.
7. Emit a markdown summary for the PR body. Low-confidence parses are **listed but not written** ("needs manual review").

### 3. `.github/workflows/check-delistings.yml`
- `on: schedule` daily cron (+ `workflow_dispatch` for manual runs).
- Runs the script, then `peter-evans/create-pull-request` to open/update PR on branch `auto/delisting-update`.
- Permissions: `contents: write`, `pull-requests: write`.

### 4. `data/coinbase-snapshot.json`
- Committed state file enabling day-over-day Coinbase status diffs.

## Data flow

```
cron (daily)
  → script
      → worker proxy (/bnann) → Binance announcement API
      → Coinbase products API
  → diff vs index.html TRACKED_TOKENS + coinbase-snapshot.json
  → edit index.html + VERIFIED_DATA.md + snapshot
  → open/update PR  (human reviews & merges)
```

## Safety / error handling

- **Confident-parse-only**: ambiguous announcements are surfaced in the PR body, never silently written.
- Coin names default to the symbol (optional CoinGecko lookup); maintainer corrects in the PR.
- **No auto-merge** — the PR is the human gate, consistent with the project's verification culture.
- If the Binance fetch fails (geo-block/error): skip Binance, still run Coinbase, note the failure in the run log + PR body.
- **Idempotent**: re-runs update the same `auto/delisting-update` branch; diffs are always vs committed data, so no duplicate entries.
- **Append-only** to data: only add or flip entries; never delete existing history.

## Out of scope (YAGNI for v1)

- Coinbase advance-announcement (blog/RSS) scraping — the API status diff is reliable; advance notice is a later nice-to-have.
- Auto-deploy on merge (deploy stays manual, matching current workflow).
- Stablecoins tab.

## Open items to resolve during implementation

- Confirm exact Binance `catalogId`(s) for delisting + monitoring (test through the proxy).
- Finalize the `TRACKED_TOKENS` string-transform approach (small, well-tested, per-symbol anchored).
- PR auth: default `GITHUB_TOKEN` works for same-repo PRs; repo setting "Allow GitHub Actions to create and approve pull requests" must be enabled.
