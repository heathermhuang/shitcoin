# Contributing to shitcoin.io

Thanks for helping keep this data accurate. The most common and most valuable contributions are data fixes — correcting monitoring tag dates, delisting dates, and restore events as Binance makes announcements.

---

## Reporting data errors

Open an issue with:
- The coin symbol
- What the current value shows
- What it should be
- A link to the official Binance announcement

Binance posts monitoring tag changes and delisting announcements at:
`https://www.binance.com/en/support/announcement/`

---

## Fixing coin data (PRs)

Coin data lives in the `bnCoins` array near the top of `index.html`. Each entry looks like:

```js
{
  sym: 'MDT',
  name: 'Measurable Data',
  status: 'monitoring',        // 'monitoring' | 'delisting' | 'delisted' | 'restored'
  monDate: '2025-06-05',       // date Binance added monitoring tag (YYYY-MM-DD)
  delistDate: null,            // date of delisting, or null
  restoreDate: null,           // date monitoring tag was removed (if restored)
  resources: [                 // optional: positive evidence cards shown in detail panel
    {
      label: 'Transparency Portal',
      url: 'https://example.com/transparency',
      note: 'Brief description of what this shows and why it matters'
    }
  ]
}
```

**Rules:**
- `monDate` = date Binance's announcement was published, not the effective date
- `delistDate` = trading halt date from the delisting announcement
- `status: 'delisted'` when trading has stopped; keep the coin in the list for historical record
- `status: 'restored'` when Binance removes the monitoring tag (add `restoreDate`)
- Sources for all dates should be linkable to a Binance announcement

---

## Adding a `resources` field

If a monitoring-tagged coin has strong transparency signals — a public data portal, audited financials, exchange integrations, real user metrics — add a `resources` array. These show as green "good" cards in the per-coin detail panel.

Good candidates:
- Transparency reports with real revenue or usage data
- On-chain analytics dashboards
- Exchange API integrations showing active usage
- Third-party audits

---

## Code changes

The project is intentionally a single-file worker. Before opening a PR:

- No new npm dependencies (dev or prod)
- No build pipeline changes beyond what `build.js` already does
- Run `node build.js` and verify it produces a valid `worker.dist.js`
- Test locally with `node server.js` and check the three tabs (Binance, Coinbase, Stablecoins)

---

## Pull request checklist

- [ ] Data change: link to the official Binance/exchange announcement in the PR description
- [ ] Code change: tested locally with `node server.js`
- [ ] No new dependencies introduced
- [ ] `worker.dist.js` is NOT committed (it's a build artifact — gitignored)
