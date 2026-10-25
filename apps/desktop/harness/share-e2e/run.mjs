#!/usr/bin/env node
/**
 * Screen-share E2E run: one publisher + one viewer (two separate Chromium
 * processes) against a THROWAWAY LiveKit container, the viewer's downlink
 * impaired with tc netem inside the SFU's network namespace. See README.md.
 *
 *   node run.mjs --mode incident|baseline|quick --out <file.jsonl> [--fps 60] [--codec h264]
 *   node run.mjs --summarize <file.jsonl>
 *
 * Env: LK_KEY, LK_SECRET (the throwaway server's key pair), DIST (built page),
 *      PLAYWRIGHT (path to playwright's index.mjs), LK_CONTAINER (default
 *      ckh-lk-verify), TC_SIDECAR (default ckh-tc-side), PUB_IP, VIEW_IP.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']] : a), []));

// ── Summary ────────────────────────────────────────────────────────────────

function pct(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))))]; }
function summarize(file) {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    // Phase by timestamp (rows are drained every 5 s, so the write-time label can lag).
    const marks = rows.filter(r => r.role === 'phase').sort((a, b) => a.t - b.t);
    const startOf = Object.fromEntries(marks.map(m => [m.phase, m.t]));
    for (const r of rows) { if (r.role === 'phase' || typeof r.t !== 'number') continue; let ph = 'warmup'; for (const m of marks) if (m.t <= r.t) ph = m.phase; r.phase = ph; r.phaseStart = startOf[ph] ?? r.t; }
    const phases = ['warmup', ...marks.map(m => m.phase)];
    const out = [];
    for (const ph of phases) {
        const v = rows.filter(r => r.phase === ph && r.role === 'view' && typeof r.fps === 'number');
        const p = rows.filter(r => r.phase === ph && r.role === 'pub');
        const ev = rows.filter(r => r.phase === ph && r.kind);
        const top = p.map(r => (r.layers ?? []).reduce((a, l) => ((l.w ?? 0) > (a?.w ?? 0) ? l : a), null)).filter(Boolean);
        const low = p.map(r => (r.layers ?? []).reduce((a, l) => (a === null || (l.w ?? 1e9) < (a.w ?? 1e9) ? l : a), null)).filter(Boolean);
        const sum = (a, k) => a.reduce((s, r) => s + (r[k] ?? 0), 0);
        const heights = {};
        for (const r of v) heights[r.h ?? 0] = (heights[r.h ?? 0] ?? 0) + 1;
        const lossVals = v.map(r => r.lossPct).filter(x => typeof x === 'number');
        const aLoss = v.map(r => r.aLossPct).filter(x => typeof x === 'number');
        const aConc = v.map(r => r.aConcPct).filter(x => typeof x === 'number');
        out.push({
            phase: ph, secs: v.length,
            rxFps_p50: pct(v.map(r => r.fps), 50), rxFps_p5: pct(v.map(r => r.fps), 5),
            rxLayers: Object.entries(heights).map(([h, n]) => `${h}p:${Math.round((n / v.length) * 100)}%`).join(' '),
            vLoss_avg: lossVals.length ? Math.round((lossVals.reduce((a, b) => a + b, 0) / lossVals.length) * 10) / 10 : null,
            vLoss_p95: pct(lossVals, 95),
            freezes: sum(v, 'freezes'), freezeS: Math.round(sum(v, 'freezeMs') / 100) / 10,
            maxFreezeTickMs: Math.max(0, ...v.map(r => r.freezeMs ?? 0)),
            pliSent: sum(v, 'pli'), pliPerMin: v.length ? Math.round((sum(v, 'pli') / v.length) * 600) / 10 : 0,
            rxKbps_p50: pct(v.map(r => r.kbps ?? 0), 50), totKbps_p50: pct(v.map(r => r.totKbps ?? 0), 50),
            aLoss_avg: aLoss.length ? Math.round((aLoss.reduce((a, b) => a + b, 0) / aLoss.length) * 10) / 10 : null,
            aConc_avg: aConc.length ? Math.round((aConc.reduce((a, b) => a + b, 0) / aConc.length) * 10) / 10 : null,
            aConc_p95: pct(aConc, 95),
            pubTopFps_p50: pct(top.map(l => l.fps ?? 0), 50), pubTopFps_p5: pct(top.map(l => l.fps ?? 0), 5),
            pubTopKbps_p50: pct(top.map(l => l.kbps ?? 0), 50), pubTopActive: top.length ? Math.round((top.filter(l => l.active !== false).length / top.length) * 100) + '%' : null,
            pubLowActive: low.length ? Math.round((low.filter(l => l.active !== false && (l.kbps ?? 0) > 0).length / low.length) * 100) + '%' : null,
            pliRxAtPub: p.reduce((s, r) => s + (r.layers ?? []).reduce((a, l) => a + (l.pli ?? 0), 0), 0),
            qlr: [...new Set(top.map(l => l.qlr))].join('/'),
            canvasFps_p50: pct(p.map(r => r.canvasFps ?? 0), 50),
            fallback: ev.filter(e => e.kind === 'share_rx_fallback').map(e => `${e.action}@${Math.round((e.t - e.phaseStart) / 1000)}s(${e.reason},loss ${e.loss_pct},hold ${e.hold_s})`).join(' '),
            rxLayerEvents: ev.filter(e => e.kind === 'rx_layer').map(e => `${e.from}->${e.size}@${Math.round((e.t - e.phaseStart) / 1000)}s`).join(' '),
            lowGate: ev.filter(e => e.kind === 'share_low_layer').map(e => `${e.on ? 'on' : 'off'}(${e.reason})`).join(' '),
            sfuCpu_p50: pct(rows.filter(r => r.phase === ph && r.role === 'sfu').map(r => r.cpu), 50),
            sfuMemMB_max: Math.max(0, ...rows.filter(r => r.phase === ph && r.role === 'sfu').map(r => r.memMB)),
        });
    }
    return out;
}

if (args.summarize) {
    const s = summarize(args.summarize);
    console.log(JSON.stringify(s, null, 1));
    process.exit(0);
}

// ── Run ────────────────────────────────────────────────────────────────────

const { AccessToken } = await import(process.env.LK_SDK ?? '/home/antigravity/Cipherline/node_modules/livekit-server-sdk/dist/index.js');
const { chromium } = await import(process.env.PLAYWRIGHT ?? '/home/antigravity/.local/share/playwright-mcp/node_modules/playwright/index.mjs');

const LK_KEY = process.env.LK_KEY; const LK_SECRET = process.env.LK_SECRET;
if (!LK_KEY || !LK_SECRET) throw new Error('LK_KEY / LK_SECRET');
const DIST = process.env.DIST; if (!DIST) throw new Error('DIST');
const LK = process.env.LK_CONTAINER ?? 'ckh-lk-verify';
const SIDE = process.env.TC_SIDECAR ?? 'ckh-tc-side';
const PUB_IP = process.env.PUB_IP; const VIEW_IP = process.env.VIEW_IP;
if (!PUB_IP || !VIEW_IP) throw new Error('PUB_IP / VIEW_IP');
const OUT = args.out ?? 'share-e2e.jsonl';
const FPS = Number(args.fps ?? 60);
const CODEC = args.codec ?? 'h264';
const E2EE = args.e2ee !== 'false';
const room = `share-e2e-${Date.now()}`;

const write = (o) => fs.appendFileSync(OUT, JSON.stringify(o) + '\n');

async function token(identity) {
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: '2h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    return at.toJwt();
}

// tc inside the SFU's netns, on the interface that carries the viewer's network.
function sh(cmd) { return execFileSync('docker', ['exec', SIDE, 'sh', '-c', cmd], { encoding: 'utf8' }).trim(); }
const IFACE = () => sh(`ip -o -4 addr show | awk '$4 ~ /^${VIEW_IP.replace(/\./g, '\\.')}\\// {print $2}'`);
let iface = '';
function netem(spec) {
    if (!iface) iface = IFACE();
    if (!spec) { try { sh(`tc qdisc del dev ${iface} root`); } catch { /* none */ } return; }
    sh(`tc qdisc replace dev ${iface} root netem ${spec}`);
}

// Phases: [name, seconds, netem spec | null | {burst:[bad, good, badSecs, goodSecs]}]
const RATE = args.rate ?? '8mbit';
const MODES = {
    probe: [['clean', Number(args.secs ?? 40), null]],
    quick: [['clean', 40, null], ['throttle', 60, `rate ${RATE} delay 15ms limit 150`], ['recover', 70, null]],
    baseline: [['baseline', Number(args.secs ?? 600), null]],
    incident: [
        ['clean1', 180, null],
        ['throttle8M', 180, `rate ${RATE} delay 15ms limit 150`],
        ['clean2', 180, null],
        ['lossBursts', 180, { burst: ['delay 40ms 30ms distribution normal loss 20%', 'delay 15ms', 10, 10] }],
        ['clean3', 180, null],
    ],
};
const phases = MODES[args.mode ?? 'quick'];

// Static server for the built page.
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
    const p = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const f = p.endsWith('/') ? path.join(p, 'index.html') : p;
    if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;

const flags = [
    '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
];
// Keep each browser on its own SFU interface: drop the server's candidates for the other one.
const filterScript = (ip) => `(() => {
  const ok = (c) => !c || c.indexOf(' ${ip} ') >= 0;
  const add = RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate = function (c, ...r) {
    const s = c && typeof c === 'object' ? c.candidate : '';
    if (s && !ok(s)) return Promise.resolve();
    return add.call(this, c, ...r);
  };
  const srd = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (d, ...r) {
    if (d && d.sdp) d = { type: d.type, sdp: d.sdp.split('\\r\\n').filter(l => !l.startsWith('a=candidate:') || ok(l)).join('\\r\\n') };
    return srd.call(this, d, ...r);
  };
})();`;

async function openPage(name, ip, viewport, extra = []) {
    const browser = await chromium.launch({ headless: true, channel: 'chromium', args: [...flags, ...extra] });
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(filterScript(ip));
    const page = await ctx.newPage();
    page.on('console', m => { const t = m.text(); if (/error|warn|ScreenShare|lighter|E2EE|harness/i.test(t) && !/DevTools/.test(t)) write({ t: Date.now(), role: name, console: t.slice(0, 400) }); });
    page.on('pageerror', e => write({ t: Date.now(), role: name, pageerror: String(e).slice(0, 400) }));
    await page.goto(pageUrl);
    await page.waitForFunction(() => window.HREADY === true);
    return { browser, page };
}

const keyB64 = E2EE ? randomBytes(32).toString('base64') : null;
const pub = await openPage('pub', PUB_IP, { width: 640, height: 360 }, args.clip ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${args.clip}`] : []);
const view = await openPage('view', VIEW_IP, { width: 2560, height: 1440 });
netem(null);
const pubInfo = await pub.page.evaluate(o => window.H.startPublisher(o), {
    url: `ws://${PUB_IP}:7880`, token: await token('pub'), keyB64, codec: CODEC, fps: FPS, width: Number(args.w ?? 2560), height: Number(args.h ?? 1440),
    resolution: args.res ?? '1440p', viewers: Number(args.viewers ?? 1), source: args.clip ? 'file' : 'canvas', gate: args.gate !== 'off', simulateHardware: args.hw !== 'false',
});
write({ t: Date.now(), role: 'meta', pubInfo, fps: FPS, codec: CODEC, e2ee: E2EE, mode: args.mode, phases: phases.map(p => [p[0], p[1]]) });
await view.page.evaluate(o => window.H.startViewer(o), { url: `ws://${VIEW_IP}:7880`, token: await token('view'), keyB64 });

let phase = 'warmup'; let phaseStart = Date.now();
let stop = false;
const drainLoop = (async () => {
    while (!stop) {
        await new Promise(r => setTimeout(r, 5000));
        for (const [name, p] of [['pub', pub], ['view', view]]) {
            try {
                const d = await p.page.evaluate(() => window.H.drain());
                for (const s of d.samples) write({ ...s, phase });
                for (const e of d.events) write({ ...e, from: name, phase, phaseStart });
            } catch (e) { write({ t: Date.now(), role: name, drainError: String(e).slice(0, 200) }); }
        }
        try {
            const st = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', LK], { encoding: 'utf8' }).trim();
            const [cpu, mem] = st.split(' ');
            write({ t: Date.now(), role: 'sfu', phase, cpu: parseFloat(cpu), memMB: parseFloat(mem) * (/GiB/.test(mem) ? 1024 : 1) });
        } catch { write({ t: Date.now(), role: 'sfu', phase, down: true }); }
    }
})();

await new Promise(r => setTimeout(r, 20_000)); // warmup: connect, subscribe, layers settle
for (const [name, secs, spec] of phases) {
    phase = name; phaseStart = Date.now();
    write({ t: phaseStart, role: 'phase', phase: name, secs, spec });
    console.log(`[${new Date().toISOString()}] phase ${name} ${secs}s ${JSON.stringify(spec)}`);
    if (spec && typeof spec === 'object' && spec.burst) {
        const [bad, good, badS, goodS] = spec.burst;
        const end = phaseStart + secs * 1000;
        while (Date.now() < end) {
            netem(bad); await new Promise(r => setTimeout(r, Math.min(badS * 1000, end - Date.now())));
            if (Date.now() >= end) break;
            netem(good); await new Promise(r => setTimeout(r, Math.min(goodS * 1000, end - Date.now())));
        }
        netem(null);
    } else {
        netem(spec);
        await new Promise(r => setTimeout(r, secs * 1000));
    }
}
netem(null);
await new Promise(r => setTimeout(r, 6000));
stop = true; await drainLoop;
const lkErrors = execFileSync('sh', ['-c', `docker logs ${LK} 2>&1 | grep -ciE '"level":"error"|\\tERROR\\t|panic' || true`], { encoding: 'utf8' }).trim();
write({ t: Date.now(), role: 'meta', lkErrorLines: Number(lkErrors), lkRunning: execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', LK], { encoding: 'utf8' }).trim() });
await pub.browser.close(); await view.browser.close(); server.close();
console.log(JSON.stringify(summarize(OUT), null, 1));
