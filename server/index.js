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
    const today = new Date().toISOString().split('T')[0];
    
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
    const today = new Date().toISOString().split('T')[0];
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

app.post('/api/admin/renew_user', adminAuth, (req, res) => {
    const { id } = req.body;
    const today = new Date().toISOString().split('T')[0];
    db.resetUsage(id, today);
    res.json({ success: true });
});

app.get('/api/admin/global_settings', adminAuth, (req, res) => {
    res.json({ 
        global_limit: db.getSetting('global_daily_limit_mb'),
        global_weekly_limit: db.getSetting('global_weekly_limit_mb') || (db.getSetting('global_daily_limit_mb') * 7)
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

// --- PROXY ENGINE ---
const proxyServer = http.createServer((req, res) => {
    res.writeHead(403);
    res.end('Use HTTPS connect');
});

const authCache = new Map();

const isAllowed = (ip) => {
    const now = Date.now();
    if (authCache.has(ip) && now - authCache.get(ip).time < 10000) {
        return authCache.get(ip).allowed;
    }

    const today = new Date().toISOString().split('T')[0];
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
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.end();
        return;
    }

    const { port, hostname } = url.parse(`http://${req.url}`);
    const serverSocket = net.connect(port || 443, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        serverSocket.write(head);
        clientSocket.pipe(serverSocket);
        serverSocket.pipe(clientSocket);
    });

    const cacheEntry = authCache.get(clientIp);
    const userId = cacheEntry && cacheEntry.user ? cacheEntry.user.id : null;

    let bytesTransferred = 0;
    serverSocket.on('data', (chunk) => bytesTransferred += chunk.length);
    clientSocket.on('data', (chunk) => bytesTransferred += chunk.length);

    const saveStats = () => {
        if (bytesTransferred > 0 && userId) {
            const today = new Date().toISOString().split('T')[0];
            db.updateUsage(userId, today, bytesTransferred);
            bytesTransferred = 0;
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
    clientSocket.on('error', () => serverSocket.end());
});

app.listen(API_PORT, '0.0.0.0', () => {
    console.log(`Giga Limit API running on port ${API_PORT}`);
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`Giga Limit Proxy Engine running on port ${PROXY_PORT}`);
});
