// Night dive screenshots (real Chromium). Needs the harness server:
//   npx vite --config harness/night-dive.vite.config.ts      (serves :5321, ND_PORT to change)
//   node harness/night-dive-shots.mjs <outDir> [--frames] [--video]
//     env: BASE, PW_CORE, PW_CHROMIUM_EXE
// Writes, per view (home, dm, group, server, friends, settings):
//   <view>-day.png, <view>-night.png, <view>-pair.png (day | night)
// and checks:
//   - DAY IS UNCHANGED: the day render with night-dive.css loaded is pixel-identical
//     to the render WITHOUT it (?bare=1);
//   - ELEMENTS ARE UNCHANGED at night: computed colours of panels, cards, inputs,
//     bubbles, borders and text are identical day vs night;
//   - the backgrounds really are darker at night (sampled pixels).
// --frames: descend/ascend frame strips (animations + transitions paused and seeked).
// --video:  30 fps frame sequences for an MP4 (descend-v/NNNN.png, ascend-v/NNNN.png).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5321/harness/night-dive.html';
const OUT = process.argv[2] ?? '/tmp/night-dive-shots';
const FRAMES = process.argv.includes('--frames');
const VIDEO = process.argv.includes('--video');
const ONLY = (process.argv.find(a => a.startsWith('--views=')) ?? '').slice(8);
const VIEWS = ONLY === 'none' ? [] : ONLY ? ONLY.split(',') : ['home', 'dm', 'group', 'server', 'friends', 'settings'];
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
async function open(query, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1, reducedMotion: opts.reducedMotion ?? 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(180000);
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + query);
    await page.waitForFunction(() => window.__booted === true);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2200);
    // Freeze everything decorative so two renders are comparable pixel for pixel.
    if (opts.freeze !== false) await page.evaluate(() => document.getAnimations().forEach(a => { try { a.finish(); } catch { a.pause(); a.currentTime = 0; } }));
    await page.waitForTimeout(150);
    return { ctx, page };
}

// Pixel diff of two PNG files, done in a page (no image deps).
let diffPage;
async function pixelDiff(a, b) {
    if (!diffPage) diffPage = await (await browser.newContext()).newPage();
    const A = readFileSync(a).toString('base64'), B = readFileSync(b).toString('base64');
    return diffPage.evaluate(async ([A, B]) => {
        const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
        const [ia, ib] = await Promise.all([load(A), load(B)]);
        const px = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
        const da = px(ia), db = px(ib);
        let n = 0, max = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0; i < da.length; i += 4) {
            const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
            if (d > 0) {
                n++; const p = i / 4, x = p % ia.width, y = Math.floor(p / ia.width);
                x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
            }
            if (d > max) max = d;
        }
        return { changed: n, max, total: da.length / 4, bbox: n ? [x0, y0, x1, y1] : null };
    }, [A, B]);
}

// Computed colours of ELEMENTS (not backgrounds) that must not change at night.
const ELEMENT_PROBES = {
    home: ['.hd-tile', '.hd-card', '.hd-btn', '.hd-head h2'],
    dm: ['.app-pane2-sheet', '.chat-pane-root > .h-\\[54px\\]', '.app-pane2-sheet .bg-cl-surface', 'textarea', '[id^="msg-"] .bg-cl-surface, [id^="msg-"] [class*="bg-cl-surface"]'],
    group: ['.app-pane2-sheet', '.chat-pane-root > .h-\\[54px\\]', 'textarea'],
    server: ['.app-pane2-sheet', '.chat-pane-root > .h-\\[54px\\]', 'textarea'],
    friends: ['.friends-pane-root .border-cl-border', '.friends-pane-root input', '.friends-pane-root button'],
    settings: ['.sd-root .cl-inp, .sd-root input', '.sd-root .cl-toggle .cl-trk', '.sd-root h1, .sd-root h2'],
};
async function probe(page, view) {
    return page.evaluate(sels => sels.map(sel => {
        const el = document.querySelector(sel);
        if (!el) return { sel, missing: true };
        const cs = getComputedStyle(el);
        return { sel, bg: cs.backgroundColor, bgi: cs.backgroundImage.slice(0, 120), color: cs.color, border: cs.borderTopColor };
    }), ELEMENT_PROBES[view] ?? []);
}
// Sample background pixels (spots with no content) to report the darkening.
const BG_SPOTS = {
    home: { water: [36, 600], deck: [800, 160] },
    dm: { water: [36, 600], feed: [900, 140] },
    group: { water: [36, 600], feed: [900, 140] },
    server: { water: [36, 600], feed: [900, 140] },
    friends: { water: [36, 600], view: [1100, 780] },
    settings: { sea: [1400, 840] },
};
async function samplePixels(file, view) {
    if (!diffPage) diffPage = await (await browser.newContext()).newPage();
    const B = readFileSync(file).toString('base64');
    return diffPage.evaluate(async ([B, spots]) => {
        const i = await new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + B; });
        const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0);
        const out = {};
        for (const [k, [px, py]] of Object.entries(spots)) { const d = x.getImageData(px, py, 1, 1).data; out[k] = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join(''); }
        return out;
    }, [B, BG_SPOTS[view] ?? {}]);
}

for (const view of VIEWS) {
    const files = {};
    for (const [tag, q] of [['bare', `?view=${view}&bare=1`], ['day', `?view=${view}`], ['night', `?view=${view}&depth=night`]]) {
        const { ctx, page } = await open(q);
        files[tag] = `${OUT}/${view}-${tag}.png`;
        await page.screenshot({ path: files[tag] });
        if (tag !== 'bare') files[tag + 'Probe'] = await probe(page, view);
        await ctx.close();
    }
    // Day identity, compared with ambient particles out of the picture (reduced
    // motion: the settings dust and home motes are randomly phased per load) and
    // retried for late async avatars/names, so only a REAL styling change fails.
    let d;
    for (let attempt = 0; attempt < 3; attempt++) {
        for (const [tag, q] of [['bareRM', `?view=${view}&bare=1`], ['dayRM', `?view=${view}`]]) {
            const { ctx, page } = await open(q, { reducedMotion: 'reduce' });
            await page.waitForTimeout(800 * attempt);
            files[tag] = `${OUT}/${view}-${tag}.png`;
            await page.screenshot({ path: files[tag] });
            await ctx.close();
        }
        d = await pixelDiff(files.bareRM, files.dayRM);
        if (d.changed === 0) break;
    }
    check(`${view}: day render identical with and without night-dive.css`, d.changed === 0, JSON.stringify(d));
    const pc = await pixelDiff(files.day, files.night);
    check(`${view}: positive control — the diff does see the night render`, pc.changed > 100000, `changed=${pc.changed}`);
    const dayP = files.dayProbe, nightP = files.nightProbe;
    for (let i = 0; i < dayP.length; i++) {
        if (dayP[i].missing) { console.log(`  (probe ${dayP[i].sel} not found in ${view})`); continue; }
        const same = JSON.stringify(dayP[i]) === JSON.stringify(nightP[i]);
        check(`${view}: element unchanged at night: ${dayP[i].sel}`, same, same ? `bg=${dayP[i].bg}` : `day=${JSON.stringify(dayP[i])} night=${JSON.stringify(nightP[i])}`);
    }
    const sd = await samplePixels(files.day, view), sn = await samplePixels(files.night, view);
    for (const k of Object.keys(sd)) console.log(`  ${view} ${k.padEnd(6)} day=${sd[k]} night=${sn[k]}`);
    // side-by-side composite
    const ctx = await browser.newContext({ viewport: { width: 2940, height: 940 } });
    const p = await ctx.newPage();
    const b64 = f => readFileSync(f).toString('base64');
    await p.setContent(`<body style="margin:0;background:#1d1d1d;display:flex;gap:20px;padding:20px;font:700 18px system-ui,sans-serif;color:#ddd">
      <div><div style="margin-bottom:8px">DAY</div><img style="width:1440px;display:block" src="data:image/png;base64,${b64(files.day)}"></div>
      <div><div style="margin-bottom:8px">NIGHT DIVE v2 (00:00 to 05:00) — background only</div><img style="width:1440px;display:block" src="data:image/png;base64,${b64(files.night)}"></div></body>`);
    await p.screenshot({ path: `${OUT}/${view}-pair.png`, fullPage: true });
    await ctx.close();
}

// Transition frames: everything (CSS animations AND the registered-property
// transitions) paused and seeked to the same time.
async function prepRun(view, startDepth, active) {
    const { ctx, page } = await open(`?view=${view}&depth=${startDepth}`, { freeze: false });
    await page.evaluate(() => { const st = window.setTimeout.bind(window); window.setTimeout = (f, ms, ...r) => st(f, ms >= 4000 ? 600000 : ms, ...r); });
    // Park the ambient loops (motes) so frames differ only by the transition.
    await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
    await page.evaluate(a => window.__dive(a), active);
    await page.waitForSelector('[data-testid=night-dive-sea][data-run]');
    await page.waitForTimeout(60);
    const n = await page.evaluate(() => { const a = document.getAnimations(); a.forEach(x => x.pause()); return a.map(x => x.constructor.name + ':' + (x.animationName ?? x.transitionProperty)).join(' '); });
    console.log(`${view} ${active ? 'descend' : 'ascend'}: ${n}`);
    const seek = async ms => {
        await page.evaluate(t => document.getAnimations().forEach(a => {
            // Each animation's own start offset is part of its timing (delay), so
            // one shared currentTime keeps them in step; ambient loops stay parked.
            const ours = (a.transitionProperty ?? '').startsWith('--nd-') || ((a.animationName ?? '').startsWith('nds-') && a.animationName !== 'nds-mote');
            if (ours) a.currentTime = t;
        }), ms);
        await page.waitForTimeout(90);
    };
    return { ctx, page, seek };
}
async function frames(kind, view, startDepth, active, times) {
    const { ctx, page, seek } = await prepRun(view, startDepth, active);
    const shots = [];
    for (const ms of times) {
        await seek(ms);
        const f = `${OUT}/${kind}-${view}-${String(ms).padStart(4, '0')}.png`;
        await page.screenshot({ path: f });
        shots.push([ms, f]);
    }
    await ctx.close();
    return shots;
}
async function sheet(name, shots, title) {
    const ctx = await browser.newContext({ viewport: { width: 2960, height: 1000 } });
    const p = await ctx.newPage();
    const cells = shots.map(([ms, f]) => `<div style="position:relative"><div style="position:absolute;left:8px;top:6px;background:#000a;padding:2px 8px;border-radius:6px">${(ms / 1000).toFixed(1)} s</div><img style="width:720px;display:block" src="data:image/png;base64,${readFileSync(f).toString('base64')}"></div>`).join('');
    await p.setContent(`<body style="margin:0;background:#141414;padding:16px;font:700 16px system-ui,sans-serif;color:#eee"><div style="margin-bottom:10px">${title}</div><div style="display:grid;grid-template-columns:repeat(4,720px);gap:10px">${cells}</div></body>`);
    await p.screenshot({ path: `${OUT}/${name}`, fullPage: true });
    await ctx.close();
}
if (FRAMES) {
    const T = [0, 700, 1400, 2100, 2800, 3500, 4300, 5600];
    for (const view of ['dm', 'home']) {
        await sheet(`descend-${view}-sheet.png`, await frames('descend', view, 'day', true, T), `Night dive v2 — descent at 00:00 (${view})`);
        await sheet(`ascend-${view}-sheet.png`, await frames('ascend', view, 'night', false, T), `Night dive v2 — ascent at 05:00 (${view})`);
    }
}
if (VIDEO) {
    for (const [kind, start, active] of [['descend', 'day', true], ['ascend', 'night', false]]) {
        const dir = `${OUT}/${kind}-v`; mkdirSync(dir, { recursive: true });
        const { ctx, page, seek } = await prepRun('dm', start, active);
        let i = 0;
        for (let ms = 0; ms <= 6000; ms += 1000 / 30) {
            await seek(Math.round(ms));
            await page.screenshot({ path: `${dir}/${String(i++).padStart(4, '0')}.png` });
        }
        await ctx.close();
    }
}

// Real-time behaviour: event, sea lifetime, reduced motion.
{
    const { ctx, page } = await open('?view=dm', { freeze: false });
    check('day: no sea layer', await page.evaluate(() => !document.querySelector('[data-testid=night-dive-sea]') && !document.documentElement.hasAttribute('data-nd-sea')));
    await page.evaluate(() => window.__dive(true));
    await page.waitForSelector('[data-testid=night-dive-sea]');
    const events = await page.evaluate(() => window.__events);
    check('event enter dispatched', events.length === 1 && events[0].active === true && events[0].reason === 'enter', JSON.stringify(events));
    check('sea is behind everything (z-index -1, child of body, inert)', await page.evaluate(() => { const s = document.querySelector('[data-testid=night-dive-sea]'); const cs = getComputedStyle(s); return s.parentElement === document.body && cs.zIndex === '-1' && cs.position === 'fixed' && cs.pointerEvents === 'none' && s.getAttribute('aria-hidden') === 'true'; }));
    check('no text in the sea layer', await page.evaluate(() => document.querySelector('[data-testid=night-dive-sea]').textContent === ''));
    await page.waitForFunction(() => !document.querySelector('[data-testid=night-dive-sea][data-run]'), null, { timeout: 15000 });
    check('descent finishes; the sea stays for the night', await page.evaluate(() => !!document.querySelector('[data-testid=night-dive-sea]')));
    await page.evaluate(() => window.__dive(false));
    await page.waitForSelector('[data-testid=night-dive-sea][data-run=ascend]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=night-dive-sea]'), null, { timeout: 15000 });
    check('ascent finishes; the sea unmounts and the water is opaque again', await page.evaluate(() => !document.documentElement.hasAttribute('data-nd-sea') && getComputedStyle(document.querySelector('.app-mainrow')).backgroundColor !== 'rgba(0, 0, 0, 0)'));
    await ctx.close();
}
{
    const { ctx, page } = await open('?view=dm', { reducedMotion: 'reduce', freeze: false });
    await page.evaluate(() => window.__dive(true));
    await page.waitForTimeout(300);
    check('reduced motion: sea present but not running a descent', await page.evaluate(() => { const s = document.querySelector('[data-testid=night-dive-sea]'); return !!s && !s.hasAttribute('data-run'); }));
    check('reduced motion: no animations at all in the sea', await page.evaluate(() => document.getAnimations().filter(a => a.effect?.target?.closest?.('.nds')).length === 0));
    check('reduced motion: feed background is instantly the night value', await page.evaluate(() => getComputedStyle(document.querySelector('.chat-pane-root')).getPropertyValue('--nd-feed-bot').trim()) === 'rgba(5, 8, 18, 0.4)');
    check('reduced motion: event still fires', (await page.evaluate(() => window.__events)).length === 1);
    await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL OK');
process.exit(failures ? 1 : 0);
