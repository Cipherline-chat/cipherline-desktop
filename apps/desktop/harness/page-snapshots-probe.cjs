/* eslint-disable -- harness, not shipped */
// Page snapshots in REAL Electron (2026-11-23): the shipped snapshotter
// (electron/unfurl/page-snapshot.ts, bundled by esbuild to SNAP_BUNDLE) run
// the way main.ts runs it, against LIVE sites and a control page.
//
//   1. LIVE: each URL through the real unfurler first (UNFURL_BUNDLE): a page
//      with its own picture never gets a snapshot; a flagged one does, and the
//      verdict (ok / login / bot-wall / error / blank) decides what is shown.
//      Each URL is also snapshotted DIRECTLY to show what the verdict says.
//   2. MEMORY: five snapshots in a row; main RSS + every process's working set
//      (app.getAppMetrics) before, after each, and after a settle; the number
//      of live renderer processes back to the baseline.
//   3. CONTROLS: a control page served from memory for https://controls.test/
//      (the prepareSession seam; every other request takes the real path)
//      tries: http / https / wss / img / iframe to 127.0.0.1, the dev box's
//      LAN address and a public name that resolves to loopback (localtest.me);
//      window.open, a download, notification / geolocation / camera /
//      clipboard / MIDI permission prompts, and a navigation after load. A
//      local HTTP server on 0.0.0.0 logs any hit; POSITIVE CONTROL: the
//      harness itself reaches it on both addresses.
//
//   SNAP_BUNDLE=… UNFURL_BUNDLE=… OUT=… LAN_IP=192.168.1.27 xvfb-run -a electron harness/page-snapshots-probe.cjs
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const dns = require('dns');

const OUT = process.env.OUT;
const LAN_IP = process.env.LAN_IP || '192.168.1.27';
fs.mkdirSync(OUT, { recursive: true });
const snap = require(process.env.SNAP_BUNDLE);
const unf = require(process.env.UNFURL_BUNDLE);
const log = [];
const say = (l) => { log.push(l); console.log(l); };

app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => { /* keep running */ });

const LIVE = [
    ['gdoc-public', 'https://docs.google.com/document/d/1MPjVwL-oB8RT476yEPP47JEVqk6iVty5WpylrqsGESg/edit?usp=sharing'],
    ['gdrive-public-docx', 'https://drive.google.com/file/d/1jWdfwVurLfpG71aOVsTOQQn6aV3lu7ya/view?usp=sharing'],
    ['gdrive-public-zip', 'https://drive.google.com/file/d/18nRGlpZpYuUNVWsQ8v26Hvnqs-MHMcB8/view?usp=share_link'],
    ['gdoc-private', 'https://docs.google.com/document/d/16fWhE5jynZrw2nzDVrDq0TCnqo9vvt6_Ec2ni_gRKu0/edit'],
    ['bbc-news', 'https://www.bbc.com/news'],
    ['stackoverflow', 'https://stackoverflow.com/questions/11227809'],
    ['example', 'https://example.com/'],
    ['npr-text-article', process.env.NPR_ARTICLE || 'https://text.npr.org/'],
    ['cnn-lite', 'https://lite.cnn.com/'],
    ['hackernews', 'https://news.ycombinator.com/'],
    ['heavy-js-maps', 'https://www.google.com/maps'],
    ['heavy-js-verge', 'https://www.theverge.com/'],
];

function metrics() {
    const m = app.getAppMetrics();
    return {
        mainRssMB: Math.round(process.memoryUsage().rss / 1048576),
        totalWorkingSetMB: Math.round(m.reduce((a, p) => a + (p.memory?.workingSetSize ?? 0), 0) / 1024),
        renderers: m.filter((p) => p.type === 'Tab').length,
        processes: m.length,
        cpuPct: Math.round(m.reduce((a, p) => a + (p.cpu?.percentCPUUsage ?? 0), 0)),
    };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSnap(snapper, url, label, extraDeps) {
    const token = `tok${label.replace(/[^a-z0-9]/gi, '')}`.slice(0, 40).padEnd(8, 'x');
    const t0 = Date.now();
    const r = extraDeps
        ? await snap.takePageSnapshot(url, new AbortController().signal, { BrowserWindow, fromPartition: (p, o) => session.fromPartition(p, o), log: say, ...extraDeps })
        : await snapper.request(url, token);
    const out = { label, url, ok: r.ok, reason: r.ok ? undefined : r.reason, ms: Date.now() - t0, counters: r.counters };
    if (r.ok) {
        const f = path.join(OUT, `snapshot-${label}.png`);
        fs.writeFileSync(f, Buffer.from(r.bytes));
        out.png = { file: path.basename(f), width: r.width, height: r.height, bytes: r.bytes.byteLength };
    }
    return out;
}

app.whenReady().then(async () => {
    const results = { live: [], memory: [], controls: {} };
    // A visible app window, as the real app has (snapshots run beside it).
    const appWin = new BrowserWindow({ show: false, width: 400, height: 300 });
    await appWin.loadURL('data:text/html,<p>app</p>');
    const snapper = snap.createPageSnapshotter({ BrowserWindow, fromPartition: (p, o) => session.fromPartition(p, o), log: say });

    // ── 1. live ─────────────────────────────────────────────────────────────
    if ((process.env.PHASES || 'live,memory,controls').includes('live')) {
        for (const [label, url] of LIVE) {
            const u = await unf.unfurlLink(url);
            const unfurl = u.ok ? { kind: u.embed.kind, site: u.embed.site, title: u.embed.title, image: u.image ? `${u.image.mime} ${u.image.bytes.byteLength} B` : null, icon: !!u.icon, snapshot: !!u.snapshot } : { reason: u.reason };
            const pipeline = u.ok && u.snapshot ? await runSnap(snapper, url, `${label}`) : null;
            const direct = u.ok && u.snapshot ? null : await runSnap(snapper, url, `${label}-direct`);
            const row = { label, url, unfurl, pipeline, direct, metrics: metrics() };
            results.live.push(row);
            say(`[live] ${label}: unfurl ${JSON.stringify(unfurl)} | pipeline ${pipeline ? (pipeline.ok ? `snapshot ${pipeline.png.bytes} B ${pipeline.ms} ms` : pipeline.reason) : 'no snapshot (own picture / designed card)'} | direct ${direct ? (direct.ok ? `would be ok ${direct.ms} ms` : direct.reason) : '-'}`);
        }
    }

    // ── 2. memory: 5 in a row ────────────────────────────────────────────────
    if ((process.env.PHASES || 'live,memory,controls').includes('memory')) {
        await sleep(3000);
        const base = metrics();
        results.memory.push({ at: 'baseline', ...base });
        const five = ['https://example.com/', 'https://news.ycombinator.com/', 'https://lite.cnn.com/', 'https://text.npr.org/', 'https://www.bbc.com/news'];
        for (const [i, u] of five.entries()) {
            const r = await runSnap(snapper, u, `mem${i}`);
            // peak sampling is coarse: right after the job
            results.memory.push({ at: `after ${i + 1} (${new URL(u).hostname} ${r.ok ? 'ok' : r.reason} ${r.ms} ms)`, ...metrics() });
        }
        await sleep(5000);
        results.memory.push({ at: 'settled 5 s', ...metrics() });
        // Five at once through the queue: one at a time.
        const t0 = Date.now();
        const par = await Promise.all(five.map((u, i) => snapper.request(u, `tokpar${i}xxxx`)));
        results.memoryQueue = { totalMs: Date.now() - t0, results: par.map((r) => (r.ok ? 'ok' : r.reason)) };
        await sleep(5000);
        results.memory.push({ at: 'after queued burst + 5 s', ...metrics() });
    }

    // ── 2b. soak: N snapshots of one small page, GC'd, main RSS per step ─────
    if ((process.env.PHASES || '').includes('soak')) {
        const gc = () => { try { global.gc?.(); } catch { /* not exposed */ } };
        gc(); await sleep(2000); gc();
        results.soak = [{ i: 0, ...metrics() }];
        const n = Number(process.env.SOAK_N || 20);
        for (let i = 1; i <= n; i++) {
            await runSnap(snapper, 'https://example.com/', `soak${i}`);
            fs.rmSync(path.join(OUT, `snapshot-soak${i}.png`), { force: true });
            if (i % 5 === 0) { gc(); await sleep(1500); gc(); results.soak.push({ i, ...metrics() }); }
        }
    }

    // ── 2c. cancel: a running snapshot (a heavy page) and a queued one ───────
    if ((process.env.PHASES || '').includes('cancel')) {
        const before = metrics();
        const t0 = Date.now();
        const running = snapper.request('https://www.theverge.com/', 'tokcancelrun1');
        const queued = snapper.request('https://example.com/', 'tokcancelq001');
        await sleep(600);
        const stateBefore = snapper.state();
        snapper.cancel('tokcancelq001');
        snapper.cancel('tokcancelrun1');
        const [r1, r2] = await Promise.all([running, queued]);
        await sleep(2000);
        results.cancel = { stateBefore, running: r1.ok ? 'ok' : r1.reason, runningSettledMs: Date.now() - t0, queued: r2.ok ? 'ok' : r2.reason, stateAfter: snapper.state(), before, after: metrics() };
    }

    // ── 3. controls ────────────────────────────────────────────────────────
    if ((process.env.PHASES || 'live,memory,controls').includes('controls')) {
        const hits = [];
        const server = http.createServer((req, res) => { hits.push(`${req.socket.remoteAddress} ${req.method} ${req.url}`); res.end('hit'); });
        await new Promise((ok) => server.listen(0, '0.0.0.0', ok));
        const port = server.address().port;
        // POSITIVE CONTROL: the server is reachable on loopback and the LAN address.
        for (const host of ['127.0.0.1', LAN_IP]) {
            await new Promise((ok) => http.get({ host, port, path: '/positive-control' }, (res) => { res.resume(); res.on('end', ok); }).on('error', ok));
        }
        const positive = hits.splice(0);
        const localtest = await dns.promises.lookup('localtest.me', { all: true }).catch((e) => String(e));
        const reports = [];
        const identity = {};
        const controlHtml = `<!doctype html><html><head><title>Control page</title></head><body>
<h1>Snapshot guard controls</h1><p>${'This page tries to reach the local network, open popups, download a file and ask for permissions. '.repeat(20)}</p>
<img src="http://${LAN_IP}:${port}/img-http-lan"><img src="https://${LAN_IP}/img-https-lan"><img src="https://127.0.0.1:${port}/img-https-loop">
<iframe src="https://${LAN_IP}/frame-lan"></iframe><iframe src="https://localtest.me/frame-rebind"></iframe>
<script>
const rep = (k, v) => fetch('https://controls.test/report?' + encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).catch(() => {});
const tryFetch = (k, u) => fetch(u, { mode: 'no-cors' }).then(() => rep(k, 'REACHED')).catch((e) => rep(k, 'blocked ' + e.message));
tryFetch('fetch-http-loopback', 'http://127.0.0.1:${port}/fetch-http-loop');
tryFetch('fetch-http-lan', 'http://${LAN_IP}:${port}/fetch-http-lan');
tryFetch('fetch-https-lan', 'https://${LAN_IP}/fetch-https-lan');
tryFetch('fetch-https-192.168.0.1', 'https://192.168.0.1/');
tryFetch('fetch-https-metadata', 'https://169.254.169.254/latest/meta-data/');
tryFetch('fetch-https-localhost', 'https://localhost/');
tryFetch('fetch-https-localtest.me (public name -> loopback)', 'https://localtest.me/');
tryFetch('fetch-file', 'file:///etc/passwd');
try { const ws = new WebSocket('ws://127.0.0.1:${port}/ws'); ws.onopen = () => rep('ws-loopback', 'REACHED'); ws.onerror = () => rep('ws-loopback', 'blocked'); } catch (e) { rep('ws-loopback', 'blocked ' + e.message); }
try { const ws2 = new WebSocket('wss://localtest.me/ws'); ws2.onopen = () => rep('wss-localtest', 'REACHED'); ws2.onerror = () => rep('wss-localtest', 'blocked'); } catch (e) { rep('wss-localtest', 'blocked ' + e.message); }
const w = window.open('https://example.com/', '_blank'); rep('window.open', w ? 'OPENED' : 'denied');
const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['x'])); a.download = 'x.txt'; document.body.appendChild(a); a.click(); rep('download', 'clicked');
rep('navigator.userAgent', navigator.userAgent); rep('userAgentData', JSON.stringify(navigator.userAgentData ? navigator.userAgentData.brands : null));
document.cookie = 'probe=1; Secure'; rep('cookie-set', document.cookie);
Notification.requestPermission().then((p) => rep('notification', p)).catch((e) => rep('notification', 'error ' + e.message));
navigator.geolocation.getCurrentPosition(() => rep('geolocation', 'GRANTED'), (e) => rep('geolocation', 'denied ' + e.code));
navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(() => rep('camera-mic', 'GRANTED')).catch((e) => rep('camera-mic', 'denied ' + e.name));
navigator.clipboard.readText().then(() => rep('clipboard', 'GRANTED')).catch((e) => rep('clipboard', 'denied ' + e.name));
if (navigator.requestMIDIAccess) navigator.requestMIDIAccess({ sysex: true }).then(() => rep('midi', 'GRANTED')).catch((e) => rep('midi', 'denied ' + e.name));
try { alert('hi'); rep('alert', 'returned'); } catch (e) { rep('alert', 'error'); }
addEventListener('load', () => setTimeout(() => { rep('navigate-after-load', 'trying'); location.href = 'https://example.org/'; }, 50));
</script></body></html>`;
        const prepareSession = (ses) => {
            ses.protocol.handle('https', (req) => {
                const u = new URL(req.url);
                if (u.hostname === 'controls.test') {
                    if (u.pathname === '/report') {
                        reports.push(decodeURIComponent(u.search.slice(1)));
                        // What a site sees from the snapshot window on a subresource request.
                        identity.ua ??= req.headers.get('user-agent');
                        identity.secChUa ??= req.headers.get('sec-ch-ua');
                        identity.acceptLanguage ??= req.headers.get('accept-language');
                        identity.referer ??= req.headers.get('referer');
                        identity.cookie ??= req.headers.get('cookie');
                        return new Response('ok');
                    }
                    if (u.pathname === '/login-redirect') return new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/ServiceLogin?continue=https://docs.google.com/x' } });
                    if (u.pathname === '/challenge') return new Response('<!doctype html><title>Just a moment...</title><div id="challenge-form">Verifying you are human. This may take a few seconds.</div>', { headers: { 'content-type': 'text/html' } });
                    if (u.pathname === '/blank') return new Response('<!doctype html><title>x</title><body style="background:#fff"></body>', { headers: { 'content-type': 'text/html' } });
                    if (u.pathname === '/password') return new Response('<!doctype html><title>Welcome</title><form><input name=u><input type=password name=p><button>Go</button></form>', { headers: { 'content-type': 'text/html' } });
                    return new Response(controlHtml, { headers: { 'content-type': 'text/html' } });
                }
                // Everything else: the real path (webRequest + the guarded proxy).
                return ses.fetch(req, { bypassCustomProtocolHandlers: true });
            });
        };
        const ctl = await runSnap(null, 'https://controls.test/', 'controls', { prepareSession, log: (l) => { say(l); } });
        await sleep(500);
        results.controls = {
            positiveControlHits: positive,
            localtestMeResolvesTo: localtest,
            snapshot: { ok: ctl.ok, reason: ctl.reason, png: ctl.png, counters: ctl.counters },
            pageReports: reports.slice().sort(),
            subresourceIdentity: identity,
            localServerHitsFromSnapshot: hits.slice(),
            proxyLog: log.filter((l) => l.startsWith('[snapshot-proxy]')),
        };
        for (const [label, p, want] of [['login-redirect', '/login-redirect', 'login'], ['challenge', '/challenge', 'bot-wall'], ['blank', '/blank', 'blank'], ['password', '/password', 'login']]) {
            const r = await runSnap(null, `https://controls.test${p}`, `control-${label}`, { prepareSession });
            results.controls[`verdict_${label}`] = { want, got: r.ok ? 'ok' : r.reason };
        }
        server.close();
    }
    results.finalMetrics = metrics();
    fs.writeFileSync(path.join(OUT, 'probe-results.json'), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(OUT, 'probe-main.log'), log.join('\n') + '\n');
    app.exit(0);
});
