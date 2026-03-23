#!/usr/bin/env node
// Builds worker.dist.js by inlining index.html into worker.js
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');

// Escape backticks and ${} in the HTML so it's safe inside a template literal
const escaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

// Use a function replacement to prevent $' and $` from being interpreted as special
// replacement patterns (String.prototype.replace treats $' as "string after match")
const replacement = '`' + escaped + '`';
const out = template.replace('`__HTML_PLACEHOLDER__`', () => replacement);
fs.writeFileSync(path.join(__dirname, 'worker.dist.js'), out);
console.log('Built worker.dist.js (' + Math.round(out.length / 1024) + ' KB)');
