// Electron main of the native-share-spike harness. One process, four renderer windows (sharer, E2EE viewer, wrong-key viewer,
// plain no-E2EE viewer) against a LOCAL LiveKit. The sharer's main-process side is the app's own code
// (electron/native-share-ipc.ts + native-share-encoder.ts, the real preload.ts bundle); only the room/UI glue is harness.
import { app, BrowserWindow, ipcMain, MessageChannelMain } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { AccessToken } from 'livekit-server-sdk';
import { registerNativeShareIpc } from '../../electron/native-share-ipc';

const ENV = (k: string, d?: string) => process.env[k] ?? d ?? '';
const DIST = ENV('SPIKE_DIST'), PRELOAD = ENV('SPIKE_PRELOAD'), HELPER = ENV('CIPHERLINE_NATIVE_SHARE_HELPER'), OUT = ENV('SPIKE_OUT', '/tmp/spike-result.json');
const LK_URL = ENV('SPIKE_LK_URL', 'ws://127.0.0.1:17880'), LK_KEY = ENV('SPIKE_LK_KEY'), LK_SECRET = ENV('SPIKE_LK_SECRET');
const W = Number(ENV('SPIKE_W', '1920')), H = Number(ENV('SPIKE_H', '1080')), FPS = Number(ENV('SPIKE_FPS', '90')), BPS = Number(ENV('SPIKE_BPS', '20000000'));
const helperLines: string[] = [];
const SCENARIO = ENV('SPIKE_SCENARIO', 'full');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY_OK = 'correct-horse-battery-staple-key-1', KEY_BAD = 'wrong-horse-battery-staple-key-2';

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

function serve(): Promise<number> {
    return new Promise((res) => {
        const srv = http.createServer((q, s) => {
            const f = path.join(DIST, decodeURIComponent((q.url ?? '/').split('?')[0]).replace(/^\/+$/, '/page.html'));
            if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end(); return; }
            const ext = path.extname(f); s.writeHead(200, { 'content-type': ext === '.js' ? 'text/javascript' : ext === '.html' ? 'text/html' : 'application/octet-stream' });
            fs.createReadStream(f).pipe(s);
        });
        srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port));
    });
}

async function token(identity: string, canPublish: boolean): Promise<string> {
    const t = new AccessToken(LK_KEY, LK_SECRET, { identity, ttl: 3600 });
    t.addGrant({ room: 'spike', roomJoin: true, canPublish, canSubscribe: true });
    return await t.toJwt();
}

function mkWin(port: number, preload: boolean): BrowserWindow {
    const w = new BrowserWindow({ width: 700, height: 420, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: preload ? PRELOAD : undefined, backgroundThrottling: false } });
    w.webContents.on('console-message', (_e, level, msg) => { if (!msg.includes('Electron Security Warning') && (level >= 2 || preload)) log('console[' + level + ']' + (preload ? '[sharer]' : '') + ' ' + msg.slice(0, 400)); });
    void w.loadURL(`http://127.0.0.1:${port}/page.html`);
    return w;
}
const LOG = ENV('SPIKE_LOG', '/tmp/spike-progress.log');
const log = (m: string) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
const ev = (w: BrowserWindow, code: string) => {
    log('ev ' + code.slice(0, 90));
    return Promise.race([w.webContents.executeJavaScript(code, true), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('ev timeout: ' + code.slice(0, 80))), 40000))]);
};

type Stat = Record<string, number | string | undefined>;
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

async function measure(viewer: BrowserWindow, ms: number) {
    const a = (await ev(viewer, 'lab.inbound()')) as Stat; const t0 = Date.now();
    const counters = (await ev(viewer, `lab.sampleCounters(${ms}, 250)`)) as number[];
    await sleep(Math.max(0, ms - (Date.now() - t0)));
    const b = (await ev(viewer, 'lab.inbound()')) as Stat; const dt = (Date.now() - t0) / 1000;
    let regress = 0, forward = 0, big = 0;
    for (let i = 1; i < counters.length; i++) { const d = counters[i] - counters[i - 1]; if (d < 0) regress++; else if (d > 0) forward++; if (d > 20) big++; }
    return {
        seconds: +dt.toFixed(2), decoded_delta: num(b.framesDecoded) - num(a.framesDecoded), fps_measured: +((num(b.framesDecoded) - num(a.framesDecoded)) / dt).toFixed(1),
        fps_reported: b.framesPerSecond, width: b.frameWidth, height: b.frameHeight, video_el: `${b.videoWidth}x${b.videoHeight}`,
        key_frames_delta: num(b.keyFramesDecoded) - num(a.keyFramesDecoded), pli_delta: num(b.pliCount) - num(a.pliCount), pli_per10s: +(((num(b.pliCount) - num(a.pliCount)) * 10) / dt).toFixed(1), key_per10s: +(((num(b.keyFramesDecoded) - num(a.keyFramesDecoded)) * 10) / dt).toFixed(1), freeze_delta: num(b.freezeCount) - num(a.freezeCount), freeze_s_delta: +(num(b.totalFreezesDuration) - num(a.totalFreezesDuration)).toFixed(2), nack_delta: num(b.nackCount) - num(a.nackCount),
        dropped_delta: num(b.framesDropped) - num(a.framesDropped), decoder: b.decoderImplementation, kbps: +(((num(b.bytesReceived) - num(a.bytesReceived)) * 8) / 1000 / dt).toFixed(0),
        counter_samples: counters.length, counter_first_last: counters.length ? [counters[0], counters[counters.length - 1]] : null, counter_regressions: regress, counter_forward: forward, counter_jumps_gt20: big,
    };
}

app.whenReady().then(async () => {
    const result: Record<string, unknown> = { config: { W, H, FPS, BPS, helper: HELPER } };
    const done = (code: number) => { fs.writeFileSync(OUT, JSON.stringify(result, null, 1)); console.log('RESULT ' + JSON.stringify(result)); app.exit(code); };
    try {
        registerNativeShareIpc(ipcMain as never, () => new MessageChannelMain() as never, HELPER, { onHelperLine: (l) => { helperLines.push(l); log('helper ' + l.slice(0, 200)); }, allowTestBackend: ENV('SPIKE_BACKEND') === 'pcm' });
        const port = await serve();
        const sharer = mkWin(port, true), viewer = mkWin(port, false), wrong = mkWin(port, false), plain = mkWin(port, false);
        await sleep(2500);
        result.nativeShareApiInSharer = await ev(sharer, '!!window.nativeShare');
        const url = JSON.stringify(LK_URL);
        await ev(sharer, `lab.connect(${url}, ${JSON.stringify(await token('sharer', true))}, ${JSON.stringify(KEY_OK)})`);
        // SPIKE_NOENC=1 (bisect aid): the sharer keeps its E2EE worker (so the native injector runs) but LiveKit's cryptor is switched off,
        // and the viewer joins without E2EE: isolates the H.264 stream + injection from the cryptor.
        const noenc = ENV('SPIKE_NOENC') === '1';
        if (noenc) await ev(sharer, 'lab.setEnc(false)');
        await ev(viewer, `lab.connect(${url}, ${JSON.stringify(await token('viewer', false))}, ${noenc ? 'null' : JSON.stringify(KEY_OK)})`);
        result.start = await ev(sharer, `lab.startNative(${JSON.stringify({ fps: FPS, width: W, height: H, bitrateBps: BPS, dummy: ENV('SPIKE_DUMMY', 'gen'), refresh: ENV('SPIKE_REFRESH') === '1', backend: ENV('SPIKE_BACKEND', 'vaapi') })})`);
        await sleep(7000);

        result.positive = await measure(viewer, SCENARIO === 'rate' ? 20000 : 10000);
        result.dummy_written = await ev(sharer, 'lab.genWritten()');
        result.sharer_outbound = await ev(sharer, 'lab.outbound()');
        result.sharer_worker_status = await ev(sharer, 'lab.workerStatus()');

        if (SCENARIO === 'storm') {
            if (ENV('SPIKE_IGNORE_PLI') === '1') await ev(sharer, 'lab.testIgnorePli(true)');
            if (ENV('SPIKE_IGNORE_PLI') === '1') await ev(sharer, 'lab.testIgnorePli(true)');
            result.baseline_before_broken = await measure(viewer, 10000);
            await ev(wrong, `lab.connect(${url}, ${JSON.stringify(await token('wrongkey', false))}, ${JSON.stringify(KEY_BAD)})`);
            await ev(plain, `lab.connect(${url}, ${JSON.stringify(await token('plain', false))}, null)`);
            await sleep(4000);
            result.good_viewer_with_two_broken_viewers = await measure(viewer, 20000);
            result.broken_wrong_key = await ev(wrong, 'lab.inbound()');
            result.broken_plain = await ev(plain, 'lab.inbound()');
            const late = mkWin(port, false); await sleep(2500);
            await ev(late, `lab.connect(${url}, ${JSON.stringify(await token('late', false))}, ${JSON.stringify(KEY_OK)})`);
            const tJoin = Date.now(); let first = 0;
            for (let i = 0; i < 160 && !first; i++) { await sleep(100); const st = (await ev(late, 'lab.inbound()')) as Stat; if (num(st.framesDecoded) > 0) first = Date.now() - tJoin; }
            result.late_good_viewer_first_frame_ms = first || null;
            result.late_good_viewer = await measure(late, 8000);
            result.injector = await ev(sharer, 'lab.injStats()');
            result.helper_lines = helperLines.slice(-3);
            done(0); return;
        }
        if (SCENARIO === 'rate') { result.sharer_outbound = await ev(sharer, 'lab.outbound()'); await sleep(3000); result.helper_lines = helperLines; done(0); return; }
        // negative controls: join MID-STREAM (also exercises the new-subscriber keyframe path), watch 10 s
        await ev(wrong, `lab.connect(${url}, ${JSON.stringify(await token('wrongkey', false))}, ${JSON.stringify(KEY_BAD)})`);
        await ev(plain, `lab.connect(${url}, ${JSON.stringify(await token('plain', false))}, null)`);
        result.late_join_viewer_check = await measure(viewer, 1000);
        await sleep(10000);
        result.negative_wrong_key = { inbound: await ev(wrong, 'lab.inbound()'), counter: await ev(wrong, 'lab.readCounter()') };
        result.negative_plain_no_e2ee = { inbound: await ev(plain, 'lab.inbound()'), counter: await ev(plain, 'lab.readCounter()') };

        // key/delta: (a) guard ON: 5 AUs vanish, injector resyncs on an IDR; (b) guard OFF: orphan deltas reach the receiver
        await ev(sharer, 'lab.testSkip(5, true)');
        result.forced_gap_with_guard = await measure(viewer, 6000);
        await sleep(2000);
        await ev(sharer, 'lab.testSkip(5, false)');
        result.forced_gap_without_guard = await measure(viewer, 6000);
        await sleep(2000);
        result.after_recovery = await measure(viewer, 4000);

        // fallback: kill the helper mid-share
        const pre = (await ev(viewer, 'lab.readCounter()')) as number | null;
        const tKill = Date.now();
        try { execSync(`pkill -KILL -f 'share-encoder-helper --serve'`); } catch { /* none */ }
        let tDead = 0;
        for (let i = 0; i < 60 && !tDead; i++) { await sleep(100); const st = (await ev(sharer, 'lab.workerStatus()')) as { state: string; t: number }[]; const d = st.find((s) => s.state === 'dead'); if (d) tDead = d.t; }
        await ev(sharer, `lab.startFallback(${JSON.stringify({ fps: 30, width: 1280, height: 720 })})`);
        const tPub = Date.now();
        let tFirst = 0, sawFallback = false; const seen: number[] = [];
        for (let i = 0; i < 200 && !sawFallback; i++) { await sleep(50); const c = (await ev(viewer, 'lab.readCounter()')) as number | null; if (c !== null) { seen.push(c); if (c >= 40000) { sawFallback = true; tFirst = Date.now(); } } }
        result.fallback = {
            counter_before_kill: pre, worker_declared_dead_ms_after_kill: tDead ? tDead - tKill : null, republish_started_ms_after_kill: tPub - tKill,
            viewer_first_fallback_frame_ms_after_kill: sawFallback ? tFirst - tKill : null, viewer_saw_fallback: sawFallback,
            after: await measure(viewer, 5000),
        };
        result.helper_lines = helperLines;
        result.sharer_events = await ev(sharer, 'lab.events()');
        result.viewer_events = await ev(viewer, 'lab.events()');
        done(0);
    } catch (e) { result.error = String((e as Error).stack ?? e); done(1); }
});
