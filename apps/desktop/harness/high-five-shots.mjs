// Screenshots of the REAL HighFiveOverlay over the window-sizes dashboard, at the four window sizes,
// plus a measurement of its placement and inner padding.
//   WS_PORT=5447 npx vite --config harness/window-sizes.vite.config.ts
//   OUT=<dir> TAG=before|after node harness/high-five-shots.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5447/harness/window-sizes.html';
const OUT = process.env.OUT ?? '/tmp/high-five-shots';
const TAG = process.env.TAG ?? 'shot';
const THEME = process.env.THEME ?? '';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sizes = [['1000x720', 1000, 720, 1], ['1366x768', 1366, 768, 1], ['1920x1080', 1920, 1080, 1], ['1280x800@1.5', 1280, 800, 1.5]];
let failures = 0;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const [name, w, h, dsf] of sizes) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
        const page = await ctx.newPage();
        page.on('pageerror', e => { failures++; console.log('FAIL pageerror ' + e.message); });
        await page.goto(`${BASE}?scene=highfive${THEME ? `&theme=${THEME}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
        await page.waitForSelector('[data-testid="high-five-overlay"]', { timeout: 20000 });
        for (const [label, at] of [['a', 650], ['b', 1500]]) {
            if (label === 'a') await sleep(at); else await sleep(at - 650);
            const m = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="high-five-overlay"]');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const kids = [...el.children].map(c => c.getBoundingClientRect());
                const left = Math.min(...kids.map(k => k.left)) - r.left;
                const right = r.right - Math.max(...kids.map(k => k.right));
                const top = Math.min(...kids.map(k => k.top)) - r.top;
                const bottom = r.bottom - Math.max(...kids.map(k => k.bottom));
                return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight,
                    marginL: r.left, marginR: innerWidth - r.right, padL: left, padR: right, padT: top, padB: bottom };
            });
            if (m) console.log(`${name} ${label}: box ${m.w.toFixed(0)}x${m.h.toFixed(0)} at (${m.x.toFixed(0)},${m.y.toFixed(0)}); window margins L ${m.marginL.toFixed(1)} R ${m.marginR.toFixed(1)}; inner pad L ${m.padL.toFixed(1)} R ${m.padR.toFixed(1)} T ${m.padT.toFixed(1)} B ${m.padB.toFixed(1)}`);
            await page.screenshot({ path: `${OUT}/${TAG}-${name}-${label}.png` });
        }
        await ctx.close();
    }
} finally { await browser.close(); }
process.exit(failures ? 1 : 0);
