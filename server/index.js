const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const net = require('net');
const url = require('url');
const db = require('./db');

const app = express();
const API_PORT = 3000;
const PROXY_PORT = 8080;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/app.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
    const { device_id } = req.body;
    const ip = getCleanIp(req);
    db.updateUserIp(device_id, ip);
    res.json({ success: true });
});

app.get('/api/status/:device_id', (req, res) => {
    const device_id = req.params.device_id;
    const ip = getCleanIp(req);
    const today = db.getLocalDateString();
    
    const user = db.getUserByDeviceId(device_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Auto-update IP if the device changed networks (e.g. from Main Router to Access Point)
    if (user.current_ip !== ip) {
        db.updateUserIp(device_id, ip);
        user.current_ip = ip;
    }
    
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
        can_connect: user.status === 'unlimited' || (user.status === 'active' && bytes_used < daily_limit_bytes && weekly_bytes_used < weekly_limit_bytes)
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
        // BLACKHOLE STRATEGY: Do not destroy the socket immediately.
        // We hold the connection hostage so the phone hangs and doesn't fallback to 4G.
        // The phone will wait forever until it times out naturally.
        return;
    }

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
                // If they run out of quota mid-stream, we pause the stream instead of killing it.
                // clientSocket.pause() stops reading data from the client, effectively freezing it.
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

app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`Giga Limit API v3 running on port ${API_PORT}`);
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`Giga Limit Proxy Engine v3 running on port ${PROXY_PORT}`);
});

// --- SOCKS5 ENGINE ---
const socksServer = net.createServer((clientSocket) => {
    let clientIp = clientSocket.remoteAddress;
    if (clientIp && clientIp.includes('::ffff:')) clientIp = clientIp.split('::ffff:')[1];

    if (!isAllowed(clientIp)) {
        // BLACKHOLE STRATEGY for SOCKS5
        // Do not respond to the handshake. The phone will hang.
        return;
    }

    clientSocket.once('data', (data) => {
        if (data[0] !== 0x05) {
            clientSocket.end();
            return;
        }
        clientSocket.write(Buffer.from([0x05, 0x00])); // No auth

        clientSocket.once('data', (reqData) => {
            if (reqData[0] !== 0x05 || reqData[1] !== 0x01) {
                clientSocket.end();
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
                        // Freeze the stream mid-connection
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

socksServer.listen(1080, '0.0.0.0', () => {
    console.log(`Giga Limit SOCKS5 Engine running on port 1080`);
});
