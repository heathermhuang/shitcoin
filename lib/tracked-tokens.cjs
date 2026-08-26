// Single place that injects the tracked-token data into index.html.
//
// data/tracked-tokens.json is the source of truth. index.html carries only the
// placeholder `__TRACKED_TOKENS__`, which is replaced here.
//
// Both entry points call this — build.js on the way to worker.dist.js, and
// server.js when it serves index.html in dev. That is deliberate: the proxy
// prefixes already have to be edited in both files and AGENTS.md documents what
// happens when someone updates one and forgets the other, so this shares one
// implementation rather than adding a second pair to keep in sync.
//
// Previously the array lived inline in index.html and the daily detector edited
// it with line-oriented regexes that required each record to sit on one physical
// line — a contract nothing enforced. Reformatting the array would have made the
// detector silently see fewer tokens. It now reads and writes this JSON instead.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'tracked-tokens.json');
const PLACEHOLDER = '__TRACKED_TOKENS__';

function readTrackedTokens() {
  const tokens = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error('tracked-tokens.json is empty or not an array');
  }
  return tokens;
}

// Replaces the placeholder with a JSON literal. JSON is a subset of JS object
// syntax, so this needs no escaping beyond what JSON.stringify already does —
// except for `</script`, which would close the surrounding <script> element.
function injectTrackedTokens(html, tokens = readTrackedTokens()) {
  if (!html.includes(PLACEHOLDER)) {
    throw new Error(`${PLACEHOLDER} not found in index.html — nothing to inject`);
  }
  const literal = JSON.stringify(tokens).replace(/<\/script/gi, '<\\/script');
  return html.split(PLACEHOLDER).join(literal);
}

module.exports = { readTrackedTokens, injectTrackedTokens, DATA, PLACEHOLDER };
