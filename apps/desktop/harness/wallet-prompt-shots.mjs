// Linux wallet prompt screens: real Chromium screenshots + behaviour checks.
//   npx vite --config harness/wallet-prompt.vite.config.ts   (serves :5312)
//   node harness/wallet-prompt-shots.mjs                     (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5312/harness/wallet-prompt.html';
const OUT = process.env.OUT ?? '/tmp/wallet-prompt-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    const text = () => page.evaluate(() => document.body.innerText);

    for (const scene of ['existing', 'first', 'gnome', 'recovery', 'generic', 'banner']) {
        await page.goto(`${BASE}?scene=${scene}`);
        await page.waitForSelector(scene === 'banner' ? '[data-testid=keyring-wallet-banner]' : 'h1');
        if (scene === 'recovery') { await page.getByText('Use my recovery key').click(); await page.waitForSelector('textarea'); }
        await sleep(700);
        const t = await text();
        if (scene === 'existing' || scene === 'recovery') {
            check(`${scene}: says the wallet could not be opened, names KDE Wallet`, t.includes('couldn’t open your wallet') && t.includes('KDE Wallet'));
            check(`${scene}: says existing messages and keys can't be opened and would be lost`, t.includes('already on this device can’t be opened') && t.includes('would be lost'));
            check(`${scene}: has Try again and Use my recovery key, and NO Start fresh`, t.includes('Try again') && (scene === 'recovery' || t.includes('Use my recovery key')) && !/Start fresh|Erase/.test(t));
        }
        if (scene === 'first') {
            check('first: nothing is lost yet, but keys created now would not be protected', t.includes('nothing is lost') && t.includes('wouldn’t be protected') && !t.includes('would be lost'));
        }
        if (scene === 'gnome') check('gnome: names GNOME Keyring, not KDE', t.includes('GNOME Keyring') && !t.includes('KDE'));
        if (scene === 'generic') check('generic: the old locked screen is unchanged (recovery key + Start fresh, no wallet wording)', t.includes('Storage couldn’t be unlocked') && t.includes('Start fresh') && !t.includes('wallet'));
        if (scene === 'banner') {
            check('banner: warning tone, names the wallet, Unlock wallet action', t.includes('KDE Wallet is locked') && t.includes('Unlock wallet'));
            const tone = await page.locator('[data-testid=keyring-wallet-banner]').first().evaluate(el => (el.closest('[data-banner-tone]') ?? el.querySelector('[data-banner-tone]'))?.getAttribute('data-banner-tone') ?? '');
            check('banner: tone is warning', tone === 'warning', tone);
        }
        await page.screenshot({ path: `${OUT}/wallet-${scene}.png` });
    }

    // Try again calls the retry bridge once and shows a busy state.
    await page.goto(`${BASE}?scene=existing`);
    await page.waitForSelector('h1');
    await page.getByRole('button', { name: 'Try again' }).click();
    await sleep(300);
    check('Try again invokes retryKeyringUnlock exactly once', await page.evaluate(() => window.__retried) === 1);

    // Banner: dismiss hides it for the session; Unlock wallet retries.
    await page.goto(`${BASE}?scene=banner`);
    await page.waitForSelector('[data-testid=keyring-wallet-banner]');
    await page.getByRole('button', { name: 'Unlock wallet' }).click();
    await sleep(300);
    check('banner: Unlock wallet invokes retryKeyringUnlock', await page.evaluate(() => window.__retried) === 1);
    await page.getByRole('button', { name: /Dismiss until next launch/ }).click();
    await sleep(500);
    check('banner: dismiss hides it for this session', await page.locator('[data-testid=keyring-wallet-banner]').count() === 0);
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
