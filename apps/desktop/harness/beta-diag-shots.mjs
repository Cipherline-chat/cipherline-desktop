// Beta diagnostics UI: screenshots of every state + a keyboard check of the rating card.
//   npx vite --config harness/beta-diag.vite.config.ts     (serves :5247)
//   node harness/beta-diag-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// Launches (and closes) its OWN headless browser; nothing is left running.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5247/harness/beta-diag.html';
const OUT = process.env.OUT ?? '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SCREENS = ['rating', 'rating-picked', 'rating-sent', 'notice', 'setting', 'setting-off'];

const browser = await chromium.launch({ executablePath: exe });
try {
    for (const reduced of [false, true]) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
        const page = await ctx.newPage();
        page.setDefaultTimeout(120_000);
        page.on('pageerror', e => console.log('pageerror', e.message));
        for (const s of (reduced ? ['rating-picked'] : SCREENS)) {
            await page.goto(`${BASE}?screen=${s}`);
            await page.waitForSelector(s.startsWith('setting') ? '.sd-card' : '.rp-prompt');
            await page.evaluate(() => document.fonts.ready);
            await sleep(reduced ? 200 : 1000);
            const name = `beta-diag-${s}${reduced ? '-reduced-motion' : ''}.png`;
            await page.screenshot({ path: `${OUT}/${name}` });
            const anim = await page.evaluate(() => { const el = document.querySelector('.rp-prompt'); return el ? getComputedStyle(el).animationName : null; });
            console.log(name, 'animation:', anim, 'toggle:', await page.locator('[aria-label="Share beta diagnostics"]').count());
        }
        if (!reduced) {
            // Keyboard: focus the stars, arrows choose, tags appear, a digit chooses directly.
            await page.goto(`${BASE}?screen=rating`);
            await page.waitForSelector('.bd-star');
            await page.locator('.bd-star').first().focus();
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            const checked = await page.evaluate(() => [...document.querySelectorAll('.bd-star')].map(b => b.getAttribute('aria-checked')));
            const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
            const tags = await page.locator('.bd-tag').count();
            await page.screenshot({ path: `${OUT}/beta-diag-rating-keyboard.png` });
            await page.keyboard.press('5');
            const after5 = await page.evaluate(() => document.querySelectorAll('.bd-star.is-on').length);
            const tagsAt5 = await page.locator('.bd-tag').count();
            console.log('keyboard:', JSON.stringify({ checked, focused, tagsAt2: tags, starsAfterKey5: after5, tagsAt5 }));
        }
        await ctx.close();
    }
} finally {
    await browser.close();
}
