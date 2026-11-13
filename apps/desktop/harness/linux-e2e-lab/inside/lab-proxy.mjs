// In-container glue so the REAL app runs unmodified against the lab servers (harness config only, no app code):
//   127.0.0.1:13005  HTTP+WS proxy: /rtc* -> LiveKit (172.29.88.13:7880), everything else -> the API (172.29.88.14:3005).
//                    The app's renderer CSP (electron/main.ts connect-src) only admits the VITE_API_HOST loopback origin, so the
//                    LiveKit signalling URL the API hands out (ws://127.0.0.1:13005) has to live on that same origin.
//   127.0.0.1:15174  static server for the built renderer (apps/desktop/dist); VITE_DEV_SERVER_URL points Electron at it.
//                    Dev-server mode is the only way an unpackaged Electron admits the loopback API in its CSP.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const API = { host: process.env.LAB_API_IP || '172.29.88.14', port: 3005 };
const LK = { host: process.env.LAB_LK_IP || '172.29.88.13', port: 7880 };
const dist = process.argv[2];
const target = (url) => (/^\/rtc(\/|\?|$)/.test(url) ? LK : API);

const proxy = http.createServer((req, res) => {
  const t = target(req.url);
  const up = http.request({ ...t, method: req.method, path: req.url, headers: { ...req.headers, host: `${t.host}:${t.port}` } }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});
proxy.on('upgrade', (req, sock, head) => {
  const t = target(req.url);
  const up = http.request({ ...t, method: req.method, path: req.url, headers: { ...req.headers, host: `${t.host}:${t.port}` } });
  up.on('upgrade', (r, s, h) => {
    sock.write(`HTTP/1.1 101 ${r.statusMessage}\r\n` + Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (h?.length) sock.write(h);
    s.pipe(sock).pipe(s);
    s.on('error', () => sock.destroy()); sock.on('error', () => s.destroy());
  });
  up.on('response', (r) => { sock.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n\r\n`); sock.destroy(); });
  up.on('error', () => sock.destroy());
  up.end(head);
});
proxy.listen(13005, '127.0.0.1', () => console.log('lab proxy on 127.0.0.1:13005'));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.ico': 'image/x-icon' };
if (dist) {
  http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    let f = path.join(dist, path.normalize(p));
    if (!f.startsWith(dist)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  }).listen(15174, '127.0.0.1', () => console.log('static dist on 127.0.0.1:15174'));
}
