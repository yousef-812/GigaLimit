const http = require('http');
const net = require('net');
const fs = require('fs');

// Create dummy db if not exists
if (!fs.existsSync('giga_limit_db.json')) {
    fs.writeFileSync('giga_limit_db.json', JSON.stringify({
        settings: { admin_password: "a", global_daily_limit_mb: 1024, global_weekly_limit_mb: 7000 },
        users: [
            { id: 1, name: "TestUser", device_id: "dev1", current_ip: "::1", status: "active", daily_limit_mb: 1024 },
            { id: 2, name: "TestUser2", device_id: "dev2", current_ip: "127.0.0.1", status: "active", daily_limit_mb: 1024 }
        ],
        usage: []
    }));
}

// 1. Connect via HTTP CONNECT proxy
const req = http.request({
    host: '127.0.0.1',
    port: 8080,
    method: 'CONNECT',
    path: 'www.google.com:80'
});

req.on('connect', (res, socket, head) => {
    console.log('Connected to HTTP proxy');
    socket.write('GET / HTTP/1.1\r\nHost: www.google.com\r\nConnection: close\r\n\r\n');
    socket.on('data', (chunk) => {
        console.log('Received HTTP data:', chunk.length, 'bytes');
    });
    socket.on('end', () => {
        console.log('HTTP connection ended');
    });
});

req.end();

// 2. Connect via SOCKS5 proxy
setTimeout(() => {
    const socksSocket = net.connect(1080, '127.0.0.1', () => {
        console.log('Connected to SOCKS5 proxy');
        socksSocket.write(Buffer.from([0x05, 0x01, 0x00])); // Handshake
        
        socksSocket.once('data', (res1) => {
            if (res1[0] === 0x05 && res1[1] === 0x00) {
                // Connect to google.com
                const reqBuffer = Buffer.from([
                    0x05, 0x01, 0x00, 0x03, 
                    14, ...Buffer.from('www.google.com'), 
                    0x00, 80
                ]);
                socksSocket.write(reqBuffer);
                
                socksSocket.once('data', (res2) => {
                    console.log('SOCKS5 connected to target');
                    socksSocket.write('GET / HTTP/1.1\r\nHost: www.google.com\r\nConnection: close\r\n\r\n');
                    
                    socksSocket.on('data', (chunk) => {
                        console.log('Received SOCKS data:', chunk.length, 'bytes');
                    });
                });
            }
        });
    });
}, 1000);

setTimeout(() => {
    const dbData = JSON.parse(fs.readFileSync('giga_limit_db.json', 'utf8'));
    console.log('DB USAGE:', dbData.usage);
    process.exit(0);
}, 7000); // wait 7s to allow setInterval(saveStats, 5000) to fire
