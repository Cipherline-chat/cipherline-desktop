// Lock screen during boot: screenshots + facts (harness/lockscreen-boot-main.tsx).
//   npx vite --config harness/lockscreen-boot.vite.config.ts      (serves :5231)
//   node harness/lockscreen-boot-shots.mjs                        (env: OUT=<dir> BASE PW_CHROMIUM_EXE)
// Launches (and closes) its OWN headless browser; nothing is left running.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5231/harness/lockscreen-boot.html';
const OUT = process.env.OUT ?? '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => console.log('pageerror', e.message));
    await page.goto(BASE);
    await page.waitForFunction(() => window.__lb?.phase === 'app', null, { timeout: 15000 });
    await sleep(Number(process.env.WAIT ?? 1500)); // let the lock's field fade in (700 ms) and the worker draw
    const facts = await page.evaluate(() => {
        const lock = [...document.querySelectorAll('h1')].find(h => /locked/.test(h.textContent));
        const lockRoot = lock?.closest('div[style*="999999"]');
        const r = lockRoot?.getBoundingClientRect();
        const covering = document.elementFromPoint(640, 400);
        return {
            isLocked: window.__lb.isLocked,
            lockPresent: !!lockRoot,
            lockCoversViewport: !!r && r.width >= innerWidth && r.height >= innerHeight,
            topElementAtCentreInsideLock: !!lockRoot?.contains(covering),
            lockBackground: lockRoot ? getComputedStyle(lockRoot).backgroundImage + ' / ' + getComputedStyle(lockRoot).backgroundColor : null,
            canvases: document.querySelectorAll('canvas').length,
            loadingRootsInDom: document.querySelectorAll('.lo-root').length,
            secretInDom: document.body.textContent.includes('SECRET-DM-CONTENT'),
        };
    });
    console.log(JSON.stringify(facts, null, 2));
    await page.screenshot({ path: `${OUT}/lockscreen-boot.png` });

    // Real-browser reachability: with the lock up, Tab / typing / clicking must never reach the app.
    const inert = await page.evaluate(() => ({
        dashboardContentInert: !!document.getElementById('composer')?.closest('[inert]'),
        portalInert: !!document.getElementById('portal-ok')?.closest('[inert]'),
        lockInert: !!document.querySelector('[data-screen-lock]')?.closest('[inert]'),
        activeIsPinInput: document.activeElement?.tagName === 'INPUT' && !!document.activeElement.closest('[data-screen-lock]'),
    }));
    let escaped = 0;
    for (let i = 0; i < 25; i++) {
        await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
        escaped += await page.evaluate(() => (document.activeElement?.closest('[data-screen-lock]') ? 0 : 1));
    }
    await page.keyboard.type('hello');
    await page.mouse.click(300, 300);
    await page.keyboard.type('x');
    const after = await page.evaluate(() => ({
        composerValue: document.getElementById('composer').value,
        activeInsideLock: !!document.activeElement?.closest('[data-screen-lock]'),
    }));
    console.log(JSON.stringify({ inert, tabPressesThatLeftTheLock: escaped, ...after }, null, 2));

    if (process.env.UNLOCK === '1') {
        await page.evaluate(() => window.__lb.settleAll());
    }
} finally {
    await browser.close();
}
