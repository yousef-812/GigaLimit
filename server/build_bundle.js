const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = ['index.html', 'app.html', 'download.html'];
const bundle = {};

for (const f of files) {
    bundle[f] = fs.readFileSync(path.join(publicDir, f), 'utf8');
}

const favicon = fs.readFileSync(path.join(publicDir, 'favicon.png'));
bundle['favicon_b64'] = favicon.toString('base64');

let sslKey = '';
let sslCert = '';
try {
    sslKey = fs.readFileSync(path.join(__dirname, 'server.key'), 'utf8');
    sslCert = fs.readFileSync(path.join(__dirname, 'server.cert'), 'utf8');
} catch (e) {
    console.log('No SSL certs found, will generate at runtime');
}

const out = [];
out.push('module.exports = {');
out.push('  files: {');
for (const f of files) {
    out.push(`    "${f}": ${JSON.stringify(bundle[f])},`);
}
out.push(`    "favicon_b64": ${JSON.stringify(bundle['favicon_b64'])}`);
out.push('  },');
out.push(`  sslKey: ${JSON.stringify(sslKey)},`);
out.push(`  sslCert: ${JSON.stringify(sslCert)}`);
out.push('};');

fs.writeFileSync(path.join(__dirname, 'public_bundle.js'), out.join('\n'));
console.log('public_bundle.js created (' + Math.round(out.join('\n').length / 1024) + ' KB)');
