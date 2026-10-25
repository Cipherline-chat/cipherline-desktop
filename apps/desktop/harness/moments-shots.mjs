// Full-screen moments: deterministic frame strips, a hero shot of the settled frame, the reduced-motion
// still card, a "the hold really is still" check and (VIDEO=1) an MP4 per moment, plus one index sheet of
// every moment. Real Chromium.
//
//   npx vite --config harness/moments.vite.config.ts      (serves :5427)
//   node harness/moments-shots.mjs     (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=... ONLY=a,b VIDEO=1)
//
// Frames are DETERMINISTIC: the moment is played, the window is reported hidden (which makes the
// host pause its own clock — the same path a minimised window takes), then every animation on the
// page is paused and seeked with document.getAnimations() to each sample time.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5427/harness/moments.html';
const OUT = process.env.OUT ?? '/tmp/moments-shots';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const VIDEO = process.env.VIDEO === '1';
const FPS = 30;
// Moments photographed somewhere other than the plain app backdrop (?scene=call = over a call stage; ?date= freezes the clock).
const QUERY = { 'nye-call': '?scene=call&date=2027-01-01T00:00:03', 'pi-day': '?scene=play&date=2027-03-14T13:59:10', 'leap-day': '?scene=play&date=2028-02-29T08:00:00' };
const queryOf = id => QUERY[id] ?? '?scene=play';
const VAAPI = existsSync('/dev/dri/renderD128') && process.env.VAAPI !== '0';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });

async function open(query, opts = {}) {
    const ctx = await browser.newContext({
        viewport: opts.viewport ?? { width: 1280, height: 800 },
        deviceScaleFactor: opts.dpr ?? 1,
        reducedMotion: opts.reducedMotion ?? 'no-preference',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(Number(process.env.TIMEOUT ?? 180000));
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + query, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Array.isArray(window.__ids));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(opts.settle ?? 600);
    return { ctx, page };
}

/** Play `id`, then freeze it: hidden window → the host pauses; every animation paused. */
async function playFrozen(page, id) {
    await page.evaluate(() => window.__reset());
    await page.evaluate(i => window.__play(i), id);
    await page.waitForSelector(`[data-moment="${id}"]`, { timeout: 20000 });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        for (const a of document.getAnimations()) a.pause();
    });
}
/** Seek every animation to t ms. Keys' own idle loops (k2-*) are pinned to 0 so frames compare cleanly. */
const seek = (page, t) => page.evaluate(ms => {
    for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = String(a.animationName ?? '').startsWith('k2-') ? 0 : ms;
    }
}, t);
/** A small time/phase label in the corner of a strip frame. */
const label = (page, text) => page.evaluate(t => {
    let el = document.getElementById('__t');
    if (!el) {
        el = document.createElement('div');
        el.id = '__t';
        el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;font:700 22px/1.2 monospace;color:#fff;background:rgba(0,0,0,.65);padding:4px 10px;border-radius:6px;pointer-events:none';
        document.body.appendChild(el);
    }
    el.textContent = t;
}, text);
const unlabel = page => page.evaluate(() => document.getElementById('__t')?.remove());

/** Fraction of pixels that differ between two PNG buffers (decoded in the page). */
async function pixelDiff(page, a, b) {
    return page.evaluate(async ([x, y]) => {
        const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
        const [ia, ib] = await Promise.all([load(x), load(y)]);
        const c = new OffscreenCanvas(ia.width, ia.height);
        const g = c.getContext('2d');
        g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, ia.width, ia.height).data;
        g.clearRect(0, 0, ia.width, ia.height);
        g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, ia.width, ia.height).data;
        let n = 0;
        for (let k = 0; k < da.length; k += 4) if (Math.abs(da[k] - db[k]) + Math.abs(da[k + 1] - db[k + 1]) + Math.abs(da[k + 2] - db[k + 2]) > 24) n++;
        return n / (da.length / 4);
    }, [a.toString('base64'), b.toString('base64')]);
}

const ids = await (async () => {
    const { ctx, page } = await open('?scene=play');
    const all = await page.evaluate(() => window.__ids);
    const info = await page.evaluate(async () => {
        const m = await import('/src/utils/moments.ts');
        return Object.fromEntries(Object.keys(m.MOMENTS).map(k => [k, {
            p: m.momentPhases(k), stays: m.momentStays(k), hero: m.MOMENTS[k].heroMs, still: m.stillMs(k),
        }]));
    })
    await ctx.close();
    return all.filter(i => !ONLY || ONLY.has(i)).map(i => ({ id: i, ...info[i] }));
})();

const phaseOf = (p, t) => t < p.main ? 'notice' : t < p.read ? 'main' : t < p.hold ? 'read' : t < p.exit ? 'hold' : 'exit';

for (const { id, p, stays, hero, still } of ids) {
    const dir = `${OUT}/${id}`;
    mkdirSync(dir, { recursive: true });
    // A moment whose button stays is shown to a point well past where the others would have left.
    const dur = stays ? p.exit + 1500 : p.end;

    // Strip: 10 frames — one per phase boundary that matters plus evenly between — → a 5x2 sheet.
    {
        const { ctx, page } = await open(queryOf(id));
        await playFrozen(page, id);
        const times = [250, p.main + 300, Math.round((p.main + p.read) / 2), p.read - 150, p.read + 300,
            Math.round((p.read + p.hold) / 2), p.hold + 100, p.exit - 100, stays ? dur - 100 : p.exit + Math.round((p.end - p.exit) / 2), dur - 60];
        for (let k = 0; k < times.length; k++) {
            await seek(page, times[k]);
            await label(page, `${(times[k] / 1000).toFixed(2)}s ${phaseOf(p, times[k])}${stays && times[k] >= p.exit ? ' (waits)' : ''}`);
            await page.screenshot({ path: `${dir}/strip-${String(k).padStart(2, '0')}.png` });
        }
        await unlabel(page);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${dir}/strip-%02d.png`, '-vf', 'scale=640:-1,tile=5x2:padding=6:color=0x05070f', '-frames:v', '1', `${OUT}/${id}-strip.png`]);
        const present = await page.evaluate(i => !!document.querySelector(`[data-moment="${i}"]`), id);
        check(`${id}: still on screen while frozen (host paused its clock)`, present);

        // The read phase: every data-read element fully opaque (walking up to the root).
        for (const t of [p.read + 20, p.exit - 20]) {
            await seek(page, t);
            const minOpacity = await page.evaluate(() => {
                const els = [...document.querySelectorAll('[data-moment] [data-read]')];
                let min = 1;
                for (const el of els) {
                    let o = 1;
                    for (let n = el; n && n !== document.body; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
                    min = Math.min(min, o);
                }
                return els.length ? min : -1;
            });
            check(`${id}: punchline fully visible at ${(t / 1000).toFixed(2)}s`, minOpacity > 0.99, `opacity=${minOpacity.toFixed(3)}`);
        }
        // The hold: the first and last frame of the hold are the same picture (nothing travels).
        await seek(page, p.hold + 30);
        const a = await page.screenshot();
        await seek(page, p.exit - 30);
        const b = await page.screenshot();
        const d = await pixelDiff(page, a, b);
        check(`${id}: the hold is a settled frame (${((p.exit - p.hold) / 1000).toFixed(1)} s)`, d < 0.002, `diff=${(d * 100).toFixed(3)}%`);
        // Over a call stage: the control bar must be untouched at every sampled moment, and clicks must reach it.
        if (queryOf(id).includes('scene=call')) {
            const clip = await page.evaluate(() => { const r = document.querySelector('[data-testid="harness-controls"]').getBoundingClientRect(); return { x: Math.floor(r.x) - 8, y: Math.floor(r.y) - 8, width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 }; });
            const base = await open(queryOf(id));
            const baseline = await base.page.screenshot({ clip });
            await base.ctx.close();
            let worst = 0;
            for (let t = 100; t < p.end; t += 250) {
                await seek(page, t);
                worst = Math.max(worst, await pixelDiff(page, baseline, await page.screenshot({ clip })));
            }
            check(`${id}: never covers the call controls (worst diff over the whole run)`, worst < 0.0005, `diff=${(worst * 100).toFixed(3)}%`);
            const hit = await page.evaluate(() => { const r = document.querySelector('[data-testid="harness-controls"]').getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!el?.closest('[data-testid="harness-controls"]'); });
            check(`${id}: clicks reach the call controls through it`, hit);
        }
        await ctx.close();
    }
    // Hero frame at 2x: the settled frame (or the registry's override).
    {
        const { ctx, page } = await open(queryOf(id), { dpr: 2 });
        await playFrozen(page, id);
        await seek(page, hero ?? p.hold + 300);
        await page.screenshot({ path: `${OUT}/${id}-hero.png` });
        await ctx.close();
    }
    // Reduced motion: the still card, and that it stays up long enough to read.
    {
        const { ctx, page } = await open(queryOf(id), { reducedMotion: 'reduce' });
        await page.evaluate(() => window.__reset());
        const playedAt = await page.evaluate(i => { window.__play(i); return performance.now(); }, id);
        await page.waitForSelector('[data-testid="moment-still"]', { timeout: 20000 });
        const anims = await page.evaluate(() => document.querySelector('[data-testid="moment"]').getAnimations({ subtree: true }).filter(a => !String(a.animationName ?? '').startsWith('k2-')).length);
        check(`${id}: reduced motion → still card, no moment animation`, anims === 0, `animations=${anims}`);
        await page.screenshot({ path: `${OUT}/${id}-reduced.png` });
        // Measured in the page from the moment it was asked for (screenshots are slow under load):
        // still up 400 ms before stillMs, gone after it.
        const at = await page.evaluate(async ([t0, ms]) => {
            const up = () => !!document.querySelector('[data-testid="moment-still"]');
            while (performance.now() - t0 < ms - 400) { if (!up()) return performance.now() - t0; await new Promise(r => setTimeout(r, 50)); }
            return -1;
        }, [playedAt, still]);
        check(`${id}: reduced card stays up ${(still / 1000).toFixed(1)} s (reading time + hold)`, at === -1, at === -1 ? '' : `gone at ${Math.round(at)} ms`);
        await ctx.close();
    }
    // Video: every frame seeked at 30 fps (deterministic), encoded with ffmpeg (VAAPI when present).
    if (VIDEO) {
        const { ctx, page } = await open(queryOf(id), { viewport: { width: 1280, height: 800 } });
        await playFrozen(page, id);
        const vdir = `${dir}/video`;
        mkdirSync(vdir, { recursive: true });
        const frames = Math.ceil(dur / 1000 * FPS);
        for (let f = 0; f <= frames; f++) {
            await page.evaluate(ms => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } }, Math.min(dur - 1, f * 1000 / FPS));
            await page.screenshot({ path: `${vdir}/f${String(f).padStart(4, '0')}.png` });
        }
        const enc = VAAPI
            ? ['-vaapi_device', '/dev/dri/renderD128', '-framerate', String(FPS), '-i', `${vdir}/f%04d.png`, '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-qp', '20']
            : ['-framerate', String(FPS), '-i', `${vdir}/f%04d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20'];
        try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...enc, `${OUT}/${id}.mp4`]); }
        catch { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${vdir}/f%04d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', `${OUT}/${id}.mp4`]); }
        rmSync(vdir, { recursive: true, force: true });
        await ctx.close();
    }
    console.log(`done ${id}`);
}

// Index: every hero, labelled.
if (!ONLY) {
    const html = `<!doctype html><meta charset=utf-8><body style="margin:0;background:#05070f;font:600 15px Nunito,sans-serif;color:#F4F7FF">
<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:18px">
${ids.map(({ id, p, stays }) => `<figure style="margin:0"><img src="${id}-hero.png" style="width:100%;border-radius:8px;display:block"><figcaption style="padding:6px 2px">${id} · ${stays ? 'waits for a click' : (p.end / 1000).toFixed(1) + ' s'}</figcaption></figure>`).join('\n')}
</div>`;
    writeFileSync(`${OUT}/index.html`, html);
    const ctx = await browser.newContext({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`file://${OUT}/index.html`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/index.png`, fullPage: true });
    await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
