#!/usr/bin/env node
/**
 * Many-camera call harness runner. See README.md.
 *
 *   LK_KEY=.. LK_SECRET=.. LK_URL=ws://127.0.0.1:7890 DIST=<built page dir> \
 *     node run.mjs --n 25 --policy capped [--cols 7 --cell 200x112 --secs 25 --mode auto --cap 0]
 *   node run.mjs --proof          # E2EE: right-key viewer vs wrong-key viewer, 1 publisher
 *
 * Publishers (N synthetic cameras, own Rooms + E2EE workers) run in ONE Chromium
 * process; the viewer in ANOTHER, so the viewer's CPU is its own. CPU is read from
 * CDP SystemInfo.getProcessInfo (cumulative seconds per browser process).
 * Never point it at prod.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : a), []));
const { AccessToken } = await import(process.env.LK_SDK ?? '/home/antigravity/Cipherline/node_modules/livekit-server-sdk/dist/index.js');
const { chromium } = await import(process.env.PLAYWRIGHT ?? '/home/antigravity/.local/share/playwright-mcp/node_modules/playwright/index.mjs');

const LK_KEY = process.env.LK_KEY, LK_SECRET = process.env.LK_SECRET, DIST = process.env.DIST;
const LK_URL = process.env.LK_URL ?? 'ws://127.0.0.1:7890';
if (!LK_KEY || !LK_SECRET || !DIST) throw new Error('LK_KEY / LK_SECRET / DIST');

const N = Number(args.n ?? 10);
const SECS = Number(args.secs ?? 25);
const [CW, CH] = String(args.cell ?? '200x112').split('x').map(Number);
const COLS = Number(args.cols ?? Math.max(1, Math.ceil(Math.sqrt(N * 1.8))));
const KEY = randomBytes(32).toString('base64');
const room = `many-cams-${Date.now()}`;

const token = async (identity) => { const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '2h' }); at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true }); return await at.toJwt(); };

function serve(dir) {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
    const srv = http.createServer((req, res) => {
        const f = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
        if (!f.startsWith(dir) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
        fs.createReadStream(f).pipe(res);
    });
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const FLAGS = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-features=WebRtcHideLocalIpsWithMdns:false', '--disable-features=WebRtcHideLocalIpsWithMdns'];

async function launch(srv, name) {
    const browser = await chromium.launch({ headless: true, channel: 'chromium', args: FLAGS });
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    page.on('console', m => { if (args.verbose) console.log(`[${name}]`, m.text()); });
    page.on('pageerror', e => console.log(`[${name}] pageerror`, String(e).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${srv.address().port}/index.html`);
    await page.waitForFunction(() => !!window.H, null, { timeout: 30000 });
    const cdp = await browser.newBrowserCDPSession();
    return { browser, page, cdp };
}

async function cpuSeconds(cdp) {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const by = {};
    let total = 0;
    for (const p of processInfo) { by[p.type] = (by[p.type] ?? 0) + p.cpuTime; total += p.cpuTime; }
    return { total, by };
}

const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))]; };
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** One publisher set (N cameras) serves every policy: a viewer per policy, in a fresh browser each time. */
async function runMulti({ policies, mode = 'auto', cap = 0, n = N, secs = SECS }) {
    const srv = await serve(DIST);
    // Publishers are spread over several Chromium processes (PER publishers each): one page's main thread
    // cannot negotiate and draw 50 rooms (negotiation timeouts), which is a harness limit, not the app's.
    const PER = Number(args.per ?? 8);
    const pubBs = [];
    const results = [];
    const pubB = { cdp: null, browser: null, page: null };
    try {
        const tokens = await Promise.all(Array.from({ length: n }, (_, i) => token(`pub-${String(i).padStart(3, '0')}`)));
        const t0 = Date.now();
        for (let i = 0; i < n; i += PER) pubBs.push({ b: await launch(srv, `pub${i / PER}`), from: i, to: Math.min(n, i + PER) });
        const joined = await Promise.all(pubBs.map(({ b, from, to }) => b.page.evaluate((o) => window.H.startPublishers(o), { url: LK_URL, tokens: tokens.slice(from, to), key: KEY, w: 640, h: 360, fps: 15, batch: 1, offset: from }).then(r => r.joined)));
        console.log(`  published ${joined.reduce((a, b) => a + b, 0)}/${n} cameras in ${round((Date.now() - t0) / 1000)} s over ${pubBs.length} browsers`);
        const cpuAll = async () => { let t = 0; for (const { b } of pubBs) t += (await cpuSeconds(b.cdp)).total; return t; };
        for (const policy of policies) {
            const viewB = await launch(srv, 'view');
            try {
                await viewB.page.evaluate((o) => window.H.startViewer(o), { url: LK_URL, token: await token(`viewer-${policy}`), key: KEY, policy, mode, cols: COLS, cellW: CW, cellH: CH, cap });
                await new Promise(r => setTimeout(r, 12000)); // let every layer settle
                const rows = [];
                const c0v = await cpuSeconds(viewB.cdp); const c0p = { total: await cpuAll() }; const w0 = Date.now();
                for (let i = 0; i < secs; i++) { await new Promise(r => setTimeout(r, 1000)); rows.push(await viewB.page.evaluate(() => window.H.sample())); }
                const dt = (Date.now() - w0) / 1000;
                const c1v = await cpuSeconds(viewB.cdp); const c1p = { total: await cpuAll() };
                const settled = rows.slice(3);
                const last = rows[rows.length - 1];
                const out = {
                    n, policy, mode, tiles: last.tiles, remoteCams: last.remoteCams,
                    viewerCpuCores: round((c1v.total - c0v.total) / dt, 2),
                    viewerCpuBy: Object.fromEntries(Object.keys(c1v.by).map(k => [k, round((c1v.by[k] - (c0v.by[k] ?? 0)) / dt, 2)])),
                    pubCpuCores: round((c1p.total - c0p.total) / dt, 2),
                    activeDecodes_p50: pct(settled.map(r => r.inboundActive), 50),
                    decFps_total_p50: pct(settled.map(r => r.decPerSec), 50),
                    decMpx_per_s_p50: pct(settled.map(r => r.decMpxPerSec), 50),
                    presentedFps_total_p50: pct(settled.map(r => r.videoFramesPresentedPerSec), 50),
                    heights: last.heights, jbMs: last.jbMs, encErrors: last.encErrors,
                };
                console.log(JSON.stringify(out));
                results.push(out);
            } finally { await viewB.browser.close(); }
        }
    } finally {
        for (const { b } of pubBs) { await b.page.evaluate(() => window.H.stop()).catch(() => {}); await b.browser.close().catch(() => {}); }
        srv.close();
    }
    return results;
}

async function proofRun() {
    // One publisher with the right key. A right-key viewer and a wrong-key viewer.
    const srv = await serve(DIST);
    const pubB = await launch(srv, 'pub');
    const good = await launch(srv, 'good');
    const bad = await launch(srv, 'bad');
    try {
        await pubB.page.evaluate((o) => window.H.startPublishers(o), { url: LK_URL, tokens: [await token('pub-000')], key: KEY, w: 640, h: 360, fps: 15, stagger: 0 });
        const base = { url: LK_URL, policy: 'layers', mode: 'auto', cols: 1, cellW: 400, cellH: 225, cap: 0 };
        await good.page.evaluate((o) => window.H.startViewer(o), { ...base, token: await token('viewer-good'), key: KEY });
        await bad.page.evaluate((o) => window.H.startViewer(o), { ...base, token: await token('viewer-bad'), key: randomBytes(32).toString('base64') });
        await new Promise(r => setTimeout(r, 15000));
        const g = await good.page.evaluate(() => window.H.proof());
        const b = await bad.page.evaluate(() => window.H.proof());
        console.log(JSON.stringify({ rightKey: g, wrongKey: b }));
        return { rightKey: g, wrongKey: b };
    } finally {
        await pubB.browser.close(); await good.browser.close(); await bad.browser.close(); srv.close();
    }
}

if (args.proof) { await proofRun(); process.exit(0); }
const policies = (args.policy ?? 'capped').split(',');
const results = await runMulti({ policies, mode: args.mode ?? 'auto', cap: Number(args.cap ?? 0) });
if (args.out) fs.appendFileSync(args.out, results.map(r => JSON.stringify(r)).join('\n') + '\n');
process.exit(0);
