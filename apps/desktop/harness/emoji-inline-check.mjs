// Inline emoji vs clipping ancestors, in headless Chromium, at the four window sizes the
// owner's rule names (1000x720, 1366x768, 1920x1080, 1280x800@1.5), with Noto Color Emoji
// and with a taller stand-in for Windows' Segoe UI Emoji (?tall=1).
//
//   npx vite --config harness/emoji-inline.vite.config.ts      (serves :5361)
//   node harness/emoji-inline-check.mjs                       (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=... JSON=<file>)
//
// For every emoji in every probe row it finds the emoji's INK top (native glyph: canvas
// actualBoundingBoxAscent above the glyph's own baseline; custom emoji: the image box) and
// every ancestor that clips in y (overflow other than visible/clip-x-only, contain: paint,
// a mask), and reports how many px of the ink sit above the clip edge. PASS = 0 everywhere;
// the positive control (?oldbody=1: the body class before the fix) must FAIL.
// One browser for the whole run, closed at the end (CLAUDE.md "Headless Chrome cleanup").
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5361/harness/emoji-inline.html';
const OUT = process.env.OUT ?? '/tmp/emoji-inline-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Chat-column widths Dashboard gives these windows at its default pane ratios (window-sizes harness).
const SIZES = [
    { id: '1000x720', vw: 1000, vh: 720, dpr: 1, col: 416 },
    { id: '1366x768', vw: 1366, vh: 768, dpr: 1, col: 700 },
    { id: '1920x1080', vw: 1920, vh: 1080, dpr: 1, col: 1100 },
    { id: '1280x800@1.5', vw: 1280, vh: 800, dpr: 1.5, col: 640 },
];
const ONLY = process.env.SIZES ? process.env.SIZES.split(',') : null;

/** In-page: every emoji's ink top vs every y-clipping ancestor. */
const measure = () => {
    const EMOJI = /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}️?\p{Emoji_Modifier}?(?:‍\p{Extended_Pictographic}️?\p{Emoji_Modifier}?)*)/gu;
    const ctx = document.createElement('canvas').getContext('2d');
    const clipsY = (cs) => cs.overflowY !== 'visible'
        ||/paint|strict|content/.test(cs.contain) || (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none');
    const clipTopOf = (el) => {
        let best = null;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (!clipsY(cs)) continue;
            const r = a.getBoundingClientRect();
            const masked = (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none');
            // overflow / paint containment clip at the padding box; a mask at the border box.
            const top = masked && cs.overflowY === 'visible' ? r.top : r.top + parseFloat(cs.borderTopWidth);
            if (!best || top > best.top) best = { top, who: (a.className && typeof a.className === 'string' ? a.className.split(' ').filter(c => /overflow|lm-|cl-msg|rc-|truncate|cl-fmt|cl-composer/.test(c)).join('.') : '') || a.tagName.toLowerCase() };
        }
        return best;
    };
    // The glyph baseline relative to the text fragment's top, per computed font: a scratch
    // copy with a zero-size inline-block marker (its bottom sits on the baseline).
    const offsetCache = new Map();
    const baselineOffset = (cs, ch) => {
        const key = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontSize}|${cs.fontFamily}|${cs.lineHeight}`;
        if (offsetCache.has(key)) return offsetCache.get(key);
        const s = document.createElement('div');
        s.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font-style:${cs.fontStyle};font-weight:${cs.fontWeight};font-size:${cs.fontSize};font-family:${cs.fontFamily};line-height:${cs.lineHeight}`;
        const t = document.createTextNode(ch);
        const mk = document.createElement('i');
        mk.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        s.append(t, mk);
        document.body.append(s);
        const range = document.createRange(); range.selectNodeContents(t);
        const off = mk.getBoundingClientRect().bottom - range.getBoundingClientRect().top;
        s.remove();
        offsetCache.set(key, off);
        return off;
    };
    const out = [];
    for (const probe of document.querySelectorAll('[data-probe]')) {
        const id = probe.dataset.probe;
        const body = probe.querySelector('[data-body]') ?? probe.querySelector('.rc-root');
        const items = [];
        // Native glyphs.
        const walker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const el = n.parentElement;
            if (el.closest('[data-testid="reply-quote"]') && !el.closest('[data-testid="reply-quote"] .truncate')) continue;
            for (const m of n.data.matchAll(EMOJI)) {
                const range = document.createRange();
                range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
                const rr = range.getClientRects()[0];
                if (!rr) continue;
                const cs = getComputedStyle(el);
                ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
                const tm = ctx.measureText(m[0]);
                const baseline = rr.top + baselineOffset(cs, m[0]);
                const inkTop = baseline - tm.actualBoundingBoxAscent;
                // From the glyph's own element up (the emoji span itself could clip too).
                const cl = clipTopOf({ parentElement: el });
                items.push({ kind: 'native', ch: m[0], fontPx: parseFloat(cs.fontSize), inkTop: +inkTop.toFixed(2), clipTop: cl ? +cl.top.toFixed(2) : null, by: cl?.who ?? null, clipPx: cl ? +Math.max(0, cl.top - inkTop).toFixed(2) : 0 });
            }
        }
        // Custom / personal emoji boxes (image, loading placeholder, unavailable glyph): ChatPane sizes them 1.375em.
        for (const el of probe.querySelectorAll('img, [role="img"], .animate-pulse')) {
            if (!/1\.375em|1em/.test(el.getAttribute('style') ?? '')) continue;
            const r = el.getBoundingClientRect();
            const cl = clipTopOf(el);
            items.push({ kind: 'custom', ch: el.getAttribute('aria-label') ?? el.getAttribute('alt') ?? 'placeholder', inkTop: +r.top.toFixed(2), clipTop: cl ? +cl.top.toFixed(2) : null, by: cl?.who ?? null, clipPx: cl ? +Math.max(0, cl.top - r.top).toFixed(2) : 0 });
        }
        const br = body?.getBoundingClientRect();
        out.push({ id, bodyH: br ? +br.height.toFixed(2) : null, bodyTop: br ? +(br.top - probe.getBoundingClientRect().top).toFixed(2) : null, items });
    }
    return out;
};

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = {};
let failures = 0;
try {
    const variants = [
        { id: 'noto', qs: '' },
        { id: 'tall', qs: '&tall=1' },
        { id: 'control-oldbody', qs: '&oldbody=1', control: true },
        { id: 'control-oldbody-tall', qs: '&oldbody=1&tall=1', control: true },
    ];
    for (const sz of SIZES.filter(s => !ONLY || ONLY.includes(s.id))) {
        const ctx = await browser.newContext({ viewport: { width: sz.vw, height: sz.vh }, deviceScaleFactor: sz.dpr });
        const page = await ctx.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
        for (const v of variants) {
            await page.goto(`${BASE}?w=${sz.col}${v.qs}`);
            await page.waitForSelector('[data-probe="composer-card"] .rc-root');
            await page.evaluate(() => document.fonts.ready);
            await sleep(400);
            const rows = await page.evaluate(measure);
            results[`${sz.id}/${v.id}`] = rows;
            // The message body and the long-message clip must never cut an emoji. With the taller
            // stand-in glyph a few px can still reach past clips that are NOT the body's: a styled
            // card's containment (its padding box, >= 4px of headroom: tight padding), the reply
            // quote's one-line preview and the composer's scroll box. Those are reported, not failed.
            const RESIDUAL = /cl-msg-card|truncate|rc-root/;
            const all = rows.flatMap(r => r.items.filter(i => i.clipPx > 0.5).map(i => ({ ...i, row: r.id })));
            const fmt = (l) => l.map(i => `${i.row}:${i.ch}:${i.clipPx}px(${i.by})`).join('  ');
            const body = all.filter(i => !RESIDUAL.test(i.by ?? ''));
            const residual = all.filter(i => RESIDUAL.test(i.by ?? ''));
            const n = rows.reduce((a, r) => a + r.items.length, 0);
            const ok = v.control ? body.length > 0 : (v.id === 'noto' ? all.length === 0 : body.length === 0);
            if (!ok) failures++;
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${sz.id} ${v.id}: ${n} emoji, ${body.length} clipped by the body / long-message clip${v.control ? ' (control: must be > 0)' : ''}${body.length ? '  ' + fmt(body.slice(0, 40)) : ''}`);
            if (residual.length) console.log(`INFO  ${sz.id} ${v.id}: outside the body: ${fmt(residual)}`);
            const path = `${OUT}/${sz.id.replace('@', '_')}-${v.id}.png`;
            // The app shell's body does not scroll: grow the viewport to the feed for the picture only
            // (the feed's width is fixed by ?w=, so nothing measured above changes), then restore it.
            const feedH = await page.$eval('#feed', el => Math.ceil(el.getBoundingClientRect().bottom));
            await page.setViewportSize({ width: sz.vw, height: Math.max(sz.vh, feedH) });
            await sleep(150);
            await page.screenshot({ path, clip: { x: 0, y: 0, width: Math.min(sz.vw, sz.col + 40), height: feedH } });
            await page.setViewportSize({ width: sz.vw, height: sz.vh });
            console.log(`SHOT  ${path}`);
        }
        await ctx.close();
    }
    if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify(results, null, 1));
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
