// Egg-hunter badges: behaviour checks + screenshots, real Chromium at 1280x800 @2x.
//
//   npx vite --config harness/egg-badges.vite.config.ts      (serves :5420)
//   node harness/egg-badges-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5420/harness/egg-badges.html';
const OUT = process.env.OUT ?? '/tmp/egg-badges-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

async function open(query, opts = {}) {
    const ctx = await browser.newContext({
        viewport: opts.viewport ?? { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        reducedMotion: opts.reducedMotion ?? 'no-preference',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(Number(process.env.TIMEOUT ?? 120000));
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + query, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(opts.settle ?? 1200);
    return { ctx, page };
}

const toastTitles = (page) => page.evaluate(() => [...document.querySelectorAll('.fade-rise-enter p')].map(p => p.textContent));

// 1. the four tiers on profile cards
{
    const { ctx, page } = await open('?scene=cards', { viewport: { width: 1000, height: 560 } });
    const chips = await page.evaluate(() => [...document.querySelectorAll('[data-card] [role="img"]')].map(c => c.getAttribute('aria-label')));
    check('cards: 5 badge chips (4 tiers + Deep Diver beside an admin badge) and none on the newcomer', chips.length === 6, JSON.stringify(chips));
    check('cards: owner-specified tooltip text', chips.includes('Egg hunter · Deep Diver · 12 easter eggs found'));
    const glyphs = await page.evaluate(() => [...document.querySelectorAll('[data-card] svg[data-egg-tier]')].map(s => s.getAttribute('data-egg-tier')));
    check('cards: one distinct glyph per tier', glyphs.slice(0, 4).join() === '1,2,3,4', glyphs.join());
    await page.screenshot({ path: `${OUT}/cards-four-tiers.png` });
    // hover tooltip on the Deep Diver chip
    const chip = page.locator('[data-card^="tier 3"] [role="img"]');
    await chip.hover();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/cards-tooltip-deep-diver.png` });
    await ctx.close();
}

// 2. friends-list size
{
    const { ctx, page } = await open('?scene=dense', { viewport: { width: 460, height: 360 } });
    await page.screenshot({ path: `${OUT}/dense-friends-list.png` });
    await ctx.close();
}

// 3. the toast pipeline, tier by tier
for (const reduced of ['no-preference', 'reduce']) {
    const { ctx, page } = await open('?scene=toast', { viewport: { width: 900, height: 420 }, reducedMotion: reduced });
    const suffix = reduced === 'reduce' ? '-reduced-motion' : '';
    const steps = [[3, 'Tide Pooler', 3], [4, 'Reef Explorer', 7], [5, 'Deep Diver', 12], [6, 'Abyss Legend', 18]];
    let found = 0;
    for (const [add, name, total] of steps) {
        const need = total - found;
        await page.evaluate((n) => window.__find(n), need);
        found = total;
        await page.waitForTimeout(3600);                       // 2.5 s debounce + round trip
        const titles = await toastTitles(page);
        check(`toast${suffix}: ${total} eggs -> "New badge: ${name}"`, titles.includes(`New badge: ${name}`), JSON.stringify(titles));
        await page.screenshot({ path: `${OUT}/toast-${total}-${name.toLowerCase().replace(/ /g, '-')}${suffix}.png` });
    }
    const posts = await page.evaluate(() => window.__posts.length);
    check(`toast${suffix}: one POST per burst (4 bursts)`, posts === 4, String(posts));
    const lastIds = await page.evaluate(() => window.__posts.at(-1).ids.length);
    check(`toast${suffix}: the last POST carried the whole found-set`, lastIds === 18, String(lastIds));
    await ctx.close();
}

// 4. a new install on an account that already holds Deep Diver: silent
{
    const { ctx, page } = await open('?scene=toast&known=12', { viewport: { width: 900, height: 420 } });
    await page.evaluate(() => window.__find(1));
    await page.waitForTimeout(3600);
    check('known=12: first find on a fresh device earns NO toast', (await toastTitles(page)).length === 0);
    await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
