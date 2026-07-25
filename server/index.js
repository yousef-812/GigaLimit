const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const url = require('url');
const fs = require('fs');
const os = require('os');
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

const getCleanIp = (req) => {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip.includes('::ffff:')) ip = ip.split('::ffff:')[1];
    return ip;
};

// --- MOBILE APP API ---

app.post('/api/register', (req, res) => {
    const { device_id, name } = req.body;
    const ip = getCleanIp(req);
    
    if (!device_id || !name) return res.status(400).json({ error: 'device_id and name required' });

    const defaultLimit = db.getSetting('global_daily_limit_mb') || 1024;
    const user = db.registerUser(name, device_id, ip, defaultLimit);
    
    res.json({ success: true, user, registered_ip: ip });
});

app.post('/api/ping', (req, res) => {
    // This request can travel through the VPN proxy, where its source becomes
    // the server itself. IP changes are accepted only from network_ping below.
    res.json({ success: true });
});

app.post('/api/network_ping', (req, res) => {
    const { device_id } = req.body;
    const ip = getCleanIp(req);
    const user = db.getUserByDeviceId(device_id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.current_ip !== ip) {
        db.updateUserIp(device_id, ip);
        appendDebugLog(`${new Date().toISOString()} [NETWORK_PING ${user.name} #${user.id}] ${ip}`);
    }
    res.json({ success: true, registered_ip: ip });
});

app.post('/api/clear_notification', (req, res) => {
    const { device_id } = req.body;
    const user = db.getUserByDeviceId(device_id);
    if (user) {
        db.clearNotification(user.id);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

app.post('/api/debug', (req, res) => {
    const { device_id, logs } = req.body;
    const user = db.getUserByDeviceId(device_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!Array.isArray(logs)) return res.status(400).json({ error: 'logs must be an array' });

    const prefix = `${new Date().toISOString()} [${user.name} #${user.id}]`;
    const lines = logs.slice(-100)
        .map(log => `${prefix} ${String(log).replace(/[\r\n]/g, ' ').slice(0, 2000)}`)
        .join('\n');
    appendDebugLog(lines);
    res.json({ success: true });
});

app.get('/api/status/:device_id', (req, res) => {
    const device_id = req.params.device_id;
    const ip = getCleanIp(req);
    const today = db.getLocalDateString();
    
    const user = db.getUserByDeviceId(device_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const bytes_used = db.getUsage(user.id, today);
    const weekly_bytes_used = db.getWeeklyUsage(user.id);
    const daily_limit_bytes = user.daily_limit_mb * 1024 * 1024;
    const weekly_limit_bytes = (user.weekly_limit_mb || (user.daily_limit_mb * 7)) * 1024 * 1024;
    
    res.json({
        user,
        usage_today_bytes: bytes_used,
        daily_remaining_bytes: Math.max(0, daily_limit_bytes - bytes_used),
        weekly_usage_bytes: weekly_bytes_used,
        weekly_limit_bytes: weekly_limit_bytes,
        can_connect: user.status === 'unlimited' || (user.status === 'active' && bytes_used < daily_limit_bytes && weekly_bytes_used < weekly_limit_bytes),
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
    res.json(db.getUsersWithUsage(today));
});

app.post('/api/admin/update_user', adminAuth, (req, res) => {
    const { id, status, daily_limit_mb, weekly_limit_mb } = req.body;
    if (db.updateUserSettings(id, status, daily_limit_mb, weekly_limit_mb)) {
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
        global_total_bytes: db.getSetting('global_total_bytes_used') || 0,
        server_date: db.getLocalDateString(),
        server_time: new Date().toLocaleTimeString()
    });
});

app.post('/api/admin/global_settings', adminAuth, (req, res) => {
    const { global_limit, global_weekly_limit } = req.body;
    db.updateGlobalLimit(global_limit, global_weekly_limit);
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
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (e) => {
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
        });

        req.on('error', () => {});
        res.on('error', () => {});

        req.pipe(proxyReq);
    } catch (err) {
        console.error('Invalid Proxy Request:', err.message);
        if (!res.headersSent) {
            res.writeHead(400);
            res.end('Bad Request');
        }
    }
});

const authCache = new Map();

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
    
    if (user.status === 'unlimited') {
        authCache.set(ip, { allowed: true, user: user, time: now });
        return true;
    }

    const bytes_used = db.getUsage(user.id, today);
    const weekly_bytes_used = db.getWeeklyUsage(user.id);
    const daily_limit_bytes = user.daily_limit_mb * 1024 * 1024;
    const weekly_limit_bytes = (user.weekly_limit_mb || (user.daily_limit_mb * 7)) * 1024 * 1024;
    
    let allowed = false;
    if (user.status === 'unlimited') {
        allowed = true;
    } else if (user.status === 'active') {
        allowed = bytes_used < daily_limit_bytes && weekly_bytes_used < weekly_limit_bytes;
    }
    
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
            clientSocket.pipe(serverSocket);
            serverSocket.pipe(clientSocket);
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
    if (pub && pub.sslKey && pub.sslCert) {
        return { key: pub.sslKey, cert: pub.sslCert };
    }
    if (!isPkg) {
        try {
            return {
                key: fs.readFileSync(path.join(__dirname, 'server.key'), 'utf8'),
                cert: fs.readFileSync(path.join(__dirname, 'server.cert'), 'utf8')
            };
        } catch (e) {}
    }
    try {
        const forge = require('node-forge');
        const keys = forge.pki.rsa.generateKeyPair(2048);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date();
        cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
        const ip = getLocalIP();
        cert.setSubject([{ name: 'commonName', value: ip }]);
        cert.setIssuer([{ name: 'commonName', value: ip }]);
        cert.sign(keys.privateKey);
        const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
        const certPem = forge.pki.certificateToPem(cert);
        fs.writeFileSync(path.join(appDir, 'server.key'), keyPem);
        fs.writeFileSync(path.join(appDir, 'server.cert'), certPem);
        console.log(`[SSL] Generated self-signed cert for IP: ${ip}`);
        return { key: keyPem, cert: certPem };
    } catch (e) {
        console.error('[SSL] Failed to generate certs:', e.message);
        return null;
    }
}

const localIP = getLocalIP();

try {
    const https = require('https');
    const ssl = getSSL();
    if (ssl) {
        https.createServer(ssl, app).listen(API_PORT, '0.0.0.0', () => {
            console.log(`Giga Limit API running securely on HTTPS port ${API_PORT}`);
            console.log(`Admin login: https://${localIP}:${API_PORT} (password in admin_credentials.txt)`);
            console.log(`Local: https://localhost:${API_PORT}`);
        });
    } else {
        throw new Error('No SSL');
    }
} catch (e) {
    app.listen(API_PORT, '0.0.0.0', () => {
        console.log(`Giga Limit API running on HTTP port ${API_PORT}`);
        console.log(`Admin login: http://${localIP}:${API_PORT} (password in admin_credentials.txt)`);
    });
}

const HTTP_PORT = 3001;
app.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`Giga Limit API (Plain HTTP Fallback) running on port ${HTTP_PORT}`);
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
                    clientSocket.pipe(serverSocket);
                    serverSocket.pipe(clientSocket);
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
            relay.send(message.subarray(portOffset + 2), port, host);
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
        relay.send(Buffer.concat([header, message]), clientUdpPort, clientIp);
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

process.on('uncaughtException', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ETIMEDOUT') {
        return;
    }
    console.error('Unhandled Exception:', err);
});
