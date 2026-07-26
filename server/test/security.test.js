const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('TLS private keys are never committed or bundled', () => {
  assert.equal(fs.existsSync(path.join(root, 'server/public_bundle.js')), false);

  const builder = read('server/build_bundle.js');
  assert.doesNotMatch(builder, /server\.key|server\.cert|sslKey|sslCert/);
  assert.doesNotMatch(builder, /BEGIN (RSA )?PRIVATE KEY/);
});

test('generated bundle contains static UI assets only', () => {
  const builder = read('server/build_bundle.js');
  assert.match(builder, /favicon_b64/);
  assert.match(builder, /TLS keys and certificates are generated per installation/);
});
