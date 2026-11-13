// Trial-ending prompt + Subscription pane: 2x screenshots in real Chromium, dark theme.
//
//   npx vite --config harness/trial-prompt.vite.config.ts      (serves :5317)
//   node harness/trial-prompt-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5317/harness/trial-prompt.html';
const OUT = process.env.OUT ?? '/tmp/trial-prompt-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 860 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });

    for (const [name, qs] of [['trial-prompt-founder', 'scene=prompt&founder=open&days=2'], ['trial-prompt-closed', 'scene=prompt&founder=closed&days=2'], ['trial-prompt-founder-lastday', 'scene=prompt&founder=open&days=1']]) {
        await page.goto(`${BASE}?${qs}`);
        await page.waitForSelector('[data-testid="trial-ending-prompt"]');
        await sleep(1200);
        const card = await page.locator('.mcard').boundingBox();
        const over = await page.locator('.mcard').evaluate(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
        check(`${name}: card fits, no overflow`, !over && card.height < 820, `h=${card.height}`);
        await page.screenshot({ path: `${OUT}/${name}.png` });
        console.log(`SHOT  ${OUT}/${name}.png`);
    }

    for (const who of ['founder', 'trial', 'trial-closed']) {
        await page.setViewportSize({ width: 1100, height: 1500 });
        await page.goto(`${BASE}?scene=billing&who=${who}`);
        await page.waitForSelector('[data-testid="founder-panel"]');
        await sleep(1500);
        const cards = await page.evaluate(() => { const r = document.querySelector('section').getBoundingClientRect(); return { y: 0, h: Math.min(r.bottom + 24, 1500) }; });
        await page.screenshot({ path: `${OUT}/subscription-${who}.png`, clip: { x: 0, y: 0, width: 1100, height: cards.h } });
        console.log(`SHOT  ${OUT}/subscription-${who}.png`);
    }

    // no counts or founder number anywhere (the fixtures DO carry them)
    for (const qs of ['scene=prompt&founder=open&days=2', 'scene=billing&who=founder', 'scene=billing&who=trial']) {
        await page.goto(`${BASE}?${qs}`);
        await sleep(1200);
        const t = await page.evaluate(() => document.body.innerText);
        check(`${qs}: no spot count / founder number`, !/#\s?1234|1,?234|6,?158|3,?842|spots? left/.test(t) && t.length > 200);
    }

    // founder cancel: the big modal at rest, then mid-slide
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`${BASE}?scene=billing&who=founder`);
    await page.waitForSelector('[data-testid="founder-panel"]');
    await sleep(1200);
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cancel subscription').click());
    await page.waitForSelector('[data-testid="founder-cancel-prompt"]');
    await sleep(900);
    const focused = await page.evaluate(() => document.activeElement?.textContent);
    check('founder cancel: default focus on "Keep my founding price"', focused === 'Keep my founding price', String(focused));
    const fits = await page.locator('.mcard').evaluate(el => el.getBoundingClientRect().height <= window.innerHeight);
    check('founder cancel: modal fits the viewport', fits);
    await page.screenshot({ path: `${OUT}/founder-cancel-modal.png` });
    console.log(`SHOT  ${OUT}/founder-cancel-modal.png`);
    const thumb = page.locator('[data-testid="founder-cancel-slide"] [role="slider"]');
    const tb = await thumb.boundingBox();
    const trk = await page.locator('[data-testid="founder-cancel-slide"]').boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 + (trk.width - tb.width) * 0.55, tb.y + tb.height / 2, { steps: 12 });
    await sleep(150);
    const mid = Number(await page.locator('[data-testid="founder-cancel-slide"]').getAttribute('data-progress'));
    check('founder cancel: mid-slide progress ~55%', mid > 40 && mid < 70, `p=${mid}`);
    await page.screenshot({ path: `${OUT}/founder-cancel-mid-slide.png` });
    console.log(`SHOT  ${OUT}/founder-cancel-mid-slide.png`);
    await page.mouse.up();
    await sleep(500);
    const back = Number(await page.locator('[data-testid="founder-cancel-slide"]').getAttribute('data-progress'));
    check('founder cancel: released short of the end springs back to 0', back === 0, `p=${back}`);
    const cancels = await page.evaluate(() => window.__cancelCalls ?? 0);
    check('founder cancel: partial slide made no cancel call', cancels === 0, `calls=${cancels}`);

    // reduced motion: the prompt still renders fully (no content left at opacity 0)
    const rm = await browser.newContext({ viewport: { width: 1100, height: 860 }, reducedMotion: 'reduce', colorScheme: 'dark' });
    const rp = await rm.newPage();
    await rp.goto(`${BASE}?scene=prompt&founder=open&days=2`);
    await rp.waitForSelector('[data-testid="trial-ending-prompt"]');
    await sleep(300);
    const op = await rp.locator('[data-testid="trial-prompt-price-row"]').evaluate(el => getComputedStyle(el).opacity);
    check('reduced motion: offer visible immediately', op === '1', `opacity=${op}`);
    await rm.close();
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
