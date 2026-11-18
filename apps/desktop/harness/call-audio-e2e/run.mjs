// Call audio E2E runner: one headless Chromium, a talker page and a listener page per scenario, in a fresh room of a
// LiveKit server you point it at (a THROWAWAY one - see the header of src/audio/audit/callAudioE2E.sweep.test.ts).
//
//   LK_URL=ws://<ip>:7880 [LK_KEY=devkey LK_SECRET=secret] [TC_SIDECAR=<container in the SFU netns with tc>] \
//     node harness/call-audio-e2e/run.mjs --dist <built page> --spec <spec.json> --out <dir>
//
// spec.json: { gumWav?: <16-bit wav for Chromium's fake capture device>, scenarios: [{ name, settings, source:
//   'webaudio'|'gum', input?: <mono f32 48 kHz file>, echoCancellation?, actions: [{t, kind, mode?, on?}], durationS,
//   leveler?: boolean, netem?: <tc netem spec on the SFU's egress> }] }
// Writes <out>/<name>/{sent.f32, recv_raw.f32, recv_heard.f32, meta.json}. Never point it at prod or staging.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const SIDE = process.env.TC_SIDECAR ?? '';
const DIST = path.resolve(args.dist); const OUT = path.resolve(args.out);
const spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(OUT, { recursive: true });

async function token(room, identity) {
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '1h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
}

function netem(specStr) {
    if (!SIDE) { if (specStr) throw new Error('netem needs TC_SIDECAR'); return; }
    const sh = (c) => execFileSync('docker', ['exec', SIDE, 'sh', '-c', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!specStr) { try { sh('tc qdisc del dev eth0 root'); } catch { /* none */ } return; }
    sh(`tc qdisc replace dev eth0 root netem ${specStr}`);
}

const inputs = new Map();
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname.startsWith('/upload/')) {
        const rel = decodeURIComponent(u.pathname.slice('/upload/'.length));
        const f = path.join(OUT, rel);
        if (!f.startsWith(OUT + path.sep)) { res.writeHead(400); res.end(); return; }
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const ws = fs.createWriteStream(f);
        req.pipe(ws);
        ws.on('finish', () => { res.writeHead(200); res.end('ok'); });
        return;
    }
    if (u.pathname.startsWith('/input/')) {
        const f = inputs.get(decodeURIComponent(u.pathname.slice(7)));
        if (!f) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        fs.createReadStream(f).pipe(res);
        return;
    }
    const p = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!p.startsWith(DIST) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[path.extname(p)] ?? 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

const flags = [
    '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ...(spec.gumWav ? [`--use-file-for-fake-audio-capture=${spec.gumWav}`] : []),
];
const browser = await chromium.launch({ executablePath: exe, args: flags });
const version = browser.version();
console.log(`chromium ${version}; ${spec.scenarios.length} scenarios`);

async function openPage(name, scen) {
    const ctx = await browser.newContext({ permissions: ['microphone'] });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120_000);
    const errs = [];
    page.on('console', m => { const t = m.text(); if (/error|warn|harness|VoiceProcessor|voiceProcessorManager|leveler/i.test(t) && !/DevTools/.test(t)) errs.push(`${name}: ${t.slice(0, 300)}`); });
    page.on('pageerror', e => errs.push(`${name} pageerror: ${String(e).slice(0, 300)}`));
    await page.goto(pageUrl);
    await page.waitForFunction(() => window.HREADY === true);
    return { ctx, page, errs, scen };
}

const results = [];
try {
    for (const sc of spec.scenarios) {
        if (only && !only.has(sc.name)) continue;
        const room = `cl-audio-e2e-${sc.name}-${Date.now()}-${randomBytes(3).toString('hex')}`;
        const keyB64 = randomBytes(32).toString('base64');
        if (sc.input) inputs.set(`${sc.name}.f32`, sc.input);
        const t0 = Date.now();
        console.log(`[${new Date().toISOString()}] ${sc.name} (${sc.durationS}s${sc.netem ? `, netem ${sc.netem}` : ''})`);
        netem(sc.netem ?? null);
        const L = await openPage('listener', sc);
        const T = await openPage('talker', sc);
        let meta;
        try {
            await L.page.evaluate(o => window.H.startListener(o), { url: LK_URL, token: await token(room, 'listener'), keyB64, leveler: sc.leveler !== false, probe: sc.probe });
            const prep = await T.page.evaluate(o => window.H.prepareTalker(o), {
                url: LK_URL, token: await token(room, 'talker'), keyB64, scenario: sc.name, settings: sc.settings ?? {}, source: sc.source ?? 'webaudio',
                inputUrl: sc.input ? `/input/${sc.name}.f32` : undefined, echoCancellation: !!sc.echoCancellation, actions: sc.actions ?? [], durationS: sc.durationS, probe: sc.probe,
            });
            const lrec = await L.page.evaluate(() => window.H.listenerRecord());
            // let the subscriber's jitter buffer settle on the (silent / room) pre-roll before the input starts
            await new Promise(r => setTimeout(r, 1500));
            const trun = await T.page.evaluate(() => window.H.runTalker());
            await new Promise(r => setTimeout(r, 1500)); // the tail still in flight
            const lstop = await L.page.evaluate(n => window.H.listenerStop(n), sc.name);
            meta = { name: sc.name, room, chromium: version, prep, talker: trun, listener: { ...lrec, ...lstop }, errs: [...L.errs, ...T.errs], wallS: (Date.now() - t0) / 1000, netem: sc.netem ?? null, loadAvg: os.loadavg(), cpus: os.cpus().length };
        } catch (e) {
            meta = { name: sc.name, error: String(e?.stack ?? e).slice(0, 2000), errs: [...L.errs, ...T.errs] };
            console.error(`  FAILED: ${meta.error.split('\n')[0]}`);
        } finally {
            try { await T.page.evaluate(() => window.H.stopTalker()); } catch { /* ignore */ }
            try { await L.page.evaluate(() => window.H.stopListener()); } catch { /* ignore */ }
            await T.ctx.close(); await L.ctx.close();
            netem(null);
        }
        fs.mkdirSync(path.join(OUT, sc.name), { recursive: true });
        fs.writeFileSync(path.join(OUT, sc.name, 'meta.json'), JSON.stringify(meta, null, 1));
        results.push({ name: sc.name, ok: !meta.error, wallS: meta.wallS });
    }
} finally {
    netem(null);
    await browser.close();
    server.close();
}
fs.writeFileSync(path.join(OUT, 'run.json'), JSON.stringify({ chromium: version, results }, null, 1));
console.log(JSON.stringify(results));
