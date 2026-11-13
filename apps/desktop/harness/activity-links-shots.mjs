// Activity links / logos / truncation: node harness/activity-links-shots.mjs  (env: OUT BASE PREFIX)
// One PNG per scene (data-scene), plus the card scene with the link row hovered and keyboard-focused.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5352/harness/activity-links.html';
const OUT = process.env.OUT ?? '/tmp/activity-links';
const PREFIX = process.env.PREFIX ?? 'after';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1600 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(240_000); // a cold vite dep-optimise takes a while
    page.on('pageerror', (e) => console.log('pageerror ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION|Network Error|AxiosError/.test(m.text())) console.log('console.error: ' + m.text().slice(0, 300)); });
    for (const scene of ['friends', 'sidebar', 'members', 'card', 'full', 'settings', 'logos']) {
        await page.goto(`${BASE}?scene=${scene}`);
        const el = page.locator(`[data-scene="${scene}"]`);
        if (!(await el.count())) { console.log(`SKIP ${scene} (not on this build)`); continue; }
        await page.evaluate(() => document.fonts.ready);
        await new Promise((r) => setTimeout(r, scene === 'settings' ? 1500 : 700));
        // Overflow check: does any text box inside the scene stick out past the scene's right edge?
        const over = await page.evaluate((s) => {
            const root = document.querySelector(`[data-scene="${s}"]`);
            const edge = root.getBoundingClientRect().right;
            const hits = [];
            for (const n of root.querySelectorAll('*')) {
                const r = n.getBoundingClientRect();
                if (r.width && r.right > edge + 0.5 && n.textContent && n.children.length === 0) hits.push(`${n.tagName.toLowerCase()}.${n.className}: +${Math.round(r.right - edge)}px "${n.textContent.slice(0, 40)}"`);
            }
            // Text clipped WITHOUT an ellipsis: an element that overflows its box and whose own style is not text-overflow:ellipsis
            const clipped = [];
            for (const n of root.querySelectorAll('[data-testid="status-line-listening"], .pfa-line, .pfa-title, .pfa-detail, .ig-now-t, .ig-now-txt > span, .fp-sub')) {
                const cs = getComputedStyle(n);
                if (n.scrollWidth > n.clientWidth + 1) clipped.push(`${n.className || n.dataset.testid}: scroll ${n.scrollWidth} > ${n.clientWidth}, text-overflow=${cs.textOverflow}`);
            }
            return { hits, clipped };
        }, scene);
        console.log(`${scene}: escapes-right=${over.hits.length}${over.hits.length ? ' ' + JSON.stringify(over.hits.slice(0, 4)) : ''}`);
        for (const c of over.clipped) console.log(`   overflowing box: ${c}`);
        await el.screenshot({ path: `${OUT}/${PREFIX}-${scene}.png` });
        console.log(`SHOT ${OUT}/${PREFIX}-${scene}.png`);
        if (scene === 'card') {
            const row = page.locator('.pfa-row').first();
            if (await row.count()) {
                await row.hover();
                await new Promise((r) => setTimeout(r, 300));
                await el.screenshot({ path: `${OUT}/${PREFIX}-card-hover.png` });
                console.log(`SHOT ${OUT}/${PREFIX}-card-hover.png  title="${(await row.getAttribute('title'))?.replace(/\n/g, ' | ')}"  aria-label="${await row.getAttribute('aria-label')}"`);
                await page.mouse.move(0, 0);
                await row.focus();
                await page.keyboard.press('Shift+Tab');
                await page.keyboard.press('Tab');
                await new Promise((r) => setTimeout(r, 300));
                await el.screenshot({ path: `${OUT}/${PREFIX}-card-focus.png` });
                console.log(`SHOT ${OUT}/${PREFIX}-card-focus.png  focused=${await page.evaluate(() => document.activeElement?.className)}`);
            } else console.log('card: no link row on this build');
        }
    }
    await ctx.close();
} finally { await browser.close(); }
