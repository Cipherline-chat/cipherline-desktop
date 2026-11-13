// See share-fallback-notice.vite.config.ts. Screenshots of the loss-fallback notice on a watched
// share, docked and fullscreen, plus real-pointer checks of both buttons.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;
const BASE = process.env.BASE ?? 'http://127.0.0.1:5499/harness/share-fallback-notice.html';
const OUT = process.env.OUT ?? '/tmp/share-fallback-notice';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
console.log('browser pid ' + (browser.process?.()?.pid ?? '?'));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120_000);
    page.on('pageerror', e => console.log('pageerror ' + e.message.slice(0, 400)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|Network Error|AxiosError/.test(m.text())) console.log('console.error: ' + m.text().slice(0, 300)); });
    await page.goto(BASE);
    await page.waitForFunction(() => window.H && window.H.focus);

    // ── Docked: the focused view ────────────────────────────────────────────
    await page.evaluate(() => window.H.focus('bob'));
    await page.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.videoWidth === 2560));
    await sleep(800);
    await page.evaluate(() => window.H.drop(720));
    await page.waitForSelector('[data-share-fallback="lighter"]');
    await sleep(400);
    const text = await page.locator('[data-share-fallback="lighter"]').innerText();
    check('docked: says what happened, with the real size', text.includes('can’t keep up with this stream') && text.includes('lighter 720p version'), JSON.stringify(text));
    await page.screenshot({ path: `${OUT}/focused-view.png` });

    // Not on top of the corner chrome.
    const overlaps = await page.evaluate(() => {
        const note = document.querySelector('[data-share-fallback="lighter"]').getBoundingClientRect();
        const others = [...document.querySelectorAll('.backdrop-blur-sm')].filter(e => !e.closest('[data-share-fallback-note]'));
        return others.map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && !(r.right <= note.left || r.left >= note.right || r.bottom <= note.top || r.top >= note.bottom)).length;
    });
    check('docked: the note covers none of the tile chrome', overlaps === 0, `overlaps=${overlaps}`);

    // The tooltip on hover (the consequence).
    await page.hover('[data-testid="share-fallback-keep"]');
    await sleep(700);
    const tip = await page.evaluate(() => document.querySelector('[role="tooltip"]')?.textContent ?? '');
    check('Keep full quality explains the cost', tip.includes('may freeze or stutter'), JSON.stringify(tip));
    await page.screenshot({ path: `${OUT}/focused-view-tooltip.png` });
    await page.mouse.move(5, 880);
    await sleep(300);

    // × hides it, and a real click does not unfocus the tile under it.
    await page.click('[data-testid="share-fallback-dismiss"]');
    await sleep(200);
    check('× hides the note', !(await page.$('[data-share-fallback="lighter"]')));
    check('× does not reach the tile (still focused)', !!(await page.evaluate(() => window.H.state().focused)));
    check('× is not an opt-out', !(await page.evaluate(() => window.H.optedOut())));

    // ── Fullscreen ──────────────────────────────────────────────────────────
    await page.evaluate(() => window.H.fullscreen(true));
    await sleep(900);
    await page.evaluate(() => window.H.drop(720));
    await page.waitForSelector('#call-fullscreen-root [data-share-fallback="lighter"], [data-share-fallback="lighter"]');
    await sleep(400);
    await page.screenshot({ path: `${OUT}/fullscreen.png` });

    // Keep full quality, with a real pointer.
    const keep = page.locator('[data-testid="share-fallback-keep"]').last();
    await keep.click();
    await sleep(200);
    const st = await page.evaluate(() => ({ kept: window.H.kept, opted: window.H.optedOut(), fs: window.H.state().fullscreen, focused: !!window.H.state().focused, note: !!document.querySelector('[data-share-fallback="lighter"]') }));
    check('Keep full quality: opted out, monitor told, note gone, still fullscreen + focused', st.opted && st.kept.length === 1 && !st.note && st.fs && st.focused, JSON.stringify(st));
    await page.evaluate(() => window.H.drop(720));
    await sleep(200);
    check('after opting out the note never comes back for this share', !(await page.$('[data-share-fallback="lighter"]')));

    // "Back to full quality", on a fresh page (the opt-out is per share).
    const page2 = await ctx.newPage();
    await page2.goto(BASE);
    await page2.waitForFunction(() => window.H && window.H.focus);
    await page2.evaluate(() => { window.H.focus('bob'); window.H.fullscreen(true); });
    await page2.waitForFunction(() => [...document.querySelectorAll('video')].some(v => v.videoWidth === 2560));
    await sleep(800);
    await page2.evaluate(() => window.H.drop(null));
    await page2.waitForSelector('[data-share-fallback="lighter"]');
    const t2 = await page2.locator('[data-share-fallback="lighter"]').last().innerText();
    check('unknown size: no number quoted', t2.includes('lighter version') && !/\dp/.test(t2), JSON.stringify(t2));
    await page2.screenshot({ path: `${OUT}/fullscreen-unknown-size.png` });
    await page2.evaluate(() => window.H.recover());
    await page2.waitForSelector('[data-share-fallback="restored"]');
    await sleep(300);
    await page2.screenshot({ path: `${OUT}/fullscreen-restored.png` });
    await sleep(3200);
    check('"Back to full quality" goes by itself', !(await page2.$('[data-share-fallback="restored"]')));
} finally {
    await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
