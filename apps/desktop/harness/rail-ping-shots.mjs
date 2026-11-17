// Rail off-screen ping arrows: screenshots + live checks (real Chromium).
// Needs the harness server:
//   npx vite --config harness/rail-ping.vite.config.ts      (serves :5331, RP_PORT to change)
//   node harness/rail-ping-shots.mjs <outDir>
//     env: BASE, PW_CORE, PW_CHROMIUM_EXE
// Writes top-down.png (only the down arrow), both.png (up + down), up.png
// (only the up arrow), after-click.png, and checks the click-to-scroll, the
// quiet-dot exclusion, the 56px fit, and reduced motion.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5331/harness/rail-ping.html';
const OUT = process.argv[2] ?? '/tmp/rail-ping-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    async function open(reducedMotion = 'no-preference') {
        const ctx = await browser.newContext({ viewport: { width: 200, height: 460 }, deviceScaleFactor: 2, reducedMotion, colorScheme: 'dark' });
        const page = await ctx.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
        await page.goto(BASE);
        await page.waitForFunction(() => window.__booted === true);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForSelector('[data-testid="rail-scroll"]');
        await page.waitForTimeout(800); // badge pop-in
        return { ctx, page };
    }
    const scrollTo = async (page, y) => {
        await page.evaluate(v => { document.querySelector('[data-testid="rail-scroll"]').scrollTop = v; }, y);
        await page.waitForTimeout(350); // rAF re-measure + 180ms entrance
    };
    const arrows = page => page.evaluate(() => ({
        up: document.querySelector('[data-testid="rail-ping-up"]')?.getAttribute('aria-label') ?? null,
        down: document.querySelector('[data-testid="rail-ping-down"]')?.getAttribute('aria-label') ?? null,
    }));
    const shot = (page, name) => page.locator('nav.app-rail').screenshot({ path: `${OUT}/${name}` });

    {
        const { ctx, page } = await open();
        console.log('pingKeys', JSON.stringify(await page.evaluate(() => window.__pingKeys)));
        const geo = await page.evaluate(() => { const el = document.querySelector('[data-testid="rail-scroll"]'); return { h: el.clientHeight, sh: el.scrollHeight }; });
        check('the server box overflows (so the rail scrolls)', geo.sh > geo.h, JSON.stringify(geo));

        // 1. At the top: DM visible, red servers 9 and 15 below -> down only, 2.
        await scrollTo(page, 0);
        let a = await arrows(page);
        check('top: only the DOWN arrow, counting 2', a.up === null && a.down === '2 unread pings below', JSON.stringify(a));
        await shot(page, 'top-down.png');

        // 2. Mid: DM scrolled out above, server 9 in view, 15 still below -> both.
        await scrollTo(page, 260);
        a = await arrows(page);
        check('mid: UP and DOWN arrows', a.up === '1 unread ping above' && a.down === '1 unread ping below', JSON.stringify(a));
        await shot(page, 'both.png');

        // Fit: the pill sits inside the 56px box with room to spare.
        const fit = await page.evaluate(() => {
            const box = document.querySelector('.cl-rail-box').getBoundingClientRect();
            const p = document.querySelector('[data-testid="rail-ping-up"]').getBoundingClientRect();
            const cs = getComputedStyle(document.querySelector('[data-testid="rail-ping-up"]'));
            return { boxW: box.width, pillW: p.width, pillH: p.height, inside: p.left >= box.left && p.right <= box.right, bg: cs.backgroundColor };
        });
        check('pill fits inside the rail box', fit.inside && fit.pillW < fit.boxW, JSON.stringify(fit));
        check('pill is Flash coral (#FF6B5E)', fit.bg === 'rgb(255, 107, 94)', fit.bg);

        // 3. Bottom: server 15 in view, DM + server 9 above -> up only, 2.
        await scrollTo(page, 100000);
        a = await arrows(page);
        check('bottom: only the UP arrow, counting 2', a.up === '2 unread pings above' && a.down === null, JSON.stringify(a));
        await shot(page, 'up.png');

        // Quiet dot never counts: scroll so server 4 (quiet) is out above but
        // nothing red is — DM is red, so instead assert by keys.
        const keys = await page.evaluate(() => window.__pingKeys);
        check('quiet grey dot (server 4) is not a ping', JSON.stringify(keys) === JSON.stringify(['nav:dm', 'srv:s9', 'srv:s15']), JSON.stringify(keys));

        // 4. Click from the top: goes to the NEAREST below (server 9) first,
        //    then a second click to server 15; then the down arrow is gone.
        await scrollTo(page, 0);
        await page.click('[data-testid="rail-ping-down"]');
        await page.waitForTimeout(900);
        const first = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="rail-scroll"]');
            const b = el.getBoundingClientRect();
            const t = el.querySelector('[data-rail-id="srv:s9"]').getBoundingClientRect();
            return { scroll0: el.scrollTop, tileTop: t.top - b.top, tileBottom: t.bottom - b.top, h: el.clientHeight };
        });
        a = await arrows(page);
        check('first click lands on the NEAREST (server 9); 1 still below', first.tileTop >= 0 && first.tileBottom <= first.h && a.down === '1 unread ping below', JSON.stringify({ first, a }));
        await shot(page, 'after-first-click.png');
        await page.click('[data-testid="rail-ping-down"]');
        await page.waitForTimeout(100);
        const midScroll = await page.evaluate(() => document.querySelector('[data-testid="rail-scroll"]').scrollTop);
        await page.waitForTimeout(900);
        const end = await page.evaluate(() => {
            const el = document.querySelector('[data-testid="rail-scroll"]');
            const b = el.getBoundingClientRect();
            const t = el.querySelector('[data-rail-id="srv:s15"]').getBoundingClientRect();
            return { scrollTop: el.scrollTop, tileTop: t.top - b.top, tileBottom: t.bottom - b.top, h: el.clientHeight };
        });
        check('click smooth-scrolls (still travelling 100ms in)', midScroll > first.scroll0 && midScroll < end.scrollTop, `${midScroll} -> ${end.scrollTop}`);
        check('server 15 lands fully in view, clear of the bottom pill area', end.tileTop >= 0 && end.tileBottom <= end.h - 20, JSON.stringify(end));
        a = await arrows(page);
        check('down arrow gone after reveal; up arrow (DM) now shown', a.down === null && a.up !== null, JSON.stringify(a));
        await shot(page, 'after-click.png');

        // 5. Hover state screenshot on the up arrow.
        await page.hover('[data-testid="rail-ping-up"]');
        await page.waitForTimeout(200);
        await shot(page, 'hover-up.png');
        await ctx.close();
    }

    // Reduced motion: the jump is instant.
    {
        const { ctx, page } = await open('reduce');
        await scrollTo(page, 0);
        await page.click('[data-testid="rail-ping-down"]');
        await page.waitForTimeout(40);
        const st = await page.evaluate(() => document.querySelector('[data-testid="rail-scroll"]').scrollTop);
        await page.waitForTimeout(400);
        const st2 = await page.evaluate(() => document.querySelector('[data-testid="rail-scroll"]').scrollTop);
        check('reduced motion: instant jump (no travel)', st > 0 && st === st2, `${st} / ${st2}`);
        const anim = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="rail-ping-up"]')).animationName);
        check('reduced motion: no entrance animation', anim === 'none', anim);
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
