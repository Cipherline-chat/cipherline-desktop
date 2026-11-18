// Drives harness/firewall-hitch.html in headless Chromium and summarises the worker's late
// frames against the main thread's work. Start the server first:
//   FW_HITCH_PORT=5246 npx vite --config harness/firewall-hitch.vite.config.ts
// then: QS='block=70&every=3100' node harness/firewall-hitch.mjs
// ENV: PAGE=home (the real overlay over the real Home: firewall-hitch-home.html), QS (page query), BASE, PW_CHROMIUM_EXE, VIEW (WxH, default 1078x935: the owner's window).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const PAGE = process.env.PAGE === 'home' ? 'firewall-hitch-home.html' : 'firewall-hitch.html';
const BASE = process.env.BASE ?? `http://127.0.0.1:5246/harness/${PAGE}`;
const QS = process.env.QS ?? '';
const [vw, vh] = (process.env.VIEW ?? '1078x935').split('x').map(Number);
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
    const page = await (await browser.newContext({ viewport: { width: vw, height: vh } })).newPage();
    page.on('pageerror', e => console.log('pageerror', e.message));
    await page.goto(`${BASE}?${QS}`, { timeout: 180000 });
    // The main thread's own time over the measured stretch (CDP Performance metrics, seconds).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    await page.waitForFunction(() => window.__fw?.t0 > 0, null, { timeout: 240000, polling: 100 });
    const m0 = await metrics();
    // TRACE=1: a Chromium trace of the measured stretch, summarised as the main thread's GCs
    // (when, how long) and its longest tasks: what a periodic hitch would line up with.
    const tracing = !!process.env.TRACE;
    const trace = [];
    if (tracing) {
        cdp.on('Tracing.dataCollected', e => trace.push(...e.value));
        await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'blink.gc', 'disabled-by-default-devtools.timeline'] } });
    }
    if (process.env.SHOT) { await page.waitForTimeout(3000); await page.screenshot({ path: process.env.SHOT }); }
    await page.waitForFunction(() => window.__fw?.done, null, { timeout: 240000, polling: 500 });
    const m1 = await metrics();
    let gc = null;
    if (tracing) {
        const ended = new Promise(res => cdp.once('Tracing.tracingComplete', res));
        await cdp.send('Tracing.end');
        await ended;
        const names = new Map();
        for (const e of trace) if (e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name);
        const main = (e) => names.get(`${e.pid}:${e.tid}`) === 'CrRendererMain';
        const isGc = (n) => /^(MinorGC|MajorGC|V8\.GC_SCAVENGER$|V8\.GC_MARK_COMPACTOR$|V8\.GC_MC_COMPLETE_SWEEPING|BlinkGC\.AtomicPauseMarkEpilogue|CppGC\.AtomicMark$|V8\.GC_MINOR_MARK_SWEEPER$)/.test(n);
        const evs = trace.filter(e => main(e) && e.ph === 'X' && e.dur && isGc(e.name)).sort((a, b) => a.ts - b.ts);
        const t0 = evs[0]?.ts ?? 0;
        const tasks = trace.filter(e => main(e) && e.ph === 'X' && e.name === 'RunTask' && e.dur > 20000).sort((a, b) => b.dur - a.dur).slice(0, 8);
        gc = {
            count: evs.length,
            byName: evs.reduce((m, e) => (m[e.name] = (m[e.name] ?? 0) + 1, m), {}),
            totalMs: +(evs.reduce((s, e) => s + e.dur, 0) / 1000).toFixed(1),
            maxMs: +(Math.max(0, ...evs.map(e => e.dur)) / 1000).toFixed(1),
            atS: evs.filter(e => e.dur > 500).map(e => `${e.name}@${((e.ts - t0) / 1e6).toFixed(2)}:${(e.dur / 1000).toFixed(1)}`).slice(0, 40),
            longTasksMs: tasks.map(e => +(e.dur / 1000).toFixed(0)),
        };
    }
    const d = (k) => +(m1[k] - m0[k]).toFixed(k.endsWith('Count') ? 0 : 3);
    const r = await page.evaluate(() => window.__fw);
    const t0 = r.t0;
    const inRun = (x) => x.at >= t0;
    const gaps = r.gaps.filter(inRun), blocks = r.blocks, loafs = r.loafs.filter(inRun);
    // A worker hitch "has main-thread work under it" when a block or LoAF overlaps [at - gap, at].
    const overlaps = (g, list) => list.some(b => b.at < g.at && b.at + b.ms > g.at - g.ms);
    const withBlock = gaps.filter(g => overlaps(g, blocks)).length;
    const withLoaf = gaps.filter(g => overlaps(g, loafs)).length;
    const big = gaps.filter(g => g.ms >= 40);
    const iv = big.slice(1).map((g, i) => Math.round(g.at - big[i].at));
    const summary = {
        params: r.params,
        playing_s: +(r.playingMs / 1000).toFixed(1), runs: r.runs,
        worker_late_frames: gaps.length,
        worker_late_ms: gaps.map(g => Math.round(g.ms)),
        worker_late_ge40ms: big.length,
        intervals_between_ge40ms: iv,
        under_a_block: withBlock, under_a_loaf: withLoaf,
        main_blocks: blocks.length,
        main_loafs: loafs.length, main_loaf_ms: loafs.map(l => `${Math.round(l.ms)}${l.scripts ? 's' : ''}/r${Math.round(l.render)}`),
        rates: r.rates,
        covered_at_end: r.covered,
        main_gc: gc,
        main_thread_s: { task: d('TaskDuration'), script: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration'), styleCount: d('RecalcStyleCount'), layoutCount: d('LayoutCount') },
    };
    console.log(JSON.stringify(summary));
} finally {
    await browser.close();
}
