const forge = require('node-forge');
const fs = require('fs');
const pki = forge.pki;

console.log('Generating 2048-bit key-pair...');
const keys = pki.rsa.generateKeyPair(2048);
console.log('Key-pair created.');

console.log('Creating self-signed certificate...');
const cert = pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date();
cert.validity.notAfter = new Date();
cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
const attrs = [{ name: 'commonName', value: '192.168.100.84' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey);
console.log('Certificate created.');

fs.writeFileSync('server.key', pki.privateKeyToPem(keys.privateKey));
fs.writeFileSync('server.cert', pki.certificateToPem(cert));
console.log('Saved server.key and server.cert');
