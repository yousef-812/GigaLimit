const { PassThrough } = require('stream');

const stream1 = new PassThrough();
const stream2 = new PassThrough();

let bytes = 0;
stream1.on('data', (chunk) => bytes += chunk.length);

stream1.pipe(stream2);

stream1.write('hello');
stream1.write('world');

console.log('Bytes counted:', bytes);
