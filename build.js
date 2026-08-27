#!/usr/bin/env node
// Builds worker.dist.js by inlining index.html into worker.js
const fs = require('fs');
const path = require('path');

const { injectTrackedTokens } = require('./lib/tracked-tokens.cjs');
const routes = require('./lib/api-routes.cjs');

const html = injectTrackedTokens(
  fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
);
const template = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');

// Syntax-check every inline <script> before it can be inlined into the Worker.
// index.html has no build step of its own, so a malformed edit produced a page
// that served with HTTP 200 and simply did nothing — the whole module failed to
// parse and the table stayed empty. Cheap to catch here; expensive to notice live.
{
  const re = /<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(html)) !== null) {
    n++;
    try {
      new Function(m[1]);
    } catch (e) {
      throw new Error(`build: inline <script> #${n} in index.html has a syntax error — ${e.message}`);
    }
  }
  if (n === 0) throw new Error('build: no inline <script> found in index.html');
}

// worker.js keeps its own copy of the endpoint allowlists so the production
// bundle stays self-contained; server.js reads lib/api-routes.cjs. Assert here
// that they still agree — a route allowlisted in one and not the other means a
// call that works locally and 403s in production (or vice versa).
for (const name of ['BINANCE_ALLOWED', 'COINBASE_ALLOWED', 'COINGECKO_ALLOWED', 'LLAMA_ALLOWED']) {
  const m = template.match(new RegExp(`const ${name}\\s*=\\s*(\\[[^\\]]*\\])`));
  if (!m) throw new Error(`build: ${name} not found in worker.js`);
  const inWorker = JSON.stringify(eval(m[1]));
  const inShared = JSON.stringify(routes[name]);
  if (inWorker !== inShared) {
    throw new Error(
      `build: ${name} has drifted between worker.js and lib/api-routes.cjs\n` +
      `  worker.js : ${inWorker}\n  shared    : ${inShared}`
    );
  }
}

// Escape backticks and ${} in the HTML so it's safe inside a template literal
const escaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

// Use a function replacement to prevent $' and $` from being interpreted as special
// replacement patterns (String.prototype.replace treats $' as "string after match")
const replacement = '`' + escaped + '`';
const out = template.replace('`__HTML_PLACEHOLDER__`', () => replacement);
fs.writeFileSync(path.join(__dirname, 'worker.dist.js'), out);
console.log('Built worker.dist.js (' + Math.round(out.length / 1024) + ' KB)');
