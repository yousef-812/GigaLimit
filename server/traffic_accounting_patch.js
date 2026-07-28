const dgram = require('dgram');
const { createUsageMeter } = require('./usage_meter');

let installed = false;

const normalizeIp = (ip = '') => {
    if (ip.startsWith('::ffff:')) return ip.substring(7);
    if (ip === '::1') return '127.0.0.1';
    return ip;
};

function instrumentUdpSocket(socket, dependencies = {}) {
    const database = dependencies.db || require('./db');
    const meterFactory = dependencies.createUsageMeter || createUsageMeter;
    const originalEmit = socket.emit;
    let usageMeter = null;

    socket.emit = function patchedEmit(eventName, ...args) {
        if (eventName === 'message') {
            const [message, rinfo] = args;
            if (!usageMeter && rinfo && rinfo.address) {
                const user = database.getUserByIp(normalizeIp(rinfo.address));
                if (user) usageMeter = meterFactory(database, user.id);
            }
            if (usageMeter && Buffer.isBuffer(message)) {
                usageMeter.add(message.length);
            }
        } else if (eventName === 'close') {
            usageMeter?.stop();
        }
        return originalEmit.call(this, eventName, ...args);
    };

    return socket;
}

function install() {
    if (installed) return;
    installed = true;

    const originalCreateSocket = dgram.createSocket.bind(dgram);
    dgram.createSocket = function patchedCreateSocket(...args) {
        return instrumentUdpSocket(originalCreateSocket(...args));
    };
}

module.exports = {
    install,
    instrumentUdpSocket,
    normalizeIp
};
