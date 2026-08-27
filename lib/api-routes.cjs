// Endpoint allowlists — the single definition, shared with the dev server.
//
// worker.js keeps its own literal copies on purpose: it is the production
// artifact and staying self-contained keeps its module graph (and therefore the
// wrangler deploy) simple. build.js asserts the two agree and fails the build if
// they drift, so the duplication cannot rot silently.
//
// Without this, server.js proxied any subpath while the Worker 403'd anything
// outside the allowlist — so a call could work locally and be rejected in
// production, which is the class of divergence AGENTS.md warns about for the
// proxy prefixes generally.

const BINANCE_ALLOWED = ['/ticker/24hr', '/depth', '/exchangeInfo', '/ticker/price'];
const COINBASE_ALLOWED = ['/products'];
const COINGECKO_ALLOWED = ['/coins', '/simple/price'];
const LLAMA_ALLOWED = ['/stablecoins'];

function isAllowed(allowlist, subpath) {
  return allowlist.some(p => subpath === p || subpath.startsWith(p + '?') || subpath.startsWith(p + '/'));
}

module.exports = {
  BINANCE_ALLOWED,
  COINBASE_ALLOWED,
  COINGECKO_ALLOWED,
  LLAMA_ALLOWED,
  isAllowed,
};
