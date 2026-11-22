// Store-unread recovery screens: real Chromium screenshots + behaviour/layout checks.
//   npx vite --config harness/store-unread.vite.config.ts   (serves :5331)
//   node harness/store-unread-shots.mjs                     (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5331/harness/store-unread.html';
const OUT = process.env.OUT ?? '/tmp/store-unread-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const SIZES = [
    { name: '1000x720', width: 1000, height: 720, dpr: 1 },
    { name: '1366x768', width: 1366, height: 768, dpr: 1 },
    { name: '1920x1080', width: 1920, height: 1080, dpr: 1 },
    { name: '1280x800@1.5', width: 1280, height: 800, dpr: 1.5 },
];
const THEMES = ['dark', 'light', 'midnight', 'hc-dark', 'hc-light', 'custom-rose'];

/** Every button and the last line fully on screen, nothing wider than the window. */
async function layoutOk(page, label) {
    const m = await page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const btns = [...document.querySelectorAll('button')].map(b => b.getBoundingClientRect());
        const se = document.scrollingElement;
        return {
            vw, vh,
            hOverflow: se.scrollWidth > vw + 1,
            offscreen: btns.filter(r => r.bottom > vh + 1 || r.right > vw + 1 || r.top < -1 || r.left < -1).length,
            buttons: btns.length,
        };
    });
    check(`${label}: no horizontal overflow, all ${m.buttons} buttons on screen`, !m.hOverflow && m.offscreen === 0, JSON.stringify(m));
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const size of SIZES) {
        const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.dpr });
        const page = await ctx.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
        const themes = size.name === '1000x720' ? THEMES : ['dark', 'light'];
        for (const theme of themes) {
            await page.goto(`${BASE}?scene=failed&platform=windows&theme=${theme}`);
            await page.waitForSelector('h1');
            await sleep(700);
            await layoutOk(page, `failed ${theme} ${size.name}`);
            await page.screenshot({ path: `${OUT}/read-failed-windows-${theme}-${size.name}.png` });
        }
        if (size.name === '1366x768') {
            for (const platform of ['mac', 'linux']) {
                for (const theme of ['dark', 'light']) {
                    await page.goto(`${BASE}?scene=failed&platform=${platform}&theme=${theme}`);
                    await page.waitForSelector('h1');
                    await sleep(500);
                    await page.screenshot({ path: `${OUT}/read-failed-${platform}-${theme}-${size.name}.png` });
                }
            }
            for (const theme of ['dark', 'light']) {
                await page.goto(`${BASE}?scene=opening&theme=${theme}`);
                await page.waitForSelector('h1');
                await sleep(500);
                await page.screenshot({ path: `${OUT}/opening-${theme}-${size.name}.png` });
            }
        }
        if (size.name === '1000x720' || size.name === '1366x768') {
            for (const theme of ['dark', 'light']) {
                await page.goto(`${BASE}?scene=shrink&theme=${theme}`);
                await page.waitForSelector('[role=dialog]');
                await sleep(900);
                await layoutOk(page, `shrink ${theme} ${size.name}`);
                await page.screenshot({ path: `${OUT}/shrink-confirm-${theme}-${size.name}.png` });
            }
        }
        await ctx.close();
    }

    // Behaviour.
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 720 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    const text = () => page.evaluate(() => document.body.innerText);

    for (const [platform, quit, folder] of [
        ['windows', 'tray icon', '%APPDATA%\\Cipherline'],
        ['mac', '⌘Q', '~/Library/Application Support/Cipherline'],
        ['linux', 'tray icon', '~/.config/Cipherline'],
    ]) {
        await page.goto(`${BASE}?scene=failed&platform=${platform}`);
        await page.waitForSelector('h1');
        const t = await text();
        check(`${platform}: quit-fully step, disk space, data folder, don't delete/reinstall`,
            t.includes(quit) && t.includes('free space') && t.includes(folder) && t.includes('reinstall'));
        check(`${platform}: no reset / start fresh / recovery key offered`, !/start (over|fresh)|reset|recovery key/i.test(t));
    }

    await page.goto(`${BASE}?scene=failed`);
    await page.waitForSelector('h1');
    await page.getByRole('button', { name: 'Restart and try again' }).click();
    await sleep(300);
    check('Restart and try again → relaunchApp exactly once', await page.evaluate(() => window.__relaunched) === 1);
    await page.getByRole('button', { name: 'Restarting' }).click({ force: true }).catch(() => {});
    await sleep(200);
    check('a second press while restarting does not relaunch twice', await page.evaluate(() => window.__relaunched) === 1);
    await page.getByRole('button', { name: 'Continue anyway' }).click();
    check('Continue anyway still works', await page.evaluate(() => window.__continued) === 1);

    await page.goto(`${BASE}?scene=shrink`);
    await page.waitForSelector('[role=dialog]');
    const t = await text();
    check('shrink: says what would be lost, both destinations', t.includes('0 conversations') && t.includes('48 conversations') && t.includes('Google Drive'));
    await sleep(400);
    check('shrink: the safe button ("Keep existing backup") has focus on open',
        (await page.evaluate(() => document.activeElement?.textContent ?? '')).includes('Keep existing backup'));
    await page.keyboard.press('Enter');
    await sleep(200);
    check('shrink: Enter keeps the existing backup', await page.evaluate(() => window.__decided) === false);
    await page.goto(`${BASE}?scene=shrink`);
    await page.waitForSelector('[role=dialog]');
    await sleep(400);
    await page.keyboard.press('Escape');
    await sleep(300);
    check('shrink: Esc keeps the existing backup', await page.evaluate(() => window.__decided) === false);
    await page.goto(`${BASE}?scene=shrink`);
    await page.waitForSelector('[role=dialog]');
    await page.getByRole('button', { name: 'Replace anyway' }).click();
    check('shrink: only a deliberate click on Replace anyway replaces', await page.evaluate(() => window.__decided) === true);
    await ctx.close();
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
