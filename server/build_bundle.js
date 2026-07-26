const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const files = ['index.html', 'app.html', 'download.html'];
const bundle = {};

for (const file of files) {
    bundle[file] = fs.readFileSync(path.join(publicDir, file), 'utf8');
}

const favicon = fs.readFileSync(path.join(publicDir, 'favicon.png'));
bundle.favicon_b64 = favicon.toString('base64');

// TLS keys and certificates are generated per installation at runtime.
// They must never be copied into public_bundle.js or committed to Git.
const output = [];
output.push('module.exports = {');
output.push('  files: {');
for (const file of files) {
    output.push(`    "${file}": ${JSON.stringify(bundle[file])},`);
}
output.push(`    "favicon_b64": ${JSON.stringify(bundle.favicon_b64)}`);
output.push('  }');
output.push('};');

fs.writeFileSync(path.join(__dirname, 'public_bundle.js'), output.join('\n'));
console.log(`public_bundle.js created (${Math.round(output.join('\n').length / 1024)} KB, no TLS keys)`);
