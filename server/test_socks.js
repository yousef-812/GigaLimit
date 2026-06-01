const net = require('net');

const socksServer = net.createServer((clientSocket) => {
    clientSocket.once('data', (data) => {
        if (data[0] !== 0x05) {
            clientSocket.end();
            return;
        }
        clientSocket.write(Buffer.from([0x05, 0x00]));

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

            const serverSocket = net.connect(port, host, () => {
                const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
                clientSocket.write(reply);
                clientSocket.pipe(serverSocket);
                serverSocket.pipe(clientSocket);
            });

            serverSocket.on('error', () => {
                clientSocket.end();
            });
            clientSocket.on('error', () => {
                if (serverSocket) serverSocket.end();
            });
        });
    });
});

socksServer.listen(1080, '127.0.0.1', () => {
    console.log('SOCKS5 test server on 1080');
});
