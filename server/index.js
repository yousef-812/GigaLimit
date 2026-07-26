const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const url = require('url');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Transform } = require('stream');
const db = require('./db');

const isPkg = typeof process.pkg !== 'undefined';
const appDir = isPkg ? path.dirname(process.execPath) : __dirname;

let pub;
try { pub = require('./public_bundle'); } catch (e) { pub = null; }

const app = express();
const API_PORT = 3000;
const PROXY_PORT = 8080;
const debugLogPath = path.join(appDir, 'vpn_debug.log');
const MAX_DEBUG_LOG_LINES = 1000;

function appendDebugLog(lines) {
    if (!lines) return;
    fs.appendFileSync(debugLogPath, `${lines}\n`);
    const logLines = fs.readFileSync(debugLogPath, 'utf8').split(/\r?\n/).filter(Boolean);
    if (logLines.length > MAX_DEBUG_LOG_LINES) {
        fs.writeFileSync(debugLogPath, `${logLines.slice(-MAX_DEBUG_LOG_LINES).join('\n')}\n`);
    }
}

app.use(cors());
app.use(express.json());

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon'
};

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

function serveFile(req, res, filename) {
    if (pub && pub.files && pub.files[filename]) {
        res.set('Content-Type', mimeTypes[path.extname(filename)] || 'text/html');
        return res.send(pub.files[filename]);
    }
    if (!isPkg) {
        return res.sendFile(path.join(__dirname, 'public', filename));
    }
    res.status(404).send('File not found');
}

function serveFavicon(req, res) {
    if (pub && pub.files && pub.files.favicon_b64) {
        res.set('Content-Type', 'image/png');
        return res.send(Buffer.from(pub.files.favicon_b64, 'base64'));
    }
    if (!isPkg) {
        return res.sendFile(path.join(__dirname, 'public', 'favicon.png'));
    }
    res.status(404).end();
}

app.get('/favicon.png', serveFavicon);
app.get('/favicon.ico', serveFavicon);

app.get('/', (req, res) => serveFile(req, res, 'index.html'));
app.get('/app.html', (req, res) => serveFile(req, res, 'app.html'));
app.get('/download', (req, res) => serveFile(req, res, 'download.html'));

if (!isPkg) {
    app.use(express.static(path.join(__dirname, 'public')));
}

app.get('/download_app', (req, res) => {
    const apkPath = path.join(appDir, 'GigaLimit_App.apk');
    if (fs.existsSync(apkPath)) {
        res.download(apkPath, 'GigaLimit_App.apk');
    } else {
        res.status(404).send('APK not found on server.');
    }
});

const normalizeIp = (ip = '') => {
    if (ip.startsWith('::ffff:')) return ip.substring(7);
    if (ip === '::1') return '127.0.0.1';
    return ip;
};

// This LAN service is directly exposed, so forwarded headers are untrusted.
const getCleanIp = (req) => normalizeIp(req.socket.remoteAddress || '');

const publicUser = (user) => {
    if (!user) return user;
    const { device_token, ...safeUser } = user;
    return safeUser;
};

const requireDevice = (req, res, deviceId) => {
    const token = req.headers['x-device-token'];
    if (!db.verifyDeviceToken(deviceId, token)) {
        res.status(401).json({ error: 'Invalid device credentials' });
        return null;
    }
    return db.getUserByDeviceId(deviceId);
};

const usedNetworkSignatures = new Map();
const verifyNetworkSignature = (deviceId, timestamp, signature) => {
    const user = db.getUserByDeviceId(deviceId);
    const timestampNumber = Number(timestamp);
    if (!user || !user.device_token || !Number.isFinite(timestampNumber) || typeof signature !== 'string') return false;
    if (Math.abs(Date.now() - timestampNumber) > 30_000) return false;

    const now = Date.now();
    for (const [usedSignature, usedAt] of usedNetworkSignatures) {
        if (now - usedAt > 60_000) usedNetworkSignatures.delete(usedSignature);
    }
    if (usedNetworkSignatures.has(signature)) return false;

    const expectedHex = crypto
        .createHmac('sha256', user.device_token)
        .update(`${deviceId}:${timestamp}`)
        .digest('hex');
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
    const expected = Buffer.from(expectedHex, 'hex');
    const supplied = Buffer.from(signature, 'hex');
    const valid = expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
    if (valid) usedNetworkSignatures.set(signature, now);
    return valid;
};

// --- MOBILE APP API ---

app.post('/api/register', (req, res) => {
    const { device_id, name, device_token, legacy_migration } = req.body;
    const ip = getCleanIp(req);

    if (!device_id || !name) return res.status(400).json({ error: 'device_id and name required' });

    const existing = db.getUserByDeviceId(device_id);
    if (existing && existing.device_token && !db.verifyDeviceToken(device_id, device_token)) {
        return res.status(401).json({ error: 'Device is already registered' });
    }
    if (existing && !existing.device_token) {
        const sameIp = !existing.current_ip || existing.current_ip === ip;
        const namedLegacyMigration = legacy_migration === true && existing.name === name;
        if (!sameIp && !namedLegacyMigration) {
            return res.status(401).json({ error: 'Legacy device migration rejected' });
        }
    }

    const defaultLimit = db.getSetting('global_daily_limit_mb') || 1024;
    const user = db.registerUser(name, device_id, ip, defaultLimit);

    res.json({
        success: true,
        user: publicUser(user),
        device_token: user.device_token,
        registered_ip: ip
    });
});

app.post('/api/ping', (req, res) => {
    res.json({ success: true });
});

const handleNetworkPing = (req, res) => {
    const { device_id } = req.body;
    const timestamp = req.headers['x-device-timestamp'];
    const signature = req.headers['x-device-signature'];
    const ip = getCleanIp(req);

    if (!verifyNetworkSignature(device_id, timestamp, signature)) {
        return res.status(401).json({ error: 'Invalid or replayed network signature' });
    }

    const user = db.getUserByDeviceId(device_id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.current_ip !== ip) {
        db.updateUserIp(device_id, ip);
        appendDebugLog(`${new Date().toISOString()} [NETWORK_PING ${user.name} #${user.id}] ${ip}`);
    }
    res.json({ success: true, registered_ip: ip });
};

app.post('/api/network_ping', handleNetworkPing);

app.post('/api/clear_notification', (req, res) => {
    const { device_id } = req.body;
    const user = requireDevice(req, res, device_id);
    if (!user) return;
    db.clearNotification(user.id);
    res.json({ success: true });
});

app.post('/api/debug', (req, res) => {
    const { device_id, logs } = req.body;
    const user = requireDevice(req, res, device_id);
    if (!user) return;
    if (!Array.isArray(logs)) return res.status(400).json({ error: 'logs must be an array' });

    const prefix = `${new Date().toISOString()} [${user.name} #${user.id}]`;
    const lines = logs.slice(-100)
        .map(log => `${prefix} ${String(log).replace(/[
]/g, ' ').slice(0, 2000)}`)
        .join('
');
    appendDebugLog(lines);
    res.json({ success: true });
});

app.get('/api/status/:device_id', (req, res) => {
    const deviceId = req.params.device_id;
    const user = requireDevice(req, res, deviceId);
    if (!user) return;
    const today = db.getLocalDateString();

    const bytesUsed = db.getUsage(user.id, today);
    const weeklyBytesUsed = db.getWeeklyUsage(user.id);
    const dailyLimitBytes = user.daily_limit_mb * 1024 * 1024;
    const weeklyLimitBytes = (user.weekly_limit_mb || (user.daily_limit_mb * 7)) * 1024 * 1024;

    res.json({
        user: publicUser(user),
        usage_today_bytes: bytesUsed,
        daily_remaining_bytes: Math.max(0, dailyLimitBytes - bytesUsed),
        weekly_usage_bytes: weeklyBytesUsed,
        weekly_limit_bytes: weeklyLimitBytes,
        can_connect: getEffectiveUserSpeed(user) > 0,
        pending_notification: user.pending_notification || null
    });
});

// --- ADMIN API ---
const adminAuth = (req, res, next) => {
    const password = req.headers['authorization'];
    if (password === db.getSetting('admin_password')) next();
    else res.status(401).json({ error: 'Unauthorized' });
};

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === db.getSetting('admin_password')) res.json({ success: true, token: password });
    else res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/admin/debug', adminAuth, (req, res) => {
    if (!fs.existsSync(debugLogPath)) return res.json({ logs: '' });
    const logs = fs.readFileSync(debugLogPath, 'utf8');
    res.json({ logs: logs.slice(-100000) });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
    const today = db.getLocalDateString();
    res.json(db.getUsersWithUsage(today).map(publicUser));
});

app.post('/api/admin/update_user', adminAuth, (req, res) => {
    const { id, status, daily_limit_mb, weekly_limit_mb, speed_limit_bps, exhausted_speed_limit_bps } = req.body;
    if (db.updateUserSettings(id, status, daily_limit_mb, weekly_limit_mb, speed_limit_bps, exhausted_speed_limit_bps)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'User not found' });
    }
});

app.post('/api/admin/set_usage', adminAuth, (req, res) => {
    const { id, daily_bytes, weekly_bytes } = req.body;
    if (db.setUsageDirectly(id, daily_bytes, weekly_bytes)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'User not found' });
    }
});

app.post('/api/admin/send_notification', adminAuth, (req, res) => {
    const { id, message } = req.body;
    if (db.setNotification(id, message)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'User not found' });
    }
});

app.post('/api/admin/renew_daily', adminAuth, (req, res) => {
    const { id } = req.body;
    const today = db.getLocalDateString();
    db.resetUsage(id, today);
    res.json({ success: true });
});

app.post('/api/admin/renew_weekly', adminAuth, (req, res) => {
    const { id } = req.body;
    db.resetWeeklyUsage(id);
    res.json({ success: true });
});

app.get('/api/admin/global_settings', adminAuth, (req, res) => {
    res.json({ 
        global_limit: db.getSetting('global_daily_limit_mb') || 1024,
        global_weekly_limit: db.getSetting('global_weekly_limit_mb') || 7000,
        global_speed_limit_bps: db.getSetting('global_speed_limit_bps') || 0,
        global_exhausted_speed_limit_bps: db.getSetting('global_exhausted_speed_limit_bps') || 0,
        global_total_bytes: db.getSetting('global_total_bytes_used') || 0,
        server_date: db.getLocalDateString(),
        server_time: new Date().toLocaleTimeString()
    });
});

app.post('/api/admin/global_settings', adminAuth, (req, res) => {
    const { global_limit, global_weekly_limit, global_speed_limit_bps, global_exhausted_speed_limit_bps } = req.body;
    db.updateGlobalLimit(global_limit, global_weekly_limit, global_speed_limit_bps, global_exhausted_speed_limit_bps);
    res.json({ success: true });
});

app.post('/api/admin/reset_user', adminAuth, (req, res) => {
    const { id } = req.body;
    db.resetUserToDefault(id);
    res.json({ success: true });
});

app.post('/api/admin/reset_global_total', adminAuth, (req, res) => {
    db.resetGlobalTotal();
    res.json({ success: true });
});

app.post('/api/admin/delete_user', adminAuth, (req, res) => {
    const { id } = req.body;
    if (db.deleteUser(id)) {
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'User not found' });
    }
});


// --- PROXY ENGINE ---
const proxyServer = http.createServer((req, res) => {
    let clientIp = req.socket.remoteAddress;
    if (clientIp.includes('::ffff:')) clientIp = clientIp.split('::ffff:')[1];

    const parsedUrl = url.parse(req.url);
    
    if (!parsedUrl.hostname) {
        res.writeHead(400);
        res.end('Direct access not allowed. Please use port 3000 to access the Control Panel or Web App.');
        return;
    }

    const isLocal = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost' || (parsedUrl.hostname && parsedUrl.hostname.startsWith('192.168.'));

    if (!isLocal && !isAllowed(clientIp)) {
        res.writeHead(403);
        res.end('Forbidden: Not Registered or Quota Exceeded');
        return;
    }

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.path,
        method: req.method,
        headers: { ...req.headers, 'x-forwarded-for': clientIp }
    };

    try {
        const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            rateLimitedPipe(proxyRes, res, () => getSpeedForIp(clientIp), clientIp);
        });

        proxyReq.on('error', (e) => {
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
        });

        req.on('error', () => {});
        res.on('error', () => {});

        rateLimitedPipe(req, proxyReq, () => getSpeedForIp(clientIp), clientIp);
    } catch (err) {
        console.error('Invalid Proxy Request:', err.message);
        if (!res.headersSent) {
            res.writeHead(400);
            res.end('Bad Request');
        }
    }
});

const authCache = new Map();

function getEffectiveUserSpeed(user) {
    if (!user || user.status === 'blocked') return 0;
    if (user.status === 'unlimited') return Infinity;

    const today = db.getLocalDateString();
    const dailyLimit = user.daily_limit_mb * 1024 * 1024;
    const weeklyLimit = (user.weekly_limit_mb || (user.daily_limit_mb * 7)) * 1024 * 1024;
    const exhausted = db.getUsage(user.id, today) >= dailyLimit || db.getWeeklyUsage(user.id) >= weeklyLimit;
    const settingName = exhausted ? 'global_exhausted_speed_limit_bps' : 'global_speed_limit_bps';
    const userSpeed = exhausted ? user.exhausted_speed_limit_bps : user.speed_limit_bps;
    const speed = userSpeed === null || userSpeed === undefined
        ? db.getSetting(settingName)
        : userSpeed;

    // 0 means unlimited before quota; after quota it means block by default.
    return Number(speed) || (exhausted ? 0 : Infinity);
}

function getSpeedForIp(ip) {
    return getEffectiveUserSpeed(db.getUserByIp(ip));
}

const bucketRegistry = new Map();

function getBucket(ip) {
    let bucket = bucketRegistry.get(ip);
    if (!bucket) {
        bucket = { tokens: 0, lastRefill: Date.now(), speedBps: 0 };
        bucketRegistry.set(ip, bucket);
    }
    return bucket;
}

function consumeTokens(bucket, bytes, speedBps) {
    if (speedBps !== bucket.speedBps) {
        bucket.tokens = Math.min(bucket.tokens, speedBps);
        bucket.speedBps = speedBps;
    }
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(speedBps, bucket.tokens + elapsed * speedBps);
    bucket.lastRefill = now;

    if (bucket.tokens >= bytes) {
        bucket.tokens -= bytes;
        return 0;
    }
    const deficit = bytes - bucket.tokens;
    const delayMs = (deficit / speedBps) * 1000;
    bucket.tokens = 0;
    return delayMs;
}

setInterval(() => {
    for (const [ip, bucket] of bucketRegistry) {
        const now = Date.now();
        const elapsed = (now - bucket.lastRefill) / 1000;
        bucket.tokens = Math.min(bucket.speedBps, bucket.tokens + elapsed * bucket.speedBps);
        bucket.lastRefill = now;
    }
}, 1000);

function rateLimitedPipe(source, destination, getSpeed, ip) {
    const limiter = new Transform({
        transform(chunk, encoding, callback) {
            const bytesPerSecond = getSpeed();
            if (bytesPerSecond <= 0) return callback(new Error('User speed limit reached'));
            if (bytesPerSecond === Infinity) return callback(null, chunk);
            const bucket = getBucket(ip);
            const delay = consumeTokens(bucket, chunk.length, bytesPerSecond);
            if (delay <= 0) return callback(null, chunk);
            setTimeout(() => callback(null, chunk), Math.ceil(delay));
        }
    });
    limiter.on('error', () => {
        source.destroy();
        destination.destroy();
    });
    source.pipe(limiter).pipe(destination);
}

function sendRateLimitedUdp(socket, message, port, host, getSpeed, ip) {
    const bytesPerSecond = getSpeed();
    if (bytesPerSecond <= 0) return;
    const send = () => socket.send(message, port, host);
    if (bytesPerSecond === Infinity || !bytesPerSecond) return send();
    const bucket = getBucket(ip);
    const delay = consumeTokens(bucket, message.length, bytesPerSecond);
    if (delay <= 0) return send();
    setTimeout(send, Math.ceil(delay));
}

const isAllowed = (ip) => {
    const now = Date.now();
    if (authCache.has(ip) && now - authCache.get(ip).time < 10000) {
        return authCache.get(ip).allowed;
    }

    const today = db.getLocalDateString();
    const user = db.getUserByIp(ip);
    
    if (!user || user.status === 'blocked') {
        authCache.set(ip, { allowed: false, user: null, time: now });
        return false;
    }
    
    const allowed = getEffectiveUserSpeed(user) > 0;
    
    authCache.set(ip, { allowed, user: user, time: now });
    return allowed;
};

proxyServer.on('connect', (req, clientSocket, head) => {
    let clientIp = req.socket.remoteAddress;
    if (clientIp.includes('::ffff:')) clientIp = clientIp.split('::ffff:')[1];

    if (!isAllowed(clientIp)) {
        return;
    }

    req.on('error', () => {});
    clientSocket.on('error', () => {});

    const { port, hostname } = url.parse(`http://${req.url}`);
    
    try {
        const serverSocket = net.connect(port || 443, hostname, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            serverSocket.write(head);
            rateLimitedPipe(clientSocket, serverSocket, () => getSpeedForIp(clientIp), clientIp);
            rateLimitedPipe(serverSocket, clientSocket, () => getSpeedForIp(clientIp), clientIp);
        });

        const user = db.getUserByIp(clientIp);
        const userId = user ? user.id : null;

        let bytesTransferred = 0;
        serverSocket.on('data', (chunk) => bytesTransferred += chunk.length);
        clientSocket.on('data', (chunk) => bytesTransferred += chunk.length);

        const saveStats = () => {
            if (bytesTransferred > 0 && userId) {
                const today = db.getLocalDateString();
                db.updateUsage(userId, today, bytesTransferred);
                bytesTransferred = 0;
            }
            if (!isAllowed(clientIp)) {
                clientSocket.pause();
                if (serverSocket) serverSocket.pause();
            }
        };

        const interval = setInterval(saveStats, 5000);

        const onEnd = () => {
            clearInterval(interval);
            saveStats();
        };

        serverSocket.on('end', onEnd);
        clientSocket.on('end', onEnd);
        serverSocket.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => {
            if (serverSocket) serverSocket.destroy();
        });
    } catch (err) {
        console.error('Invalid Connect Request:', err.message);
        clientSocket.destroy();
    }
});

// --- SSL + HTTPS ---
function getSSL() {
    const keyPath = path.join(appDir, 'server.key');
    const certPath = path.join(appDir, 'server.cert');
    const rotationMarker = path.join(appDir, 'ssl_key_version_2');

    // Rotate the formerly bundled key once, then keep a unique key per installation.
    if (!fs.existsSync(rotationMarker)) {
        try { fs.unlinkSync(keyPath); } catch (_) {}
        try { fs.unlinkSync(certPath); } catch (_) {}
    }

    try {
        if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
            return {
                key: fs.readFileSync(keyPath, 'utf8'),
                cert: fs.readFileSync(certPath, 'utf8')
            };
        }

        const forge = require('node-forge');
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = crypto.randomBytes(16).toString('hex');
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
        const ip = getLocalIP();
        const attributes = [{ name: 'commonName', value: ip }];
        cert.setSubject(attributes);
        cert.setIssuer(attributes);
        cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip }] }]);
        cert.sign(keys.privateKey, forge.md.sha256.create());
        const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
        const certPem = forge.pki.certificateToPem(cert);
        fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
        fs.writeFileSync(certPath, certPem);
        fs.writeFileSync(rotationMarker, 'per-installation TLS key v2
');
        console.log(`[SSL] Generated a unique self-signed certificate for IP: ${ip}`);
        return { key: keyPem, cert: certPem };
    } catch (error) {
        console.error('[SSL] Failed to prepare certificate:', error.message);
        return null;
    }
}

const localIP = getLocalIP();

try {
    const https = require('https');
    const ssl = getSSL();
    if (!ssl) throw new Error('TLS certificate unavailable');
    https.createServer(ssl, app).listen(API_PORT, '0.0.0.0', () => {
        console.log(`Giga Limit API running securely on HTTPS port ${API_PORT}`);
        console.log(`Admin login: https://${localIP}:${API_PORT} (password in admin_credentials.txt)`);
        console.log(`Local: https://localhost:${API_PORT}`);
    });
} catch (error) {
    console.error(`[SSL] Refusing to expose the admin API without HTTPS: ${error.message}`);
    process.exit(1);
}

// Plain HTTP is restricted to signed physical-IP reports only.
const physicalIpApp = express();
physicalIpApp.use(express.json({ limit: '16kb' }));
physicalIpApp.post('/api/network_ping', handleNetworkPing);
physicalIpApp.listen(3001, '0.0.0.0', () => {
    console.log('Signed physical-IP reporter listening on HTTP port 3001');
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`Giga Limit Proxy Engine v3 running on port ${PROXY_PORT}`);
});

// --- SOCKS5 ENGINE ---
const socksServer = net.createServer((clientSocket) => {
    let clientIp = clientSocket.remoteAddress;
    if (clientIp && clientIp.includes('::ffff:')) clientIp = clientIp.split('::ffff:')[1];

    if (!isAllowed(clientIp)) {
        return;
    }

    clientSocket.on('error', () => {});

    clientSocket.once('data', (data) => {
        if (data[0] !== 0x05) {
            clientSocket.end();
            return;
        }
        clientSocket.write(Buffer.from([0x05, 0x00]));

        clientSocket.once('data', (reqData) => {
            if (reqData[0] !== 0x05 || (reqData[1] !== 0x01 && reqData[1] !== 0x03)) {
                clientSocket.end();
                return;
            }

            if (reqData[1] === 0x03) {
                handleSocksUdpAssociation(clientSocket, clientIp);
                return;
            }

            const atyp = reqData[3];
            let host;
            let portOffset;

            if (atyp === 0x01) {
                host = `${reqData[4]}.${reqData[5]}.${reqData[6]}.${reqData[7]}`;
                portOffset = 8;
            } else if (atyp === 0x03) {
                const domainLen = reqData[4];
                host = reqData.toString('utf8', 5, 5 + domainLen);
                portOffset = 5 + domainLen;
            } else {
                clientSocket.end();
                return;
            }

            const port = reqData.readUInt16BE(portOffset);

            try {
                const serverSocket = net.connect(port, host, () => {
                    const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
                    clientSocket.write(reply);
                    rateLimitedPipe(clientSocket, serverSocket, () => getSpeedForIp(clientIp), clientIp);
                    rateLimitedPipe(serverSocket, clientSocket, () => getSpeedForIp(clientIp), clientIp);
                });

                const user = db.getUserByIp(clientIp);
                const userId = user ? user.id : null;

                let bytesTransferred = 0;
                serverSocket.on('data', (chunk) => bytesTransferred += chunk.length);
                clientSocket.on('data', (chunk) => bytesTransferred += chunk.length);

                const saveStats = () => {
                    if (bytesTransferred > 0 && userId) {
                        const today = db.getLocalDateString();
                        db.updateUsage(userId, today, bytesTransferred);
                        bytesTransferred = 0;
                    }
                    if (!isAllowed(clientIp)) {
                        clientSocket.pause();
                        if (serverSocket) serverSocket.pause();
                    }
                };

                const interval = setInterval(saveStats, 5000);

                const onEnd = () => {
                    clearInterval(interval);
                    saveStats();
                };

                serverSocket.on('end', onEnd);
                clientSocket.on('end', onEnd);
                serverSocket.on('error', () => clientSocket.end());
                clientSocket.on('error', () => {
                    if (serverSocket) serverSocket.end();
                });
            } catch (err) {
                console.error('Invalid SOCKS5 Request:', err.message);
                clientSocket.end();
            }
        });
    });
});

function handleSocksUdpAssociation(clientSocket, clientIp) {
    const relay = dgram.createSocket('udp4');
    let clientUdpPort = null;

    const closeRelay = () => {
        try { relay.close(); } catch (_) {}
    };

    clientSocket.once('close', closeRelay);
    clientSocket.once('error', closeRelay);

    relay.on('error', closeRelay);
    relay.on('message', (message, rinfo) => {
        // The first UDP packet identifies the source port selected by the client.
        if (rinfo.address === clientIp && (clientUdpPort === null || rinfo.port === clientUdpPort)) {
            clientUdpPort = rinfo.port;
            if (message.length < 10 || message[0] !== 0 || message[1] !== 0 || message[2] !== 0) return;

            const atyp = message[3];
            let host;
            let portOffset;
            if (atyp === 0x01) {
                host = `${message[4]}.${message[5]}.${message[6]}.${message[7]}`;
                portOffset = 8;
            } else if (atyp === 0x03) {
                const domainLength = message[4];
                if (message.length < 5 + domainLength + 2) return;
                host = message.toString('utf8', 5, 5 + domainLength);
                portOffset = 5 + domainLength;
            } else {
                return;
            }

            if (message.length < portOffset + 2) return;
            const port = message.readUInt16BE(portOffset);
                sendRateLimitedUdp(relay, message.subarray(portOffset + 2), port, host, () => getSpeedForIp(clientIp), clientIp);
            return;
        }

        if (clientUdpPort === null || rinfo.address === clientIp) return;
        const octets = rinfo.address.split('.').map(Number);
        if (octets.length !== 4 || octets.some(Number.isNaN)) return;
        const header = Buffer.from([
            0x00, 0x00, 0x00, 0x01,
            ...octets,
            rinfo.port >> 8, rinfo.port & 0xff
        ]);
                sendRateLimitedUdp(relay, Buffer.concat([header, message]), clientUdpPort, clientIp, () => getSpeedForIp(clientIp), clientIp);
    });

    relay.bind(0, '0.0.0.0', () => {
        const relayPort = relay.address().port;
        let localIp = clientSocket.localAddress || '0.0.0.0';
        if (localIp.startsWith('::ffff:')) localIp = localIp.substring(7);
        const octets = localIp.split('.').map(Number);
        const replyIp = octets.length === 4 && octets.every(Number.isFinite) ? octets : [0, 0, 0, 0];
        clientSocket.write(Buffer.from([
            0x05, 0x00, 0x00, 0x01,
            ...replyIp,
            relayPort >> 8, relayPort & 0xff
        ]));
    });
}

socksServer.listen(1080, '0.0.0.0', () => {
    console.log(`Giga Limit SOCKS5 Engine running on port 1080`);
});

// --- HOTSPOT BLOCKER ---
if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    const path = require('path');
    const fs = require('fs');
    const taskName = 'GigaLimit_HotspotBlocker';

    const blockScript = `
$block = {
    try { netsh wlan stop hostednetwork 2>$null } catch {}
    try { Get-NetAdapter | Where-Object {
        $_.InterfaceDescription -like '*Mobile Hotspot*' -or
        $_.InterfaceDescription -like '*Wi-Fi Direct*' -or
        $_.InterfaceDescription -like '*Hosted Network*' -or
        $_.InterfaceDescription -like '*Microsoft Wi-Fi Direct*' -or
        $_.InterfaceDescription -like '*Shared*'
    } | Disable-NetAdapter -Confirm:$false } catch {}
    try { Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\icssvc\\Settings' -Name 'Enabled' -Value 0 -ErrorAction SilentlyContinue } catch {}
    try { sc config ICS start= disabled 2>$null; sc stop ICS 2>$null } catch {}
    try { sc config SharedAccess start= disabled 2>$null; sc stop SharedAccess 2>$null } catch {}
};
$block | Out-Null;
`.trim();

    const scriptPath = path.join(appDir, 'hotspot_block.ps1');
    fs.writeFileSync(scriptPath, blockScript);

    function setupHotspotBlocker() {
        try {
            execSync(`powershell -Command "Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue"`, { stdio: 'ignore', timeout: 8000 });
        } catch (_) {}

        try {
            const action = `-Action Execute -Argument '-NoProfile -WindowStyle Hidden -File "${scriptPath}"' -FilePath powershell`;
            const trigger = `-Once -At (Get-Date).AddSeconds(2) -RepetitionInterval (New-TimeSpan -Seconds 10) -RepetitionDuration (New-TimeSpan -Days 3650)`;
            const settings = `-Settings AllowStartIfOnBatteries -StartWhenAvailable -DontStopOnIdleEnd`;
            const principal = `-Principal $env:USERNAME -RunLevel Highest`;
            const cmd = `Register-ScheduledTask -TaskName '${taskName}' ${action} ${trigger} ${settings} ${principal} -Force`;
            execSync(`powershell -Command "${cmd.replace(/"/g, '\\"')}"`, { stdio: 'ignore', timeout: 15000 });
            console.log('[HOTSPOT] Scheduled task created - hotspot blocker active');
            return true;
        } catch (e) {
            console.log('[HOTSPOT] Could not create scheduled task:', e.message);
            return false;
        }
    }

    function runOnceElevated() {
        try {
            const cmd = `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -WindowStyle Hidden -File "${scriptPath}"' -Wait -WindowStyle Hidden`;
            execSync(`powershell -Command "${cmd.replace(/"/g, '\\"')}"`, { stdio: 'ignore', timeout: 20000 });
            console.log('[HOTSPOT] First run executed with admin privileges');
            return true;
        } catch (_) {
            return false;
        }
    }

    let hasAdmin = false;
    try {
        execSync('net session', { stdio: 'ignore', timeout: 3000 });
        hasAdmin = true;
    } catch (_) {}

    if (hasAdmin) {
        setupHotspotBlocker();
    } else {
        console.log('[HOTSPOT] Requesting admin for initial setup...');
        if (runOnceElevated()) {
            setupHotspotBlocker();
        } else {
            console.log('[HOTSPOT] Admin denied - hotspot blocker disabled. Right-click the EXE > Run as administrator.');
        }
    }
}

process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') {
        return;
    }
    console.error('Unhandled Exception:', err);
});
