// Loopback stand-in for the Cipherline API during the link-embeds Electron run
// (VITE_API_HOST=127.0.0.1:<port>). Answers 404 to everything and logs each
// path, so the run shows the embeds never touch the API (they are receiver-
// side and built from the URL).
//   STUB_PORT=13163 STUB_LOG=<file> node harness/link-embeds-api-stub.mjs
import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.env.STUB_PORT ?? 13163);
const log = process.env.STUB_LOG;
http.createServer((req, res) => {
    if (log) fs.appendFileSync(log, `${new Date().toISOString()} ${req.method} ${req.url.split('?')[0]}\n`);
    res.writeHead(404, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end('{"message":"stub"}');
}).listen(port, '127.0.0.1', () => console.log(`api stub on ${port}`));
