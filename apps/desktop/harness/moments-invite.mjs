// End-to-end in real Chromium, in real time: the @everyone echo's "Invite friends" button.
// The REAL MomentHost + Dashboard's invite path (useMomentInviteRequest → the REAL ServerInviteModal).
//   - the button comes up with the punchline and the moment then WAITS (no timed exit);
//   - pressing it opens the invite dialog for the server the @everyone was sent in (s-kelp here,
//     deliberately not the first stub server) and that dialog really creates/shows that server's link;
//   - clicking the backdrop instead dismisses the moment and opens nothing.
//   npx vite --config harness/moments.vite.config.ts   then   node harness/moments-invite.mjs (env: OUT=<dir>)
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
await page.goto(BASE + '?scene=play', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Array.isArray(window.__ids));
await page.evaluate(() => document.fonts.ready);

// 1) press the button
await page.evaluate(() => window.__reset());
await page.evaluate(() => window.__play('echo-everyone', { serverId: 's-kelp' }));
await page.waitForSelector('[data-moment="echo-everyone"]');
await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="moment-action"]');
    return b && getComputedStyle(b).visibility === 'visible' && Number(getComputedStyle(b).opacity) > 0.99;
}, null, { timeout: 15000 });
check('button is up with the punchline', true);
await page.waitForTimeout(12000);   // well past where a timed moment would have left (8.4 s)
check('…and the moment is still there 12 s later (no timed exit)', (await page.$('[data-moment="echo-everyone"]')) !== null);
check('…button still visible', await page.evaluate(() => Number(getComputedStyle(document.querySelector('[data-testid="moment-action"]')).opacity) > 0.99));
await page.screenshot({ path: `${OUT}/invite-e2e-1-waiting.png` });
await page.click('[data-testid="moment-action"]');
await page.waitForTimeout(300);
check('pressing it ends the moment', (await page.$('[data-moment]')) === null);
check('…and asks for the invite of THAT server', (await page.evaluate(() => window.__inviteFor)) === 's-kelp', String(await page.evaluate(() => window.__inviteFor)));
await page.waitForFunction(() => document.body.innerText.includes('cipherline.chat/invite/kelp42'), null, { timeout: 10000 }).catch(() => {});
const text = await page.evaluate(() => document.body.innerText);
check('the real invite dialog shows that server’s link', text.includes('cipherline.chat/invite/kelp42'));
check('…titled for that server', /Kelp Forest/.test(text));
const calls = await page.evaluate(() => window.__calls);
check('…and it really went to that server’s invites route', calls.some(c => /POST .*\/servers\/s-kelp\/invites$/.test(c)), JSON.stringify(calls));
await page.screenshot({ path: `${OUT}/invite-e2e-2-dialog.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 2) click away instead
await page.evaluate(() => { window.__inviteFor = undefined; window.__calls.length = 0; window.__reset(); });
await page.evaluate(() => window.__play('echo-everyone', { serverId: 's-kelp' }));
await page.waitForSelector('[data-testid="moment-action"]');
await page.waitForTimeout(6000);
await page.mouse.click(200, 200);
await page.waitForTimeout(300);
check('clicking away dismisses it', (await page.$('[data-moment]')) === null);
check('…and opens nothing', (await page.evaluate(() => window.__inviteFor)) === undefined && (await page.evaluate(() => window.__calls.length)) === 0);

await browser.close();
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASS');
process.exit(failures ? 1 : 0);
