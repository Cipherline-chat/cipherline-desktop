// Same-page A/B of the panel-corners fix: one loaded page, one frame with the
// fix, one with it reverted by an injected style (the clip boxes back to plain
// overflow:hidden), nothing else moving in between. Reports where pixels
// changed: inside a pane's box (should be nothing) or outside every pane (the
// water around the cards, where a pane's shadow now fades out instead of
// being cut at the pane's edge).
//   node harness/panel-corners-ab.mjs --port=5447 [--themes=dark,light] [--sizes=laptop,large,hidpi] [--img=<dir>]
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { PNG } = require(process.env.PNGJS ?? '/home/antigravity/Cipherline/node_modules/pngjs');
const BASE = `http://127.0.0.1:${arg('port', '5447')}/harness/panel-corners.html`;
const THEMES = arg('themes', 'dark,light').split(',');
const SIZES = { laptop: [1366, 768, 1], large: [1920, 1080, 1], hidpi: [1280, 800, 1.5] };
const sizes = arg('sizes', 'laptop,large,hidpi').split(',');
const imgDir = arg('img', '');
const CASES = { home: 'view=home', friends: 'view=friends', server: 'view=server&p4=members', pinned: 'view=server&p4=pinned', call: 'view=server&p4=call&rw=240', dm: 'view=dm&p4=profile', settings: 'view=settings' };
const REVERT = ['app-contentcol', 'app-contentrow', 'app-callgroup', 'app-pane3-col', 'app-pane3-row']
    .map((c) => `[data-layout="drift"] .${c}`).join(',') + '{overflow:hidden!important}';
let tot = { inN: 0, inMax: 0, outN: 0, outMax: 0 };
const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu', '--hide-scrollbars'] });
try {
    for (const theme of THEMES) for (const sz of sizes) for (const [cs, q] of Object.entries(CASES)) {
        const [w, h, dsf] = SIZES[sz];
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
        await page.goto(`${BASE}?theme=${theme}&${q}`, { waitUntil: 'load', timeout: 180000 });
        await page.waitForFunction(() => window.__booted === true, null, { timeout: 60000 });
        await page.waitForTimeout(2500);
        const boxes = await page.evaluate(() => [...document.querySelectorAll('.app-pane2,.app-pane3,.app-pane4,.app-pane-solo,.cl-rail-box,.sd-root')].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
        const fixed = PNG.sync.read(await page.screenshot());
        await page.addStyleTag({ content: REVERT });
        await page.waitForTimeout(300);
        const reverted = PNG.sync.read(await page.screenshot());
        let inN = 0, inMax = 0, outN = 0, outMax = 0;
        const o = imgDir ? new PNG({ width: fixed.width, height: fixed.height }) : null;
        for (let y = 0; y < fixed.height; y++) for (let x = 0; x < fixed.width; x++) {
            const i = (y * fixed.width + x) * 4;
            const d = Math.max(...[0, 1, 2].map((c) => Math.abs(fixed.data[i + c] - reverted.data[i + c])));
            if (o) { const v = Math.min(255, d * 32); o.data[i] = v; o.data[i + 1] = v; o.data[i + 2] = v; o.data[i + 3] = 255; }
            if (!d) continue;
            const cx = x / dsf, cy = y / dsf;
            if (boxes.some(([l, t, r, b]) => cx >= l && cx < r && cy >= t && cy < b)) { inN++; inMax = Math.max(inMax, d); } else { outN++; outMax = Math.max(outMax, d); }
        }
        if (o) fs.writeFileSync(path.join(imgDir, `ab-${theme}-${sz}-${cs}.png`), PNG.sync.write(o));
        tot = { inN: tot.inN + inN, inMax: Math.max(tot.inMax, inMax), outN: tot.outN + outN, outMax: Math.max(tot.outMax, outMax) };
        console.log(`${theme} ${sz} ${cs}`.padEnd(26) + `inside panes ${inN} px (max ${inMax})   outside ${outN} px (max ${outMax})`);
        await ctx.close();
    }
} finally { await browser.close(); }
console.log(`TOTAL inside panes ${tot.inN} px (max ${tot.inMax}), outside ${tot.outN} px (max ${tot.outMax})`);
