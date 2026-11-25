// Link shortening: behaviour checks + before/after screenshots of the REAL renderer pieces in headless Chromium.
//
//   npx vite --config harness/link-shorten.vite.config.ts      (serves :5352)
//   node harness/link-shorten-shots.mjs                         (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// One browser for the whole run, closed at the end (see CLAUDE.md "Headless Chrome cleanup").
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5352/harness/link-shorten.html';
const OUT = process.env.OUT ?? '/tmp/link-shorten-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const DOCS = 'https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg/edit?usp=sharing&tab=t.0';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf&index=7&t=43s&pp=iAQB';

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const sizes = [[1000, 720, '1000x720'], [1366, 768, '1366x768']];
    for (const [w, h, label] of sizes) {
        for (const theme of ['dark', 'light']) {
            for (const before of [true, false]) {
                const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
                const page = await ctx.newPage();
                page.setDefaultTimeout(60000);
                page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
                await page.goto(`${BASE}?theme=${theme}${before ? '&before=1' : ''}`);
                await page.waitForSelector('[data-row="d"]');
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(400);
                const path = `${OUT}/${before ? 'before' : 'after'}-${label}-${theme}.png`;
                await page.screenshot({ path });
                console.log(`SHOT  ${path}`);

                if (!before && w === 1000 && theme === 'dark') {
                    // ---- behaviour in a real browser ----
                    const links = await page.evaluate(() => [...document.querySelectorAll('[data-row] [role="link"]')].map(el => ({
                        text: el.textContent, title: el.getAttribute('title'), aria: el.getAttribute('aria-label'), full: el.getAttribute('data-full-url'),
                    })));
                    const docs = links.find(l => l.full === DOCS);
                    check('shortened link shows the short text', !!docs && docs.text.length < 45 && docs.text.startsWith('docs.google.com/') && docs.text.includes('…'), docs?.text);
                    check('full URL is the hover title and the accessible name', docs?.title === DOCS && docs?.aria === DOCS);
                    check('short link is untouched (no title/marker)', links.some(l => l.text === 'https://example.com/ok' && !l.full && !l.title));
                    // masked [label](url), code, and <url> rows
                    const rowD = await page.evaluate(() => {
                        const d = document.querySelector('[data-row="d"]');
                        return { masked: !!d.querySelector('.cl-fmt-link'), maskedText: d.querySelector('.cl-fmt-link')?.textContent, code: d.querySelector('code')?.textContent, angleShort: [...d.querySelectorAll('[role="link"]')].map(e => e.textContent) };
                    });
                    check('masked link keeps its label', rowD.maskedText === 'my label');
                    check('code keeps the whole URL', rowD.code === DOCS);

                    // Ctrl+C over the whole body of row b (a lone shortened link + "lol")
                    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
                    await page.evaluate(() => {
                        const body = document.querySelector('[data-row="b"] [data-body]');
                        const r = document.createRange(); r.selectNodeContents(body);
                        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                    });
                    await page.keyboard.press('Control+C');
                    await page.waitForTimeout(200);
                    const clip = await page.evaluate(() => navigator.clipboard.readText());
                    check('Ctrl+C over a message with a shortened link copies the FULL url', clip === `${YT}\nlol`, JSON.stringify(clip));

                    // Triple-click the link itself, then copy
                    await page.locator('[data-row="a"] [role="link"]').dblclick();
                    await page.keyboard.press('Control+C');
                    await page.waitForTimeout(200);
                    const clip2 = await page.evaluate(() => navigator.clipboard.readText());
                    console.log('INFO  double-click selection copied: ' + JSON.stringify(clip2));
                    check('double-click-selected link copies a prefix-or-full of the real URL (never the "…" text)', !clip2.includes('…'));
                }
                await ctx.close();
            }
        }
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
