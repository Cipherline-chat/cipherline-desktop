// "Open someone's level": behaviour checks + screenshots in real Chromium.
//
//   npx vite --config harness/level-progress.vite.config.ts      (serves :5496)
//   node harness/level-progress-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5496/harness/level-progress.html';
const OUT = process.env.OUT ?? '/tmp/level-progress-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
async function open(scene, { size = [1180, 820], reduced = true, extra = {} } = {}) {
    const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(150000); // first load runs Vite's dep optimiser
    page.on('pageerror', (e) => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await page.goto(`${BASE}?${new URLSearchParams({ scene, ...extra })}`);
    await page.waitForSelector('[data-testid="profile-full"], [data-testid="card"]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    return { ctx, page };
}
const text = (page, sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);

try {
    // 1. The preview card: the level medallion is a button; Enter on it opens the full profile on Achievements.
    {
        const { ctx, page } = await open('card', { size: [400, 640] });
        await page.screenshot({ path: `${OUT}/01-card-level-clickable.png` });
        await page.focus('[data-testid="profile-level"]');
        await page.waitForTimeout(400); // tooltip
        await page.screenshot({ path: `${OUT}/02-card-level-focused.png` });
        await page.keyboard.press('Enter');
        await page.waitForSelector('[data-testid="level-progress"]');
        check('card: Enter on the level opens the full profile on Achievements', (await page.evaluate(() => window.__openedFull)).join() === 'achievements');
        await ctx.close();
    }
    // 2. Mid-level user: press the level on the full profile (keyboard), land on the progress.
    {
        const { ctx, page } = await open('mid');
        await page.screenshot({ path: `${OUT}/03-full-overview-level.png` });
        await page.focus('[data-testid="profile-level"]');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[data-testid="level-progress"]');
        await page.waitForTimeout(300);
        check('mid: Achievements tab selected', (await page.getAttribute('[data-testid="profile-full-tab-achievements"]', 'aria-selected')) === 'true');
        check('mid: focus on the level section', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'level-progress'));
        const line = await text(page, '[data-testid="level-progress-line"]');
        check('mid: "11 of 16 points to level 4"', line === '11 of 16 points to level 4', line);
        check('mid: eggs count only', (await text(page, '[data-testid="level-progress-eggs"]')) === '4 easter eggs found');
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/04-mid-level-progress.png` });
        await page.click('[data-testid="achievements-filter-locked"]');
        const secret = await page.$('[aria-label="Secret achievement, locked"]');
        check('mid: a secret locked one is listed as secret', !!secret);
        await secret.hover();
        await page.waitForTimeout(200);
        const d = await text(page, '[data-testid="achievement-detail"]');
        check('mid: its detail says "Secret achievement"', /Secret achievement/.test(d ?? ''), d);
        await page.screenshot({ path: `${OUT}/05-mid-locked-secret.png` });
        const pub = await page.$('[data-testid="achievement-voice-100h"] button');
        await pub.hover();
        await page.waitForTimeout(200);
        const d2 = await text(page, '[data-testid="achievement-detail"]');
        check('mid: a locked one shows title + tier + Locked, no progress numbers', /Deep Listener/.test(d2) && /Bronze · Locked/.test(d2) && !/\d+(\.\d)? \/ /.test(d2), d2);
        await page.screenshot({ path: `${OUT}/06-mid-locked-detail.png` });
        await ctx.close();
    }
    // 3. Max level.
    {
        const { ctx, page } = await open('max', { extra: { tab: 'achievements' } });
        const line = await text(page, '[data-testid="level-progress-line"]');
        check('max: "Max level · N points"', /^Max level · \d+ points$/.test(line ?? ''), line);
        check('max: no "to go"', !(await page.$('[data-testid="level-progress-togo"]')));
        await page.screenshot({ path: `${OUT}/07-max-level.png` });
        await ctx.close();
    }
    // 4. A level from eggs alone.
    {
        const { ctx, page } = await open('eggs');
        await page.click('[data-testid="profile-level"]');
        await page.waitForSelector('[data-testid="level-progress"]');
        check('eggs: lands on the progress', (await text(page, '[data-testid="level-progress-line"]')) === '5 of 9 points to level 3');
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/08-eggs-only-level.png` });
        await ctx.close();
    }
    // 5. Not shared: no level medallion, the tab says so.
    {
        const { ctx, page } = await open('hidden');
        check('hidden: no level to press', !(await page.$('[data-testid="profile-level"]')));
        await page.screenshot({ path: `${OUT}/09-hidden-overview.png` });
        await page.click('[data-testid="profile-full-tab-achievements"]');
        await page.waitForSelector('[data-testid="level-progress"][data-state="hidden"]');
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/10-hidden-not-shared.png` });
        await ctx.close();
    }
    // 6. Your own profile (local progress allowed), and the narrow window.
    {
        const { ctx, page } = await open('self', { extra: { tab: 'achievements' } });
        await page.click('[data-testid="achievements-filter-locked"]');
        await page.hover('[data-testid="achievement-voice-100h"] button');
        await page.waitForTimeout(200);
        await page.screenshot({ path: `${OUT}/11-self-local-progress.png` });
        await ctx.close();
    }
    {
        const { ctx, page } = await open('mid', { size: [720, 760], extra: { tab: 'achievements' } });
        await page.screenshot({ path: `${OUT}/12-mid-narrow.png` });
        await ctx.close();
    }
    // 7. Motion on: the bar fills to its value and stops there (no overshoot to 100%).
    {
        const { ctx, page } = await open('mid', { reduced: false, extra: { tab: 'achievements' } });
        await page.waitForTimeout(1200);
        const box = await page.$eval('[data-testid="level-progress-bar"]', (b) => [b.getBoundingClientRect().width, b.querySelector('i').getBoundingClientRect().width]);
        check('motion: bar settles at 11/16', Math.abs(box[1] / box[0] - 11 / 16) < 0.01, box.join('/'));
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
