// Loopback API stub for renderer harnesses: answers every request with an
// empty JSON 404 and logs the method + path (query and tokens dropped), so a
// harness run never reaches a real API and its traffic can be checked.
//   STUB_PORT=13293 STUB_LOG=<file> node harness/loopback-api-stub.mjs
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.STUB_PORT ?? 13293);
const LOG = process.env.STUB_LOG;
http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (LOG) fs.appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${path}\n`);
    res.writeHead(404, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
    res.end('{}');
}).listen(PORT, '127.0.0.1', () => console.log(`stub on 127.0.0.1:${PORT}`));
