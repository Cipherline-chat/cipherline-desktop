// Panel corner PIXEL probe (claude/panel-corners-dark, 2026-11-20).
//
// light-theme-corner-probe.mjs reasons about CSS (who clips whose shadow).
// This one looks at the pixels, so it also catches what the CSS reasoning
// misses (a shadow cut by a clip box three ancestors up, a sticky footer, a
// painted square under a rounded child):
//
//   For every rounded panel (rail decks, channel/DM list, chat, right panel,
//   Home / Friends, the windowed Settings) and every rounded painted card
//   inside Home / Friends / the right panel / Settings / the list:
//   1. A = the frame; B = the same frame with that one element hidden
//      (visibility:hidden). D = A - B is exactly what the element and its
//      subtree paint, its shadow included; the backdrop (gradients, other
//      panes) cancels out.
//   2. In the corner gap (inside the bounding square, OUTSIDE the curve,
//      >= 2.5 CSS px from it, clear of anti-aliasing and the 1px border)
//      compare |D| with |D| at the SAME distance outside each of the two
//      straight edges next to that corner (references off the window or in
//      the title bar are skipped).
//   delta = max over gap pixels and both references of max over RGB of
//   (|D gap| - |D ref|): how much more the element paints into its own
//   corner gap than just beyond its edges, in 0-255 levels. A square corner
//   (a shadow cut off at the edge, a square child poking out) is a tinted gap
//   with clean surroundings. Reported when >= --min (default 2).
//   Baseline: a soft shadow with room around it is not perfectly even
//   either; the Light website shadow (0 24px 48px -24px) scores 3-4 at the
//   bottom corners with NO clipping at all (--css below), Dark scores 0.
//
//   PC_PORT=5447 npx vite --config harness/panel-corners.vite.config.ts     (another shell)
//   node harness/panel-corners-probe.mjs --port=5447 --out=<dir> [--themes=dark,light]
//        [--cases=home,friends,server,...] [--sizes=laptop,large,hidpi] [--scrolls=top,mid,bottom]
//        [--min=2] [--crops=1] [--css=<extra css>]
//
// Writes <out>/results.json (after every state) and, with --crops=1, the
// frame plus one amplified crop per corner: x8, contrast x16 around the page
// background just outside the corner (from B), so mid-grey = background.
// Summarise / compare runs: panel-corners-summary.mjs; owner sheet:
// panel-corners-sheet.mjs.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { PNG } = require(process.env.PNGJS ?? '/home/antigravity/Cipherline/node_modules/pngjs');

const PORT = arg('port', '5447');
const BASE = `http://127.0.0.1:${PORT}/harness/panel-corners.html`;
const out = arg('out', '/tmp/panel-corners');
const THEMES = arg('themes', 'dark').split(',').filter(Boolean);
const MIN = Number(arg('min', '2'));
const CROPS = arg('crops', '0') === '1';
const SIZES = {
    laptop: { width: 1366, height: 768, dsf: 1 },
    large: { width: 1920, height: 1080, dsf: 1 },
    hidpi: { width: 1280, height: 800, dsf: 1.5 },
};
const CASES = {
    home: 'view=home',
    friends: 'view=friends',
    server: 'view=server&p4=members',
    server_rw240: 'view=server&p4=members&rw=240',
    search: 'view=server&p4=search',
    pinned: 'view=server&p4=pinned',
    call: 'view=server&p4=call',
    call_rw240: 'view=server&p4=call&rw=240',
    dm: 'view=dm&p4=profile',
    settings: 'view=settings&tab=appearance',
};
const cases = arg('cases', Object.keys(CASES).join(',')).split(',').filter(Boolean);
const sizes = arg('sizes', 'laptop,large,hidpi').split(',').filter(Boolean);
const scrolls = arg('scrolls', 'top,mid,bottom').split(',').filter(Boolean);
fs.mkdirSync(out, { recursive: true });

/** Panels: the layout's cards by name, plus every rounded painted card inside
 *  Home / Friends / the right panel / settings (generic sweep). */
const collectPanels = () => {
    const named = [
        ['rail-deck', '.cl-rail-box'], ['list', '.app-pane2'], ['chat', '.app-pane3'], ['right', '.app-pane4'],
        ['solo', '.app-pane-solo'], ['settings', '.sd-root.sd-win'],
    ];
    const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
    const vis = (r) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
    const radii = (s) => ({
        TL: parseFloat(s.borderTopLeftRadius) || 0, TR: parseFloat(s.borderTopRightRadius) || 0,
        BL: parseFloat(s.borderBottomLeftRadius) || 0, BR: parseFloat(s.borderBottomRightRadius) || 0,
    });
    const out = [];
    const seen = new Set();
    const push = (name, el) => {
        if (seen.has(el)) return; seen.add(el);
        const r = el.getBoundingClientRect();
        if (!vis(r)) return;
        // clip the box to every clipping ancestor: corners scrolled out of view don't count
        let L = r.left, T = r.top, R = r.right, B = r.bottom;
        for (let a = el.parentElement; a; a = a.parentElement) {
            const as = getComputedStyle(a);
            if (as.overflowX !== 'visible' || as.overflowY !== 'visible') {
                const ar = a.getBoundingClientRect();
                L = Math.max(L, ar.left); T = Math.max(T, ar.top); R = Math.min(R, ar.right); B = Math.min(B, ar.bottom);
            }
        }
        L = Math.max(L, 0); T = Math.max(T, 0); R = Math.min(R, innerWidth); B = Math.min(B, innerHeight);
        const named = !name.startsWith('card:');
        el.setAttribute('data-pc-panel', String(out.length));
        const scope = named ? null : el.closest('.app-pane-solo, .app-pane4, .sd-root.sd-win, .app-pane2')?.getBoundingClientRect();
        out.push({ name, idx: out.length, named, box: [r.left, r.top, r.width, r.height], vis: [L, T, R, B], scope: scope ? [scope.left, scope.top, scope.right, scope.bottom] : null, radii: radii(getComputedStyle(el)) });
    };
    document.querySelectorAll('[data-pc-panel]').forEach((e) => e.removeAttribute('data-pc-panel'));
    // A square wrapper around a rounded sheet (.app-pane2 on origin/staging):
    // the card the eye sees is the sheet, so measure (and hide) that.
    const card = (el) => {
        const s = getComputedStyle(el);
        if (Math.max(...Object.values(radii(s))) >= 6) return el;
        const r = el.getBoundingClientRect();
        for (const c of el.children) {
            const cr = c.getBoundingClientRect();
            if (Math.abs(cr.width - r.width) < 3 && Math.abs(cr.height - r.height) < 3 && Math.max(...Object.values(radii(getComputedStyle(c)))) >= 6) return c;
        }
        return el;
    };
    named.forEach(([n, sel]) => document.querySelectorAll(sel).forEach((el, i) => push(document.querySelectorAll(sel).length > 1 ? `${n}${i + 1}` : n, card(el))));
    let k = 0;
    for (const scope of document.querySelectorAll('.app-pane-solo, .app-pane4, .sd-root.sd-win, .app-pane2')) {
        for (const el of scope.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            if (r.width < 90 || r.height < 36 || !vis(r)) continue;
            const rr = radii(s);
            if (Math.max(rr.TL, rr.TR, rr.BL, rr.BR) < 8) continue;
            if (Math.min(rr.TL, rr.TR, rr.BL, rr.BR) >= Math.min(r.width, r.height) / 2 - 1) continue; // a circle / pill end (avatars): no corner
            const paints = !transparent(s.backgroundColor) || s.backgroundImage !== 'none' || (s.borderTopWidth !== '0px' && !transparent(s.borderTopColor)) || s.boxShadow !== 'none';
            if (!paints) continue;
            if (k++ > 60) break;
            const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase();
            push(`card:${c || el.tagName.toLowerCase()}`, el);
        }
    }
    // the "water" the panes float on: a reference point outside it is window chrome (title bar)
    const mr = document.querySelector('.app-mainrow')?.getBoundingClientRect();
    for (const o of out) o.water = mr ? [mr.left, mr.top, mr.right, mr.bottom] : null;
    return out;
};

/** Named panels: compare A - B (B = the same frame with the panel hidden), so
 *  the backdrop (gradients, title bar edge) cancels and only what the panel
 *  itself paints in and around its corner is left. Cards: compare A directly,
 *  with references kept inside the card's own panel. */
function analyse(png, dpr, panels, hidden) {
    const W = png.width, H = png.height;
    const res = [];
    for (const p of panels) {
        const B = hidden.get(p.idx) ?? null;
        if (!B) continue;
        const d = png.data, e = B?.data;
        const px = B
            ? (x, y) => { const k = (y * W + x) * 4; return [d[k] - e[k], d[k + 1] - e[k + 1], d[k + 2] - e[k + 2]]; }
            : (x, y) => { const k = (y * W + x) * 4; return [d[k], d[k + 1], d[k + 2]]; };
        // references must lie on the water (.app-mainrow), not in the title bar above it
        const inScope = (cx, cy) => !p.water || (cx >= p.water[0] && cx < p.water[2] && cy >= p.water[1] && cy < p.water[3]);
        const at = (cx, cy) => { // CSS px -> device pixel value, or null off-image / outside the card's panel
            const x = Math.floor(cx * dpr), y = Math.floor(cy * dpr);
            return x < 0 || y < 0 || x >= W || y >= H || !inScope(cx, cy) ? null : px(x, y);
        };
        const [x0, y0, w, h] = p.box;
        const [VL, VT, VR, VB] = p.vis;
        for (const corner of ['TL', 'TR', 'BL', 'BR']) {
            const R = p.radii[corner];
            if (R < 6) continue;
            const sx = corner[1] === 'L' ? 1 : -1, sy = corner[0] === 'T' ? 1 : -1; // inward directions
            const cxe = corner[1] === 'L' ? x0 : x0 + w, cye = corner[0] === 'T' ? y0 : y0 + h; // corner point
            // the whole corner (gap + refs reach R+8 out) must be on screen and not scrolled away
            const reach = 8;
            const minX = Math.min(cxe, cxe + sx * R) - reach, maxX = Math.max(cxe, cxe + sx * R) + reach;
            const minY = Math.min(cye, cye + sy * R) - reach, maxY = Math.max(cye, cye + sy * R) + reach;
            if (Math.min(cxe, cxe + sx * R) < VL - 0.5 || Math.max(cxe, cxe + sx * R) > VR + 0.5 || Math.min(cye, cye + sy * R) < VT - 0.5 || Math.max(cye, cye + sy * R) > VB + 0.5) continue;
            if (minX < 0 || minY < 0 || maxX > W / dpr || maxY > H / dpr) { /* refs may be off-image; handled per ref */ }
            const ccx = cxe + sx * R, ccy = cye + sy * R; // curve centre
            let worst = 0, worstAt = null, n = 0;
            const step = 1 / dpr;
            for (let gx = 0; gx < R; gx += step) {
                for (let gy = 0; gy < R; gy += step) {
                    const X = cxe + sx * (gx + step / 2), Y = cye + sy * (gy + step / 2);
                    const dist = Math.hypot(X - ccx, Y - ccy) - R; // > 0: outside the curve
                    if (dist < 2.5) continue; // clear of anti-aliasing and the 1px border
                    const g = at(X, Y); if (!g) continue;
                    // same distance outside each straight edge, just past where the curve ends
                    const refs = [
                        at(cxe + sx * (R + 3), cye - sy * dist), // beyond the top/bottom edge
                        at(cxe - sx * dist, cye + sy * (R + 3)), // beyond the left/right edge
                    ].filter(Boolean);
                    if (!refs.length) continue;
                    n++;
                    for (const r of refs) {
                        // how much MORE the panel paints in its corner gap than just beyond its straight edge
                        const dlt = Math.max(...[0, 1, 2].map((c) => Math.abs(g[c]) - Math.abs(r[c])));
                        if (dlt > worst) { worst = dlt; worstAt = { x: +X.toFixed(1), y: +Y.toFixed(1), dist: +dist.toFixed(1), gap: g, ref: r }; }
                    }
                }
            }
            if (!n) continue;
            res.push({ panel: p.name, corner, radius: R, delta: worst, samples: n, worstAt, mode: B ? 'hide-diff' : 'edge-ref', box: p.box.map((v) => Math.round(v)) });
        }
    }
    return res;
}

/** x8 crop of one corner, contrast-stretched x16 around the reference colour. */
function crop(png, dpr, r, file, B) {
    const pad = 12, R = r.radius;
    const [x0, y0, w, h] = r.box;
    const cxe = r.corner[1] === 'L' ? x0 : x0 + w, cye = r.corner[0] === 'T' ? y0 : y0 + h;
    const sx = r.corner[1] === 'L' ? 1 : -1, sy = r.corner[0] === 'T' ? 1 : -1;
    const L = Math.min(cxe - sx * pad, cxe + sx * (R + 8)), T = Math.min(cye - sy * pad, cye + sy * (R + 8));
    const size = pad + R + 8;
    const X0 = Math.round(L * dpr), Y0 = Math.round(T * dpr), N = Math.round(size * dpr);
    const S = Math.max(2, Math.round(8 / dpr)); // same on-screen size whatever the dpr
    // stretch around the page background just outside the corner: from the
    // frame with the panel hidden (named panels), else from the frame itself
    const src = B ?? png;
    const rx = Math.min(src.width - 1, Math.max(0, Math.floor((cxe + sx * (R + 3)) * dpr)));
    const ry = Math.min(src.height - 1, Math.max(0, Math.floor((cye - sy * 4) * dpr)));
    const rk = (ry * src.width + rx) * 4;
    const ref = [src.data[rk], src.data[rk + 1], src.data[rk + 2]];
    const o = new PNG({ width: N * S, height: N * S });
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const sxp = Math.min(png.width - 1, Math.max(0, X0 + x)), syp = Math.min(png.height - 1, Math.max(0, Y0 + y));
        const k = (syp * png.width + sxp) * 4;
        const c = [0, 1, 2].map((i) => Math.max(0, Math.min(255, 128 + (png.data[k + i] - ref[i]) * 16)));
        for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
            const kk = (((y * S + yy) * N * S) + (x * S + xx)) * 4;
            o.data[kk] = c[0]; o.data[kk + 1] = c[1]; o.data[kk + 2] = c[2]; o.data[kk + 3] = 255;
        }
    }
    fs.writeFileSync(file, PNG.sync.write(o));
}

const all = [];
const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu', '--hide-scrollbars'] });
try {
    for (const theme of THEMES) for (const sz of sizes) for (const cs of cases) {
        const S = SIZES[sz];
        const ctx = await browser.newContext({ viewport: { width: S.width, height: S.height }, deviceScaleFactor: S.dsf, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => console.error(`  [pageerror ${cs}] ${String(e).slice(0, 160)}`));
        await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
        await page.goto(`${BASE}?theme=${theme}&${CASES[cs] ?? cs}`, { waitUntil: 'load', timeout: 180000 });
        await page.waitForFunction(() => window.__booted === true, null, { timeout: 60000 });
        await page.waitForTimeout(2000);
        // --css=...: extra CSS for experiments (e.g. a no-clip reference: the same shadow with room around it)
        if (arg('css', '')) { await page.addStyleTag({ content: arg('css', '') }); await page.waitForTimeout(300); }
        if (cs.startsWith('search')) {
            const inp = page.locator('input[placeholder="Search in channel"]').first();
            await inp.fill('ship').catch(() => console.error('  (no search input)'));
            await page.waitForTimeout(800);
        }
        for (const sc of scrolls) {
            await page.evaluate((sc) => {
                for (const el of document.querySelectorAll('*')) {
                    if (el.scrollHeight > el.clientHeight + 20 && /(auto|scroll|hidden)/.test(getComputedStyle(el).overflowY) && el !== document.documentElement) {
                        const max = el.scrollHeight - el.clientHeight;
                        el.scrollTop = sc === 'top' ? 0 : sc === 'mid' ? Math.round(max / 2) : max;
                    }
                }
            }, sc);
            await page.waitForTimeout(500);
            const panels = await page.evaluate(collectPanels);
            const buf = await page.screenshot();
            const png = PNG.sync.read(buf);
            const hidden = new Map();
            const res0 = [];
            for (const p of panels) {
                await page.evaluate((i) => { const st = document.createElement('style'); st.id = 'pc-hide'; st.textContent = `[data-pc-panel="${i}"]{visibility:hidden!important}`; document.head.appendChild(st); }, p.idx);
                await page.waitForTimeout(p.named ? 60 : 20);
                let B;
                if (p.named) B = PNG.sync.read(await page.screenshot());
                else {
                    // only the card's neighbourhood changes: paste a clip into a copy of A
                    const x = Math.max(0, Math.floor(p.box[0] - 12)), y = Math.max(0, Math.floor(p.box[1] - 12));
                    const w = Math.min(S.width - x, Math.ceil(p.box[2] + 24)), h = Math.min(S.height - y, Math.ceil(p.box[3] + 24));
                    B = new PNG({ width: png.width, height: png.height }); png.data.copy(B.data);
                    if (w > 0 && h > 0) {
                        const c = PNG.sync.read(await page.screenshot({ clip: { x, y, width: w, height: h } }));
                        const ox = Math.round(x * S.dsf), oy = Math.round(y * S.dsf);
                        for (let yy = 0; yy < c.height && oy + yy < B.height; yy++) c.data.copy(B.data, ((oy + yy) * B.width + ox) * 4, yy * c.width * 4, (yy * c.width + Math.min(c.width, B.width - ox)) * 4);
                    }
                }
                await page.evaluate(() => document.getElementById('pc-hide')?.remove());
                hidden.clear(); hidden.set(p.idx, B);
                res0.push(...analyse(png, S.dsf, [p], hidden));
                if (CROPS && (p.named || res0.some((r) => r.panel === p.name && r.delta >= MIN))) {
                    const dir = path.join(out, 'crops', `${theme}-${sz}-${cs}-${sc}`);
                    fs.mkdirSync(dir, { recursive: true });
                    for (const r of res0.filter((r) => r.panel === p.name)) crop(png, S.dsf, r, path.join(dir, `${r.panel.replace(/[^a-z0-9-]+/gi, '_')}-${r.corner}.png`), B);
                }
            }
            hidden.clear();
            await page.waitForTimeout(60);
            const res = res0.map((r) => ({ theme, size: sz, case: cs, scroll: sc, ...r }));
            const bad = res.filter((r) => r.delta >= MIN);
            console.log(`== ${theme} ${sz} ${cs} ${sc}: ${res.length} corners, ${bad.length} >= ${MIN}`);
            for (const b of bad) console.log(`   ${b.panel} ${b.corner} r${b.radius} delta ${b.delta} @${JSON.stringify(b.worstAt)}`);
            if (CROPS) {
                const dir = path.join(out, 'crops', `${theme}-${sz}-${cs}-${sc}`);
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'full.png'), buf);
            }
            all.push(...res);
            fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(all, null, 1)); // partial runs stay usable
        }
        await ctx.close();
    }
} finally {
    await browser.close();
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(all, null, 1));
const bad = all.filter((r) => r.delta >= MIN);
console.log(`TOTAL corners ${all.length}, >= ${MIN}: ${bad.length}`);
