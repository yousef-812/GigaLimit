const http = require('http');
http.request({ hostname: '_' }).on('error', console.error).end();
