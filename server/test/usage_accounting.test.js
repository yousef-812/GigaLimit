const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createUsageMeter } = require('../usage_meter');

function makeDb() {
    const writes = [];
    return {
        writes,
        getLocalDateString: () => '2026-07-28',
        updateUsage: (userId, date, bytes) => writes.push({ userId, date, bytes })
    };
}

test('usage meter accumulates TCP and UDP bytes before flushing', () => {
    const db = makeDb();
    const meter = createUsageMeter(db, 7, 60_000);

    meter.add(100);
    meter.add(250);
    meter.add(0);
    meter.add(Number.NaN);

    assert.equal(meter.pending(), 350);
    assert.equal(meter.flush(), 350);
    assert.deepEqual(db.writes, [{ userId: 7, date: '2026-07-28', bytes: 350 }]);
    meter.stop();
});

test('usage meter flushes remaining bytes once when a session closes', () => {
    const db = makeDb();
    const meter = createUsageMeter(db, 3, 60_000);

    meter.add(512);
    meter.stop();
    meter.stop();

    assert.deepEqual(db.writes, [{ userId: 3, date: '2026-07-28', bytes: 512 }]);
});

test('traffic accounting remains wired to HTTP, TCP, UDP, QUIC, and IPv6 paths', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const vpnSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'mobile_app', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'example', 'mobile_app', 'VpnProxyService.kt'),
        'utf8'
    );
    const tunSource = fs.readFileSync(path.join(__dirname, '..', '..', 'mobile_app', 'tun2socks', 'main.go'), 'utf8');

    assert.match(serverSource, /createUsageMeter/);
    assert.match(serverSource, /sendRateLimitedUdp[\s\S]*onBytes/);
    assert.match(serverSource, /atyp === 0x04/);
    assert.match(vpnSource, /addRoute\("::", 0\)/);
    assert.match(tunSource, /dstIP\.To16\(\)/);
});
