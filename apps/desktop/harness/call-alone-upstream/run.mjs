// Alone-in-call upstream pause: measurement runner. One headless Chromium; per scenario a fresh room on a THROWAWAY
// LiveKit (never the dev stack's, never prod / staging):
//   docker network create clau-net
//   docker run -d --name clau-lk --network clau-net livekit/livekit-server:v1.9.12 --dev --bind 0.0.0.0
//   (cd apps/desktop && OUT_DIR=<dir>/dist npx vite build -c harness/call-alone-upstream/vite.config.ts)
//   LK_URL=ws://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' clau-lk):7880 \
//     node harness/call-alone-upstream/run.mjs --dist <dir>/dist --out <dir>/out [--only audio,camera] [--window 60]
//   docker rm -f clau-lk; docker network rm clau-net
//
// Per scenario: the "alone" page joins and publishes; BASELINE window = wire bytes over --window s while alone and
// sending (today's behaviour); then the app's AloneUpstream controller starts, pauses after ALONE_PAUSE_AFTER_MS;
// PAUSED window = the same length while paused; then (optionally after rotating the call key while paused) a second
// page joins and records when audio / video first arrive and whether they decrypt. Writes <out>/<name>.json.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

const require = createRequire(import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const { AccessToken } = await import(process.env.LK_SDK ?? '/home/antigravity/Cipherline/node_modules/livekit-server-sdk/dist/index.js');
const exe = process.env.CHROME_EXE ?? (() => {
    const base = path.join(process.env.HOME, '.cache/ms-playwright');
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort();
    return path.join(base, dirs[dirs.length - 1], 'chrome-headless-shell-linux64/chrome-headless-shell');
})();
const LK_URL = process.env.LK_URL; if (!LK_URL) throw new Error('LK_URL');
if (/cipherline\.chat/.test(LK_URL)) throw new Error('refusing to run against a Cipherline host');
const LK_KEY = process.env.LK_KEY ?? 'devkey'; const LK_SECRET = process.env.LK_SECRET ?? 'secret';
const DIST = path.resolve(args.dist); const OUT = path.resolve(args.out);
const WINDOW_S = Number(args.window ?? 60);
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(OUT, { recursive: true });

const SCENARIOS = [
    { name: 'audio', camera: false, share: false, rotate: true },
    { name: 'audio_quiet', camera: false, share: false, rotate: false, mic: 'quiet' },
    { name: 'camera', camera: true, share: false, rotate: true },
    { name: 'share', camera: false, share: true, rotate: false },
    // control: the same join with NO pause (the controller never runs) - first-audio timing to compare against
    { name: 'audio_nopause', camera: false, share: false, rotate: false, nopause: true },
];

async function token(room, identity) {
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '1h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!p.startsWith(DIST) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[path.extname(p)] ?? 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch({ executablePath: exe, args: [
    '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
] });
const cdp = await browser.newBrowserCDPSession();
const cpuTotal = async () => { const { processInfo } = await cdp.send('SystemInfo.getProcessInfo'); return processInfo.reduce((a, p) => a + p.cpuTime, 0); };
console.log(`chromium ${browser.version()}`);

async function openPage(name) {
    const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const page = await ctx.newPage();
    page.setDefaultTimeout(180_000);
    const logs = [];
    page.on('console', m => { const t = m.text(); if (/error|harness/i.test(t)) logs.push(`${name}: ${t.slice(0, 300)}`); });
    page.on('pageerror', e => logs.push(`${name} pageerror: ${String(e).slice(0, 300)}`));
    await page.goto(pageUrl);
    await page.waitForFunction(() => window.HREADY === true);
    return { ctx, page, logs };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function windowOf(page, seconds) {
    const a = await page.evaluate(() => window.H.wire());
    const c0 = await cpuTotal();
    await sleep(seconds * 1000);
    const b = await page.evaluate(() => window.H.wire());
    const c1 = await cpuTotal();
    const dt = (b.t - a.t) / 1000;
    const byKind = {};
    for (const o of b.out) {
        const prev = a.out.find(x => x.kind === o.kind && x.rid === o.rid);
        const k = `${o.kind}${o.rid ? ':' + o.rid : ''}`;
        byKind[k] = (byKind[k] ?? 0) + ((o.bytes ?? 0) + (o.hdr ?? 0) - ((prev?.bytes ?? 0) + (prev?.hdr ?? 0)));
    }
    return {
        seconds: dt,
        wireBytesPerMin: Math.round((b.transport - a.transport) / dt * 60),
        rtpBytesPerMinByStream: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(v / dt * 60)])),
        cpuPctOfCore: Math.round((c1 - c0) / dt * 1000) / 10,
        end: b,
    };
}

const results = [];
try {
    for (const sc of SCENARIOS) {
        if (only && !only.has(sc.name)) continue;
        const roomName = `cl-alone-${sc.name}-${Date.now()}-${randomBytes(3).toString('hex')}`;
        const key1 = randomBytes(32).toString('base64');
        const key2 = randomBytes(32).toString('base64');
        console.log(`[${new Date().toISOString()}] ${sc.name}`);
        const A = await openPage('alone');
        let J = null;
        const r = { name: sc.name, loadAvg: os.loadavg(), cpus: os.cpus().length };
        try {
            await A.page.evaluate(o => window.H.join(o), { url: LK_URL, token: await token(roomName, 'alone'), keyB64: key1 });
            await A.page.evaluate(o => window.H.publish(o), { camera: sc.camera, share: sc.share, mic: sc.mic ?? 'tone' });
            await sleep(8000); // ramp-up + dynacast's 5 s pause delay
            if (!sc.nopause) {
                r.baseline = await windowOf(A.page, WINDOW_S);
                const tCtl = Date.now();
                await A.page.evaluate(() => window.H.startController());
                await A.page.waitForFunction(() => window.H.events().some(e => e.m === 'upstream_paused'), null, { timeout: 60_000 });
                const evs = await A.page.evaluate(() => window.H.events());
                r.pausedAfterMs = evs.find(e => e.m === 'upstream_paused').t - tCtl;
                await sleep(3000);
                r.paused = await windowOf(A.page, WINDOW_S);
                if (sc.rotate) await A.page.evaluate(k => window.H.rotateKey(k), key2);
            }
            if (sc.nopause) r.resumeTrials = await A.page.evaluate(n => window.H.latencyTrials(n), 10);
            // the joiner
            J = await openPage('joiner');
            const tJoin = Date.now();
            await J.page.evaluate(o => window.H.listen(o), { url: LK_URL, token: await token(roomName, 'joiner'), keyB64: sc.rotate ? key2 : key1, publishMic: true });
            await J.page.waitForFunction(() => window.H.seen()?.done === true, null, { timeout: 30_000 });
            const seen = await J.page.evaluate(() => window.H.seen());
            const aEv = await A.page.evaluate(() => window.H.events());
            const jEv = await J.page.evaluate(() => window.H.events());
            const pc = aEv.find(e => e.m === 'participant_connected' && e.t >= tJoin);
            const lts = aEv.find(e => e.m === 'local_track_subscribed' && e.t >= tJoin);
            const resumed = aEv.find(e => e.m === 'upstream_resumed' && e.t >= tJoin);
            const fp = aEv.find(e => e.m === 'first_packet_after_resume' && e.t >= tJoin);
            const rel = t => (typeof t === 'number' ? t - tJoin : null);
            r.join = {
                // on the alone page
                participantConnectedMs: rel(pc?.t),
                resumeReason: resumed?.reason ?? null,
                localTrackSubscribedMs: rel(lts?.t),
                resumedMs: rel(resumed?.t),
                firstPacketAfterResumeMs: fp?.ms ?? null,
                // on the joiner, ms after it started joining
                joinerConnectedMs: rel(seen.connected),
                joinerAudioSubscribedMs: rel(seen.audio_subscribed ?? seen.microphone_subscribed),
                joinerFirstAudioPacketMs: rel(seen.audio_first_packet),
                joinerFirstAudioEnergyMs: rel(seen.audio_first_energy),
                joinerFirstVideoDecodedMs: rel(seen.video_first_decoded),
                joinerVideoFramesDecoded: seen.video_decoded ?? 0,
                joinerFirstDecodedSoundMs: rel(seen.audio_first_decoded_sound),
                joinerAudioMaxRms: seen.audio_max_rms ?? 0,
                joinerAudioPackets: seen.audio_packets ?? 0,
                encryptionErrors: [...aEv, ...jEv].filter(e => e.m === 'encryption_error').length,
                joinerSawEncrypted: jEv.filter(e => e.m === 'encryption_status' && !e.local).map(e => e.on),
            };
            r.seen = seen;
            r.events = { alone: aEv, joiner: jEv };
            if (!sc.nopause) r.afterJoin = await A.page.evaluate(() => window.H.wire());
        } catch (e) {
            r.error = String(e?.stack ?? e).slice(0, 2000);
            console.error(`  FAILED: ${r.error.split('\n')[0]}`);
        } finally {
            r.logs = [...A.logs, ...(J?.logs ?? [])].slice(-80);
            try { await J?.page.evaluate(() => window.H.leave()); } catch { /* ignore */ }
            try { await A.page.evaluate(() => window.H.leave()); } catch { /* ignore */ }
            await J?.ctx.close(); await A.ctx.close();
        }
        fs.writeFileSync(path.join(OUT, `${sc.name}.json`), JSON.stringify(r, null, 1));
        const brief = { name: r.name, error: r.error?.split('\n')[0], resumeTrials: r.resumeTrials, pausedAfterMs: r.pausedAfterMs, baseline: r.baseline && { wire: r.baseline.wireBytesPerMin, rtp: r.baseline.rtpBytesPerMinByStream, cpu: r.baseline.cpuPctOfCore }, paused: r.paused && { wire: r.paused.wireBytesPerMin, rtp: r.paused.rtpBytesPerMinByStream, cpu: r.paused.cpuPctOfCore }, join: r.join };
        console.log(JSON.stringify(brief));
        results.push(brief);
    }
} finally {
    await browser.close();
    server.close();
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(results, null, 1));
