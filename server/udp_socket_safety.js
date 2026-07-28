const dgram = require('dgram');

let installed = false;

function isClosedSocketError(error) {
    return Boolean(error && error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING');
}

function wrapSend(originalSend) {
    if (typeof originalSend !== 'function') {
        throw new TypeError('originalSend must be a function');
    }

    return function safeUdpSend(...args) {
        const callbackIndex = args.length - 1;
        if (callbackIndex >= 0 && typeof args[callbackIndex] === 'function') {
            const callback = args[callbackIndex];
            args[callbackIndex] = function guardedCallback(error, ...rest) {
                if (isClosedSocketError(error)) return undefined;
                return callback.call(this, error, ...rest);
            };
        }

        try {
            return originalSend.apply(this, args);
        } catch (error) {
            // A delayed rate-limit timer can fire after its UDP relay has closed.
            // Dropping that already-stale datagram is correct and prevents an
            // endless stream of uncaught ERR_SOCKET_DGRAM_NOT_RUNNING errors.
            if (isClosedSocketError(error)) return undefined;
            throw error;
        }
    };
}

function install() {
    if (installed) return;
    installed = true;
    dgram.Socket.prototype.send = wrapSend(dgram.Socket.prototype.send);
}

module.exports = {
    install,
    isClosedSocketError,
    wrapSend
};
