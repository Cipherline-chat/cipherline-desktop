// The cover check for FirewallOverlay's coverRef, at the owner's four window sizes: open the
// real game over the real Home (firewall-hitch-home.html?cover=1&closed=1), and confirm
//   - the fade-in still shows Home through it (no cover before FW_COVER_AFTER_MS),
//   - once opaque the column is covered (data-fw-covered) and the overlay looks the same,
//   - on close the column renders again at once, the focused input gets focus back and the
//     scrolled Home keeps its scroll position.
// Screenshots go to $OUT (default ./fw-cover-shots). Server: see firewall-hitch.mjs.
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5246/harness/firewall-hitch-home.html';
const OUT = process.env.OUT ?? 'fw-cover-shots';
fs.mkdirSync(OUT, { recursive: true });
const SIZES = [[1000, 720, 1], [1366, 768, 1], [1920, 1080, 1], [1280, 800, 1.5]];
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let fail = 0;
try {
    for (const [w, h, dpr] of SIZES) {
        const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr })).newPage();
        page.on('pageerror', e => console.log('pageerror', e.message));
        await page.goto(`${BASE}?cover=1&closed=1`, { timeout: 180000 });
        await page.waitForSelector('#composer');
        await page.waitForTimeout(1500);
        await page.evaluate(() => { document.querySelector('.hd-host').scrollTop = 120; document.getElementById('composer').focus(); });
        const before = await page.evaluate(() => ({ scroll: document.querySelector('.hd-host').scrollTop, focus: document.activeElement?.id }));
        const tag = `${w}x${h}${dpr !== 1 ? `@${dpr}` : ''}`;
        await page.evaluate(() => window.__open(true));
        await page.waitForTimeout(80);
        const during = await page.evaluate(() => document.querySelector('[data-banner-column]').hasAttribute('data-fw-covered'));
        await page.screenshot({ path: `${OUT}/${tag}-fading.png` });
        await page.waitForTimeout(900);
        const covered = await page.evaluate(() => ({
            covered: document.querySelector('[data-banner-column]').hasAttribute('data-fw-covered'),
            cv: getComputedStyle(document.querySelector('[data-banner-column]')).contentVisibility,
            overlay: (() => { const r = document.querySelector('.fw-root').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); })(),
            column: (() => { const r = document.querySelector('[data-banner-column]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); })(),
        }));
        await page.screenshot({ path: `${OUT}/${tag}-open.png` });
        await page.evaluate(() => window.__open(false));
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
        const after = await page.evaluate(() => ({
            covered: document.querySelector('[data-banner-column]').hasAttribute('data-fw-covered'),
            scroll: document.querySelector('.hd-host').scrollTop, focus: document.activeElement?.id,
        }));
        await page.screenshot({ path: `${OUT}/${tag}-closed.png` });
        const ok = !during && covered.covered && covered.cv === 'hidden' && covered.overlay === covered.column
            && !after.covered && after.scroll === before.scroll && after.focus === 'composer';
        if (!ok) fail++;
        console.log(JSON.stringify({ size: tag, ok, coveredWhileFading: during, ...covered, before, after }));
        await page.context().close();
    }
} finally {
    await browser.close();
}
process.exit(fail ? 1 : 0);
