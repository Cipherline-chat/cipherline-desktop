// "Everyday touches": behaviour checks + screenshots + short clips in real Chromium.
//
//   npx vite --config harness/everyday.vite.config.ts        (serves :5431)
//   npx vite --config harness/everyday-call.vite.config.ts   (serves :5432)
//   node harness/everyday-shots.mjs                          (env: OUT=<dir> PW_CHROMIUM_EXE=...)
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const MAIN = process.env.BASE ?? 'http://127.0.0.1:5431/harness/everyday.html';
const CALL = process.env.CALL_BASE ?? 'http://127.0.0.1:5432/harness/everyday-call.html';
const OUT = process.env.OUT ?? '/tmp/everyday-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });

async function open(base, query, opts = {}) {
    const ctx = await browser.newContext({
        viewport: opts.viewport ?? { width: 1100, height: 700 },
        deviceScaleFactor: opts.dpr ?? 2,
        reducedMotion: opts.reducedMotion ?? 'no-preference',
        ...(opts.video ? { recordVideo: { dir: `${OUT}/_video`, size: opts.viewport ?? { width: 1100, height: 700 } } } : {}),
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(Number(process.env.TIMEOUT ?? 120000));
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(base + query, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(opts.settle ?? 1000);
    return { ctx, page };
}
/** Closes the context (finalising the video) and names the clip. */
async function finishVideo(ctx, page, name) {
    const v = page.video();
    await ctx.close();
    if (v) { const p = await v.path(); renameSync(p, `${OUT}/${name}.webm`); }
}

// 2. loading screen tips
{
    const { ctx, page } = await open(MAIN, '?scene=loading', { viewport: { width: 1000, height: 640 }, settle: 1800 });
    const tip = () => page.evaluate(() => document.querySelector('.lo-tip-line')?.textContent ?? null);
    const a = await tip();
    await page.screenshot({ path: `${OUT}/2-loading-tip-a.png` });
    await page.waitForTimeout(3300);
    const b = await tip();
    await page.screenshot({ path: `${OUT}/2-loading-tip-b.png` });
    check('loading: a line is shown, aria-hidden', !!a && (await page.evaluate(() => document.querySelector('.lo-tip')?.getAttribute('aria-hidden'))) === 'true', JSON.stringify(a));
    check('loading: the line changes after ~3 s', !!b && a !== b, JSON.stringify(b));
    await ctx.close();
    const r = await open(MAIN, '?scene=loading', { viewport: { width: 1000, height: 640 }, reducedMotion: 'reduce', settle: 1500 });
    const r1 = await r.page.evaluate(() => document.querySelector('.lo-tip-line')?.textContent);
    await r.page.waitForTimeout(3600);
    const r2 = await r.page.evaluate(() => document.querySelector('.lo-tip-line')?.textContent);
    check('loading (reduced motion): one static line', !!r1 && r1 === r2, JSON.stringify(r1));
    await r.page.screenshot({ path: `${OUT}/2-loading-tip-reduced-motion.png` });
    await r.ctx.close();
}

// 3. typing line
{
    const { ctx, page } = await open(MAIN, '?scene=typing', { viewport: { width: 620, height: 520 } });
    const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-row]')].map(r => [r.getAttribute('data-row'), r.querySelector('.truncate')?.textContent])));
    check('typing: 4 in a big server -> Several', rows['4 typing, big server'] === 'Several people are typing…', rows['4 typing, big server']);
    check('typing: 7 in a big server -> Several', rows['7 typing, big server'] === 'Several people are typing…');
    check('typing: 8 -> Everyone', rows['8 typing'] === 'Everyone is typing. Brace yourself.');
    check('typing: the whole of a 5-person channel -> Everyone', rows['all 5 of a 5-person channel'] === 'Everyone is typing. Brace yourself.');
    await page.screenshot({ path: `${OUT}/3-typing-line.png` });
    await ctx.close();
}

// 4. reaction burst
{
    const { ctx, page } = await open(MAIN, '?scene=reaction&start=9', { viewport: { width: 360, height: 220 }, dpr: 3, video: true });
    const debris = () => page.evaluate(() => document.querySelectorAll('span > span[aria-hidden="true"]').length);
    check('reaction: no burst at 9', (await debris()) === 0);
    await page.screenshot({ path: `${OUT}/4-reaction-9.png` });
    await page.evaluate(() => window.__setCount(10));
    await page.waitForTimeout(120);
    check('reaction: burst on the live 9 -> 10 crossing', (await debris()) === 9, String(await debris()));
    await page.screenshot({ path: `${OUT}/4-reaction-burst-120ms.png` });
    await page.waitForTimeout(160);
    await page.screenshot({ path: `${OUT}/4-reaction-burst-280ms.png` });
    await page.waitForTimeout(900);
    check('reaction: debris cleans itself up', (await debris()) === 0);
    await page.evaluate(() => window.__setCount(11));
    await page.waitForTimeout(150);
    check('reaction: no second burst at 11', (await debris()) === 0);
    await page.waitForTimeout(600);
    await finishVideo(ctx, page, '4-reaction-burst');
    // loaded already at ten: no burst on mount
    const m = await open(MAIN, '?scene=reaction&start=10', { viewport: { width: 360, height: 220 } });
    await m.page.waitForTimeout(300);
    check('reaction: no burst for a chip that mounts at 10', (await m.page.evaluate(() => document.querySelectorAll('span > span[aria-hidden="true"]').length)) === 0);
    await m.ctx.close();
}

// 5. shortcuts sheet
{
    const { ctx, page } = await open(MAIN, '?scene=shortcuts', { viewport: { width: 1000, height: 760 } });
    await page.focus('[data-testid="field"]');
    await page.keyboard.press('?');
    await page.waitForTimeout(400);
    check('shortcuts: ? in a text field does not open it', (await page.locator('.shortcuts-card').count()) === 0);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('?');
    await page.waitForTimeout(700);
    check('shortcuts: ? opens the sheet', (await page.locator('.shortcuts-card').count()) === 1);
    const caps = await page.evaluate(() => [...document.querySelectorAll('.ss-row')].slice(0, 2).map(r => r.textContent));
    check('shortcuts: lists the live keybinds', caps.join(' ').includes('Mute') && caps.join(' ').includes('Ctrl'), caps.join(' | '));
    await page.screenshot({ path: `${OUT}/5-shortcuts-sheet.png` });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    check('shortcuts: Escape closes it', (await page.locator('.shortcuts-card').count()) === 0);
    await ctx.close();
}

// 6. What's new
{
    const { ctx, page } = await open(MAIN, '?scene=whatsnew', { viewport: { width: 760, height: 640 }, video: true, settle: 150 });
    await page.screenshot({ path: `${OUT}/6-whatsnew-0150ms.png` });
    await page.waitForTimeout(550);
    await page.screenshot({ path: `${OUT}/6-whatsnew-0700ms.png` });
    await page.waitForTimeout(1900);
    await page.screenshot({ path: `${OUT}/6-whatsnew-final.png` });
    const t = await page.evaluate(() => document.querySelector('.wn-card')?.textContent ?? '');
    check('whats-new: title, notes from the CHANGELOG draft, and the footer actions', /What’s new in 1\.0\.23/.test(t) && /Keyboard shortcuts/.test(t) && /See all release notes/.test(t) && /Got it/.test(t), t.slice(0, 90));
    check('whats-new: focus lands on Got it', (await page.evaluate(() => document.activeElement?.textContent)) === 'Got it', await page.evaluate(() => document.activeElement?.textContent));
    await finishVideo(ctx, page, '6-whatsnew-unboxing');
    const r = await open(MAIN, '?scene=whatsnew', { viewport: { width: 760, height: 640 }, reducedMotion: 'reduce', settle: 400 });
    await r.page.screenshot({ path: `${OUT}/6-whatsnew-reduced-motion.png` });
    const anims = await r.page.evaluate(() => [...document.querySelectorAll('.wn-lid, .wn-keys')].map(e => getComputedStyle(e).animationName));
    check('whats-new (reduced motion): the art is still', anims.every(a => a === 'none'), anims.join());
    await r.ctx.close();
}

// 7. back online
{
    const { ctx, page } = await open(MAIN, '?scene=backonline', { viewport: { width: 900, height: 420 } });
    const toast = () => page.evaluate(() => document.body.innerText.includes('Back online'));
    await page.evaluate(() => window.__online(false));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__jump(60_000));      // a minute offline
    await page.evaluate(() => window.__online(true));
    await page.waitForTimeout(2300);
    check('back online: nothing after a one-minute outage', !(await toast()));
    await page.evaluate(() => window.__online(false));
    await page.waitForTimeout(200);
    await page.evaluate(() => window.__jump(4 * 60_000));  // four minutes offline
    await page.evaluate(() => window.__online(true));
    await page.waitForTimeout(2300);
    check('back online: a toast after four minutes', await toast());
    const txt = await page.evaluate(() => [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /offline for/.test(e.textContent ?? ''))?.textContent);
    check('back online: says how long', /offline for 4 minutes/.test(txt ?? ''), txt);
    await page.screenshot({ path: `${OUT}/7-back-online-toast.png` });
    await ctx.close();
}

// 10. title-bar lap
{
    const { ctx, page } = await open(MAIN, '?scene=titlebar', { viewport: { width: 1000, height: 200 }, video: true });
    const word = page.locator('[data-testid="titlebar-wordmark"]');
    for (let i = 0; i < 9; i++) { await word.click(); await page.waitForTimeout(120); }
    check('titlebar: nine clicks do nothing', (await page.locator('[data-testid="titlebar-lap"]').count()) === 0);
    await word.click();
    await page.waitForTimeout(500);
    check('titlebar: the tenth sets Keys off', (await page.locator('[data-testid="titlebar-lap"]').count()) === 1);
    await page.screenshot({ path: `${OUT}/10-titlebar-lap-0.5s.png` });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUT}/10-titlebar-lap-2.3s.png` });
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}/10-titlebar-lap-3.7s.png` });
    await page.waitForTimeout(3400);
    check('titlebar: the lap is gone afterwards', (await page.locator('[data-testid="titlebar-lap"]').count()) === 0);
    await finishVideo(ctx, page, '10-titlebar-lap');
}

// 8 + 9. call milestones
{
    const { ctx, page } = await open(CALL, '', { viewport: { width: 1100, height: 700 } });
    const card = () => page.locator('[role="status"]').count();
    check('call: no card at the start', (await card()) === 0);
    await page.evaluate(() => { window.__jump(3 * 3600_000 + 5000); window.__check(); });
    await page.waitForTimeout(900);
    check('call: the three-hour card appears', (await card()) === 1);
    check('call: its copy', (await page.locator('[role="status"]').first().textContent())?.includes('Three hours in. Maybe stretch?'));
    await page.screenshot({ path: `${OUT}/8-long-call-card.png` });
    await page.locator('[role="status"] button').first().click();
    await page.waitForTimeout(300);
    check('call: dismissed', (await card()) === 0);
    await page.evaluate(() => { window.__jump(5 * 3600_000); window.__check(); });
    await page.waitForTimeout(400);
    check('call: it does not come back', (await card()) === 0);
    await ctx.close();
}
{
    const { ctx, page } = await open(CALL, '', { viewport: { width: 1100, height: 700 }, video: true });
    await page.evaluate(() => { window.__share(true); });
    await page.evaluate(() => { window.__jump(61 * 60_000); window.__check(); });
    await page.waitForTimeout(1200);
    check('popcorn: appears after an hour of sharing', (await page.locator('[data-testid="popcorn"]').count()) === 1);
    await page.screenshot({ path: `${OUT}/9-popcorn-stage.png` });
    const box = await page.locator('[data-testid="popcorn"]').boundingBox();
    check('popcorn: sits in the stage\'s bottom-right corner', !!box && box.x > 800 && box.y > 500, JSON.stringify(box));
    await page.waitForTimeout(1500);
    await finishVideo(ctx, page, '9-popcorn');
    const f = await open(CALL, '?fullscreen=1', { viewport: { width: 1100, height: 700 } });
    await f.page.evaluate(() => { window.__share(true); window.__jump(61 * 60_000); window.__check(); });
    await f.page.waitForTimeout(1000);
    await f.page.screenshot({ path: `${OUT}/9-popcorn-fullscreen.png` });
    await f.ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
