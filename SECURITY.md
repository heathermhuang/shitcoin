# Security Policy

## Scope

shitcoin.io is a static read-only dashboard. It has no user accounts, no authentication, no database, and stores no personal data. The attack surface is narrow: Cloudflare Worker routing, a proxy layer for three third-party APIs, and client-side JavaScript.

## Reporting a vulnerability

If you find a security issue, please report it privately before disclosing publicly.

**How to report:** Open a GitHub issue marked `[SECURITY]` in the title, or email the repo owner directly via the contact listed on their GitHub profile.

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

We aim to respond within 72 hours and to ship a fix within 7 days for confirmed issues.

## What's in scope

- The Cloudflare Worker proxy routes (`/api/*`, `/cb/*`, `/cg/*`, `/ex/*`)
- Client-side JavaScript in `index.html`
- The build pipeline (`build.js`, `server.js`)

## What's out of scope

- Binance, Coinbase, or CoinGecko API vulnerabilities (report those upstream)
- Cloudflare infrastructure issues (report to Cloudflare)
- The domain itself (DNS, SSL managed by Cloudflare)

## Known limitations

- No Content Security Policy is currently enforced — the single-file worker pattern relies on inline scripts throughout. A future refactor could enable a proper CSP.
- The proxy routes proxy to known, hardcoded upstream domains only; arbitrary URL forwarding is not possible.
