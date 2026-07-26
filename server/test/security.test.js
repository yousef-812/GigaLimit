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


test('zero speed blocks before the unlimited stream path', () => {
  const source = read('server/index.js');
  const blocked = source.indexOf("if (bytesPerSecond <= 0) return callback(new Error('User speed limit reached'))");
  const unlimited = source.indexOf('if (bytesPerSecond === Infinity) return callback(null, chunk)');
  assert.ok(blocked >= 0 && unlimited > blocked);
});

test('plain HTTP exposes only signed physical-IP reporting', () => {
  const source = read('server/index.js');
  assert.doesNotMatch(source, /app\.listen\(HTTP_PORT|app\.listen\(3001/);
  assert.match(source, /physicalIpApp\.post\('\/api\/network_ping', handleNetworkPing\)/);
  assert.match(source, /verifyNetworkSignature/);
  assert.match(source, /req\.socket\.remoteAddress/);
});
