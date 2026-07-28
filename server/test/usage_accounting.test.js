const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createUsageMeter } = require('../usage_meter');
const { instrumentUdpSocket } = require('../traffic_accounting_patch');

function makeDb() {
    const writes = [];
    return {
        writes,
        getLocalDateString: () => '2026-07-28',
        getUserByIp: (ip) => ip === '192.168.1.25' ? { id: 7 } : null,
        updateUsage: (userId, date, bytes) => writes.push({ userId, date, bytes })
    };
}

test('usage meter accumulates bytes before flushing', () => {
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

test('UDP and QUIC packets are attributed in both directions', () => {
    const db = makeDb();
    const socket = instrumentUdpSocket(new EventEmitter(), { db, createUsageMeter });

    socket.emit('message', Buffer.alloc(120), { address: '192.168.1.25', port: 45000 });
    socket.emit('message', Buffer.alloc(380), { address: '142.250.200.14', port: 443 });
    socket.emit('close');

    assert.deepEqual(db.writes, [{ userId: 7, date: '2026-07-28', bytes: 500 }]);
});

test('packaged server always starts through the traffic accounting bootstrap', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const startSource = fs.readFileSync(path.join(__dirname, '..', 'start.js'), 'utf8');

    assert.equal(packageJson.main, 'start.js');
    assert.equal(packageJson.bin, 'start.js');
    assert.match(packageJson.scripts.start, /start\.js/);
    assert.match(packageJson.scripts['build:exe'], /pkg@5\.8\.1 start\.js/);
    assert.match(startSource, /install\(\)/);
    assert.match(startSource, /require\('\.\/index'\)/);
});
