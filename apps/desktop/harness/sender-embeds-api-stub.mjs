// Loopback stand-in for the Cipherline API + object storage during the
// sender-embeds Electron run (phase 3; VITE_API_HOST=127.0.0.1:<port>).
//
//   POST /v1/attachments/initiate        → { attachment_id, upload_url } (upload_url on this stub)
//   PUT  /upload/<id>                    stores the (encrypted) body
//   GET  /v1/attachments/<id>/download   → { download_url }
//   GET  /blob/<id>                      the stored ciphertext
//   POST /harness/message, GET /harness/message   the sender hands the receiver the message
//                                        content (stands in for the E2EE envelope relay)
//
// Logs method + path + byte count of every request, so the run shows exactly
// what reached "our server": opaque blobs and the content handover, nothing else.
//   STUB_PORT=13171 STUB_LOG=<file> node harness/sender-embeds-api-stub.mjs
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const port = Number(process.env.STUB_PORT ?? 13171);
const log = process.env.STUB_LOG;
const blobs = new Map();
let message = null;
const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-cipherline-attest, x-device-id, x-client-version',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
};
const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, ...cors });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        const path = req.url.split('?')[0];
        if (log) fs.appendFileSync(log, `${new Date().toISOString()} ${req.method} ${path} ${body.length}B\n`);
        if (req.method === 'OPTIONS') return send(res, 204, '');
        let m;
        if (req.method === 'POST' && path === '/v1/attachments/initiate') {
            const id = randomUUID();
            return send(res, 201, { attachment_id: id, upload_url: `http://127.0.0.1:${port}/upload/${id}` });
        }
        if (req.method === 'PUT' && (m = /^\/upload\/([0-9a-f-]{36})$/.exec(path))) { blobs.set(m[1], body); return send(res, 200, ''); }
        if (req.method === 'GET' && (m = /^\/v1\/attachments\/([0-9a-f-]{36})\/download$/.exec(path))) {
            return blobs.has(m[1]) ? send(res, 200, { download_url: `http://127.0.0.1:${port}/blob/${m[1]}` }) : send(res, 404, { message: 'gone' });
        }
        if (req.method === 'GET' && (m = /^\/blob\/([0-9a-f-]{36})$/.exec(path))) {
            return blobs.has(m[1]) ? send(res, 200, blobs.get(m[1]), 'application/octet-stream') : send(res, 404, '');
        }
        if (req.method === 'POST' && path === '/harness/message') { message = JSON.parse(body.toString('utf8')); return send(res, 200, { ok: true }); }
        if (req.method === 'GET' && path === '/harness/message') return send(res, 200, message ?? {});
        return send(res, 404, { message: 'stub' });
    });
}).listen(port, '127.0.0.1', () => console.log(`sender-embeds api stub on ${port}`));
