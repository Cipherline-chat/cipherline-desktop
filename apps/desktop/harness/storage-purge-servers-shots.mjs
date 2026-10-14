// Storage -> "Server storage": screenshots + behaviour checks in real Chromium.
//
//   npx vite --config harness/storage-purge-servers.vite.config.ts        (serves :5298)
//   node harness/storage-purge-servers-shots.mjs                          (env: OUT=<dir> CDP=http://127.0.0.1:9510)
//
// With CDP set it reuses an already-running headless Chromium (opens and closes ONE tab of
// its own); otherwise it launches one. Never leaves a page open.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5298/harness/storage-purge-servers.html';
const OUT = process.env.OUT ?? '/tmp/storage-purge-servers';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = process.env.CDP
    ? await chromium.connectOverCDP(process.env.CDP)
    : await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
let page;
try {
    const ctx = process.env.CDP ? (browser.contexts()[0] ?? await browser.newContext()) : await browser.newContext();
    page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1100, deviceScaleFactor: 2, mobile: false });
    page.setDefaultTimeout(300000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });

    const open = async (state) => {
        await page.goto(`${BASE}${state ? `?state=${state}` : ''}`);
        await page.waitForSelector('[data-testid="server-storage"]');
        await sleep(1200); // card entrance
    };
    const section = () => page.locator('[data-testid="server-storage"]');
    const rect = (loc) => loc.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const shot = async (name, loc = section(), pad = 16, extra = []) => {
        await loc.scrollIntoViewIfNeeded();
        await sleep(150);
        const rs = [await rect(loc), ...extra];
        const x = Math.max(0, Math.min(...rs.map(r => r.x)) - pad), y = Math.max(0, Math.min(...rs.map(r => r.y)) - pad);
        const x2 = Math.max(...rs.map(r => r.x + r.w)) + pad, y2 = Math.max(...rs.map(r => r.y + r.h)) + pad;
        await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x, y, width: x2 - x, height: y2 - y } });
        console.log(`SHOT  ${OUT}/${name}.png`);
    };

    // 1. default state: DM list above, Server storage below
    await open();
    const headings = await page.locator('h3').allTextContents();
    check('Server storage sits right after Conversation storage',
        headings.indexOf('Server storage') === headings.indexOf('Conversation storage') + 1, JSON.stringify(headings));
    const rows = section().locator('.space-y-2');
    check('one row per server + Left row', (await rows.count()) === 6, `rows=${await rows.count()}`);
    const rowText = await rows.allTextContents();
    check('Left server is labelled and lists its channel', rowText.some(t => t.includes('Left server') && t.includes('Left') && t.includes('#lobby')));
    check('server with nothing cached has purge disabled',
        await rows.filter({ hasText: 'Quiet Corner' }).locator('button.purge-trigger').isDisabled());
    const dmTrig = await page.locator('.sd-card', { has: page.locator('h3', { hasText: 'Conversation storage' }) }).locator('button.purge-trigger').first()
        .evaluate(el => { const cs = getComputedStyle(el); return [cs.fontSize, cs.borderRadius, cs.paddingTop, el.textContent].join('|'); });
    const svTrig = await rows.first().locator('button.purge-trigger')
        .evaluate(el => { const cs = getComputedStyle(el); return [cs.fontSize, cs.borderRadius, cs.paddingTop, el.textContent].join('|'); });
    check('server purge trigger is styled identically to the DM one', dmTrig === svTrig, `${dmTrig} vs ${svTrig}`);
    await shot('storage-purge-servers', section(), 18);

    // 2. dropdown open on the biggest server
    await rows.first().locator('button.purge-trigger').click();
    await page.waitForSelector('[role="menu"]');
    await sleep(500);
    await page.locator('[role="menuitem"]', { hasText: '1 month' }).hover();
    await sleep(200);
    const menu = await rect(page.locator('[role="menu"]'));
    // Neon Guild caches 2600 + 380 + 900 = 3880 rows; 6 of them are pinned/saved and must not be counted.
    const everyHint = (await page.locator('[role="menuitem"]', { hasText: 'Everything' }).locator('.ctxm-acc').innerText()).replace(/\D/g, '');
    check('menu count for Everything excludes the 6 pinned/saved messages', everyHint === '3874', `hint=${everyHint}`);
    await shot('storage-purge-servers-menu', section(), 18, [menu]);

    // 3. confirm dialog
    await page.locator('[role="menuitem"]', { hasText: 'Everything' }).click();
    await page.waitForSelector('[role="dialog"]');
    await sleep(500);
    const dlg = await page.locator('[role="dialog"]').innerText();
    check('confirm names the server and the server-accurate warning', dlg.includes('Neon Guild') && dlg.includes('other members') && dlg.includes('Pinned and saved messages are kept'), dlg.replace(/\n/g, ' | '));
    await page.screenshot({ path: `${OUT}/storage-purge-servers-confirm.png`, clip: { x: 0, y: 0, width: 900, height: 1100 } });
    console.log(`SHOT  ${OUT}/storage-purge-servers-confirm.png`);
    await page.getByRole('button', { name: /^Delete / }).click();
    await sleep(500);
    const purged = await page.evaluate(() => window.__purged);
    check('confirm purges exactly Neon Guild\'s three channels, everything', JSON.stringify(purged) === JSON.stringify({ ids: ['n1', 'n2', 'n3'], ms: 0 }), JSON.stringify(purged));
    check('inline result shown', (await rows.first().locator('[role="status"]').innerText()).includes('Removed 3 messages'));

    // 3b. a server whose channel list hasn't loaded: no size, purge disabled, no Left/Other rows yet
    await open('pending');
    const prow = section().locator('.space-y-2').filter({ hasText: 'Just Joined' });
    check('pending channel list shows Loading… and a disabled purge',
        (await prow.innerText()).includes('Loading…') && await prow.locator('button.purge-trigger').isDisabled());
    check('Left/Other rows are withheld while a channel list is pending', !(await section().innerText()).includes('Left server'));
    await shot('storage-purge-servers-pending', section(), 16);

    // 4. empty / loading / error
    for (const st of ['empty', 'loading', 'error']) {
        await open(st);
        const t = await section().innerText();
        const ok = st === 'empty' ? t.includes('You aren’t in any servers.') : st === 'loading' ? t.includes('Loading your servers…') : t.includes('Couldn’t load your servers');
        check(`${st} state`, ok);
        await shot(`storage-purge-servers-${st}`, section(), 16);
    }
} finally {
    try { await page?.close(); } catch {}
    if (!process.env.CDP) await browser.close(); else await browser.close().catch(() => {}); // disconnects only
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
