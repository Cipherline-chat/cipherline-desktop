// Settings polish: Storage DM/group avatars screenshot + nav hover latency, in real Chromium.
//
//   npx vite --config harness/settings-polish.vite.config.ts        (serves :5299)
//   node harness/settings-polish-shots.mjs                          (env: OUT=<dir> CDP=http://127.0.0.1:9510)
//
// Nav hover: pointer moves onto an item; in-page rAF loop records how long until the computed
// background reaches half its hover colour. Run for the fixed CSS and for ?old=1 (the pre-fix
// inline transition-delay + 200ms colour transition) as the negative control.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5299/harness/settings-polish.html';
const OUT = process.env.OUT ?? '/tmp/settings-polish';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = process.env.CDP
    ? await chromium.connectOverCDP(process.env.CDP)
    : await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let page;
try {
    const ctx = process.env.CDP ? (browser.contexts()[0] ?? await browser.newContext()) : await browser.newContext({ viewport: { width: 900, height: 2300 }, deviceScaleFactor: 2 });
    page = await ctx.newPage();
    if (process.env.CDP) {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 2300, deviceScaleFactor: 2, mobile: false });
    }
    page.setDefaultTimeout(300000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });

    // ---- 1. Storage avatars -------------------------------------------------
    await page.goto(`${BASE}?view=storage`);
    await page.waitForSelector('text=Conversation storage');
    await sleep(1500);
    const card = page.locator('.sd-card', { has: page.locator('h3', { hasText: 'Conversation storage' }) });
    await card.scrollIntoViewIfNeeded();
    const rows = await card.evaluate(el => [...el.querySelectorAll('.truncate.font-medium, span.text-sm')].map(s => {
        const row = s.closest('.rounded-xl');
        const lead = row?.querySelector('img, svg.lucide-user, svg.lucide-users, svg.lucide-archive');
        return { title: s.textContent, img: row?.querySelectorAll('img').length ?? 0, lead: lead?.tagName + '.' + (lead?.getAttribute('class') ?? '') };
    }));
    console.log(JSON.stringify(rows));
    const imgTitles = rows.filter(r => r.img > 0).map(r => r.title);
    check('DM with a picture (Mira) renders an <img>', imgTitles.includes('Mira'));
    check('group with a picture (Weekend crew) renders an <img>', imgTitles.includes('Weekend crew'));
    check('notes-to-self renders like a DM (<img>)', imgTitles.includes('Notes to self'));
    check('DM without a picture (Jonas) falls back to the silhouette', rows.find(r => r.title === 'Jonas')?.lead.includes('lucide-user'));
    check('group without a picture (Book club) falls back to the group icon', rows.find(r => r.title === 'Book club')?.lead.includes('lucide-users'));
    check('deleted chat shows the archive placeholder', rows.find(r => r.title === 'Unknown Chat')?.lead.includes('lucide-archive'));
    await page.locator('#pane').screenshot({ path: `${OUT}/storage-dm-avatars.png` });
    console.log(`SHOT  ${OUT}/storage-dm-avatars.png`);

    // ---- 2. Nav hover latency ----------------------------------------------
    async function hoverMs(query) {
        await page.goto(`${BASE}?view=nav${query}`);
        await page.waitForSelector('.sd-nitem');
        await sleep(2200); // entrance stagger fully settled
        const target = page.locator('.sd-nitem', { hasText: 'Privacy & Safety' });   // a late item: longest stagger
        const b = await target.boundingBox();
        await page.mouse.move(2, 2);
        await sleep(300);
        await page.evaluate(() => {
            const el = [...document.querySelectorAll('.sd-nitem')].find(e => e.textContent.includes('Privacy & Safety'));
            const alpha = () => { const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g); return m && m.length > 3 ? parseFloat(m[3]) : (m && m.length === 3 ? 1 : 0); };
            window.__t = { start: null, half: null, done: null };
            window.__alpha0 = alpha();
            document.addEventListener('mouseover', () => {
                if (window.__t.start !== null) return;
                window.__t.start = performance.now();
                const tick = () => {
                    const a = alpha(), t = performance.now() - window.__t.start;
                    if (window.__t.half === null && a >= 0.03) window.__t.half = t;
                    if (a >= 0.0595) { window.__t.done = t; return; }
                    if (t < 3000) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }, { once: true });
        });
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await sleep(1500);
        return page.evaluate(() => window.__t);
    }
    const fixed = await hoverMs('');
    console.log('fixed', JSON.stringify(fixed));
    const old = await hoverMs('&old=1');
    console.log('old  ', JSON.stringify(old));
    check('fixed: highlight half-visible within 80 ms of pointer-enter', fixed.half !== null && fixed.half <= 80, `half=${fixed.half?.toFixed(0)}ms done=${fixed.done?.toFixed(0)}ms`);
    check('negative control (pre-fix CSS) is slow (> 300 ms)', old.half === null || old.half > 300, `half=${old.half?.toFixed(0)}ms`);
} finally {
    await page?.close().catch(() => {});
    if (!process.env.CDP) await browser.close().catch(() => {});
    else await browser.close().catch(() => {});
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
