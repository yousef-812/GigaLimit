const test = require('node:test');
const assert = require('node:assert/strict');
const { isClosedSocketError, wrapSend } = require('../udp_socket_safety');

test('recognizes ERR_SOCKET_DGRAM_NOT_RUNNING', () => {
    assert.equal(isClosedSocketError({ code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }), true);
    assert.equal(isClosedSocketError({ code: 'EACCES' }), false);
});

test('drops a delayed UDP send after the socket has closed', () => {
    const safeSend = wrapSend(() => {
        const error = new Error('Not running');
        error.code = 'ERR_SOCKET_DGRAM_NOT_RUNNING';
        throw error;
    });

    assert.doesNotThrow(() => safeSend(Buffer.from('stale'), 53, '8.8.8.8'));
});

test('does not hide unrelated UDP failures', () => {
    const safeSend = wrapSend(() => {
        const error = new Error('Permission denied');
        error.code = 'EACCES';
        throw error;
    });

    assert.throws(() => safeSend(Buffer.from('data'), 53, '8.8.8.8'), /Permission denied/);
});

test('suppresses the same closed-socket error received through a callback', () => {
    let callbackCalled = false;
    const safeSend = wrapSend(function (...args) {
        const callback = args.at(-1);
        callback({ code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
    });

    safeSend(Buffer.from('stale'), 53, '8.8.8.8', () => {
        callbackCalled = true;
    });

    assert.equal(callbackCalled, false);
});
