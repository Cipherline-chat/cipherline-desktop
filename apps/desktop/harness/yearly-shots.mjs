// Yearly-plan screenshots (checkout toggle, Settings switch confirms, pending, upsells) in real Chromium.
//   npx vite --config harness/checkout-layout.vite.config.ts      (:5251)
//   npx vite --config harness/trial-prompt.vite.config.ts         (:5317)
//   OUT=<dir> node harness/yearly-shots.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const CK = process.env.CK ?? 'http://127.0.0.1:5251/harness/checkout-layout.html';
const TP = process.env.TP ?? 'http://127.0.0.1:5317/harness/trial-prompt.html';
const OUT = process.env.OUT ?? '/tmp/yearly-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 860 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(150000);
    page.on('pageerror', (e) => { failures++; console.log('FAIL  pageerror ' + e.message); });

    // ---- checkout: yearly founder, yearly regular ----
    for (const [plans, name] of [['founder', 'desktop-checkout-yearly-founder'], ['regular', 'desktop-checkout-yearly-regular']]) {
        await page.setViewportSize({ width: 1100, height: 860 });
        await page.goto(`${CK}?plans=${plans}`);
        await page.waitForSelector('[data-testid="stripe-stub"]');
        await page.evaluate(() => document.fonts.ready);
        await sleep(2000);
        check(`${plans}: picker shown, Monthly selected`, await page.locator('[data-testid="interval-month"][aria-checked="true"]').count() === 1);
        await page.locator('[data-testid="interval-year"]').click();
        await sleep(900);
        const t = await page.evaluate(() => document.body.innerText);
        check(`${plans}: renewal text says every year`, /renews automatically every year at \$(30\.00|49\.99)/.test(t));
        check(`${plans}: badge ${plans === 'regular' ? 'present' : 'absent'}`, (await page.locator('[data-testid="interval-badge"]').count()) === (plans === 'regular' ? 1 : 0));
        check(`${plans}: Pay says /yr`, /Pay \$[\d.]+\/yr/.test(t));
        check(`${plans}: consent cleared`, !(await page.locator('[data-testid="renewal-consent-checkbox"]').isChecked()));
        await page.screenshot({ path: `${OUT}/${name}.png` });
        console.log(`SHOT  ${OUT}/${name}.png`);
    }
    // narrow window too (checks the picker fits)
    await page.setViewportSize({ width: 560, height: 900 });
    await page.goto(`${CK}?plans=regular`);
    await page.waitForSelector('[data-testid="stripe-stub"]');
    await sleep(2000);
    await page.locator('[data-testid="interval-year"]').click();
    await sleep(700);
    await page.screenshot({ path: `${OUT}/desktop-checkout-yearly-regular-narrow.png` });

    // ---- Settings: switch confirms + pending ----
    await page.setViewportSize({ width: 1100, height: 1100 });
    const settings = async (who, click, name, waitSel) => {
        await page.goto(`${TP}?scene=billing&who=${who}`);
        await page.waitForSelector('[data-testid="interval-switch"]');
        await sleep(1200);
        if (click) {
            await page.locator('[data-testid="interval-switch-open"] button').click();
            await page.waitForSelector(waitSel);
            await sleep(500);
        }
        const h = await page.evaluate(() => Math.min(document.querySelector('section').getBoundingClientRect().bottom + 24, 1100));
        await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: 1100, height: h } });
        console.log(`SHOT  ${OUT}/${name}.png`);
        return page.evaluate(() => document.body.innerText);
    };
    let t = await settings('monthly-regular', true, 'desktop-switch-confirm-monthly-to-yearly', '[data-testid="interval-confirm-line"]');
    check('m->y confirm copy', /charged \$24\.00 today \(prorated credit for the unused part of this month applied\), then \$49\.99\/yr \+ tax from /.test(t));
    t = await settings('yearly-founder', true, 'desktop-switch-confirm-yearly-to-monthly', '[data-testid="interval-confirm-line"]');
    check('y->m confirm copy', /switches to monthly on .* \(the end of the year you've paid for\)\. Nothing changes today and there is no refund\. You keep your founding price\./.test(t));
    t = await settings('yearly-pending', false, 'desktop-pending-switch');
    check('pending line + Undo', /Switches to monthly on /.test(t) && /Undo/.test(t));

    // ---- upsells ----
    await page.setViewportSize({ width: 1100, height: 860 });
    await page.goto(`${TP}?scene=upgrade&prices=regular`);
    await page.waitForSelector('[data-testid="upgrade-yearly"]');
    await sleep(1200);
    await page.screenshot({ path: `${OUT}/desktop-upgrade-prompt.png` });
    await page.goto(`${TP}?scene=prompt&founder=open&days=2&yearly=founder`);
    await page.waitForSelector('[data-testid="trial-prompt-yearly"]');
    await sleep(1400);
    await page.screenshot({ path: `${OUT}/desktop-trial-prompt.png` });
    await page.goto(`${TP}?scene=prompt&founder=closed&days=2&yearly=regular`);
    await page.waitForSelector('[data-testid="trial-prompt-yearly"]');
    await sleep(1400);
    await page.screenshot({ path: `${OUT}/desktop-trial-prompt-regular.png` });
    await ctx.close();
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL OK');
process.exit(failures ? 1 : 0);
