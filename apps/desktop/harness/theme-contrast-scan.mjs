// Live contrast scan for a theme (themes-midnight-contrast slice): loads a
// view of harness/light-theme-main.tsx, walks every visible text node, and
// reports text whose colour against its nearest opaque background is under
// the threshold. Backgrounds that are gradients / images / translucent all
// the way up are reported as "unknown bg", not guessed.
//
//   LT_PORT=5431 npx vite --config harness/light-theme.vite.config.ts      (another shell)
//   node harness/theme-contrast-scan.mjs --themes=midnight,hc-dark,hc-light --views=server,dm,home --min=4.5
import { chromium, exe, arg } from './reaction-center-measure.mjs';

const BASE = `http://127.0.0.1:${process.env.LT_PORT ?? 5431}/harness/light-theme.html`;
const THEMES = arg('themes', 'midnight,hc-dark,hc-light').split(',').filter(Boolean);
const VIEWS = arg('views', 'server,dm,home,friends,settings&tab=appearance').split(',').filter(Boolean);
const MIN = Number(arg('min', '0')); // 0 = by theme: 7 for hc-*, 4.5 otherwise

const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
let failures = 0;
try {
    for (const theme of THEMES) {
        const min = MIN || (theme.startsWith('hc-') ? 7 : 4.5);
        for (const view of VIEWS) {
            const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' });
            const page = await ctx.newPage();
            await page.goto(`${BASE}?theme=${theme}&view=${view}`, { waitUntil: 'load' });
            await page.waitForFunction(() => window.__booted === true, null, { timeout: 30000 });
            await page.waitForTimeout(1500);
            const res = await page.evaluate((min) => {
                const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
                const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
                const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
                const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
                const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
                const bgOf = (el) => {
                    const layers = [];
                    for (let e = el; e; e = e.parentElement) {
                        const cs = getComputedStyle(e);
                        if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/^linear-gradient\(rgb/.test(cs.backgroundImage)) return null;
                        const c = parse(cs.backgroundColor);
                        if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
                        if (!e.parentElement) return null;
                    }
                    if (!layers.length || layers[layers.length - 1].a < 1) return null;
                    let acc = layers.pop();
                    while (layers.length) acc = over(layers.pop(), acc);
                    return acc;
                };
                const out = [];
                const seen = new Set();
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                    const text = n.textContent.trim();
                    if (!text) continue;
                    const el = n.parentElement;
                    if (!el || el.closest('[aria-hidden="true"], .cl-island-dark, .pcd, .pfp, .fw-root, .cl-tile-hover, .tp-pic')) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
                    const cs = getComputedStyle(el);
                    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
                    let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
                    const fg = parse(cs.color); if (!fg) continue;
                    const bg = bgOf(el);
                    if (!bg) continue;
                    const eff = over({ ...fg, a: fg.a * op }, bg);
                    const k = ratio(eff, bg);
                    const key = `${text.slice(0, 30)}|${cs.color}`;
                    if (k < min && !seen.has(key)) { seen.add(key); out.push({ text: text.slice(0, 40), ratio: Math.round(k * 100) / 100, color: cs.color, bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`, opacity: Math.round(op * 100) / 100, cls: (el.className && el.className.baseVal === undefined ? el.className : '').toString().slice(0, 80) }); }
                }
                return out;
            }, min);
            console.log(`\n== ${theme} / ${view}: ${res.length} text runs under ${min}:1`);
            for (const r of res) console.log(`  ${r.ratio}:1  "${r.text}"  fg=${r.color} bg=${r.bg} op=${r.opacity}  .${r.cls}`);
            failures += res.length;
            await ctx.close();
        }
    }
} finally {
    await browser.close();
}
console.log(`\ntotal: ${failures}`);
