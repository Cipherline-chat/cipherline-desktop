// End-to-end in real Chromium: the REAL Add Friend dialog + the REAL MomentHost.
// Typing your own tag (the harness user is Dawson#1234) must play the moment and send NOTHING;
// Escape must close only the moment (the dialog stays); someone else's tag must be sent.
//   npx vite --config harness/moments.vite.config.ts   then   node harness/moments-addfriend.mjs (env: OUT=<dir>)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5427/harness/moments.html';
const OUT = process.env.OUT ?? '/tmp/moments-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
await page.goto(BASE + '?scene=add-friend', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Array.isArray(window.__ids));
await page.evaluate(() => window.__reset());
await page.waitForSelector('#add-friend-tag');

await page.fill('#add-friend-tag', 'Dawson#1234');
await page.keyboard.press('Enter');
await page.waitForSelector('[data-moment="self-friend"]', { timeout: 10000 });
check('own tag → the moment plays', true);
check('own tag → nothing sent', (await page.evaluate(() => window.__calls.length)) === 0, JSON.stringify(await page.evaluate(() => window.__calls)));
const live = await page.textContent('[data-testid="moment-live"]');
check('punchline announced (aria-live)', /You played yourself/.test(live), live);
await page.waitForTimeout(5400);   // the stamp has landed (4.4–4.9 s)
await page.screenshot({ path: `${OUT}/add-friend-e2e-moment.png` });
check('focus stayed in the tag field (typing target)', await page.evaluate(() => document.activeElement?.id === 'add-friend-tag'));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
check('Escape skips the moment', (await page.$('[data-moment]')) === null);
check('…and leaves the dialog open', (await page.$('#add-friend-tag')) !== null);
const err = await page.textContent('.dlg-form');
check('error slot says nothing was sent', /not sent|didn.t send|no request sent/i.test(err));
await page.screenshot({ path: `${OUT}/add-friend-e2e-after.png` });

await page.fill('#add-friend-tag', 'Mira#4821');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const calls = await page.evaluate(() => window.__calls);
check("someone else's tag → sent", calls.length === 1 && /friends\/request/.test(calls[0]), JSON.stringify(calls));
check('…with no moment', (await page.$('[data-moment]')) === null);

await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
