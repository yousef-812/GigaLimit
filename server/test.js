const http = require('http');
http.request({ hostname: '' }).on('error', console.error).end();
