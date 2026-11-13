// "Share mine back" shots and keyboard checks against the REAL SafetyNumberEmbed.
//
//   npx vite --config harness/safety-share-back.vite.config.ts      (serves :5441)
//   node harness/safety-share-back-shots.mjs     (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5441/harness/safety-share-back.html';
const OUT = process.env.OUT ?? '/tmp/safety-share-back-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });

async function open(scene, viewport = { width: 560, height: 460 }) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(`${BASE}?scene=${scene}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector('.cl-sn-card');
    await page.waitForTimeout(500);
    return { ctx, page };
}
const shot = async (page, name) => {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${name}.png` });
};
const shareBtn = page => page.locator('.cl-sn-share button');
const focusInfo = page => page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, text: (a?.textContent ?? '').trim().slice(0, 60), cls: a?.className ?? '' };
});
const settle = async page => { await page.evaluate(() => window.__settle()); await page.waitForTimeout(350); };

// ── At rest, sending, sent ──────────────────────────────────────────────────
{
    const { ctx, page } = await open('receive');
    check('rest: button labelled', (await shareBtn(page).textContent()).includes('Share mine back'));
    check('rest: nothing sent just by rendering', await page.evaluate(() => window.__sends === 0 && !window.__settle));
    await shot(page, '1-receive-at-rest');
    const restHeight = (await page.locator('.cl-sn-card').boundingBox()).height;
    await shareBtn(page).click();
    await page.waitForTimeout(150);
    check('sending: busy and disabled', await shareBtn(page).isDisabled());
    const busyHeight = (await page.locator('.cl-sn-card').boundingBox()).height;
    check('sending: the card does not jump', Math.abs(busyHeight - restHeight) < 0.5, `${restHeight} vs ${busyHeight}`);
    await shot(page, '2-sending');
    await settle(page);
    check('sent: exactly one send', await page.evaluate(() => window.__sends === 1));
    check('sent: button gone', (await shareBtn(page).count()) === 0);
    check('sent: quiet line shown', (await page.locator('.cl-sn-shared').textContent()).includes('You shared yours'));
    check('sent: nothing marked verified', !(await page.locator('.cl-sn-card').textContent()).includes('verified'));
    await shot(page, '3-after-sending');
    await ctx.close();
}

// ── After a real match (the directory is stubbed at the network, the verdict is not) ─
{
    const { ctx, page } = await open('receive', { width: 560, height: 640 });
    const pub = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
    await page.route('**/keys/identity_keys*', r => r.request().method() === 'OPTIONS'
        ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
        : r.fulfill({ json: [{ device_id: 'd1', identity_key_pub_b64: pub }], headers: { 'access-control-allow-origin': '*' } }));
    await page.locator('.cl-sn-foot button', { hasText: 'Check this code' }).click();
    await page.waitForSelector('.cl-sn-result--ok');
    await page.waitForTimeout(1800);
    check('match: still offered', (await shareBtn(page).count()) === 1);
    check('match: the attestation step is untouched', (await page.locator('.cl-sn-attest').count()) === 1);
    await shot(page, '10-after-check-matched');
    await shareBtn(page).click();
    await settle(page);
    check('match + sent: still not verified', (await page.locator('.cl-sn-attest').count()) === 1 && !(await page.locator('.cl-sn-card').textContent()).includes('Marked verified'));
    await shot(page, '11-matched-then-sent');
    await ctx.close();
}

// ── Failed, then retry ──────────────────────────────────────────────────────
{
    const { ctx, page } = await open('receive');
    await page.evaluate(() => { window.__send = 'fail'; });
    await shareBtn(page).click();
    await settle(page);
    check('failed: error shown', (await page.locator('.cl-sn-share-error').textContent()).includes('Could not send'));
    check('failed: button usable', !(await shareBtn(page).isDisabled()));
    check('failed: no send happened', await page.evaluate(() => window.__sends === 0));
    await shot(page, '4-send-failed');
    await page.evaluate(() => { window.__send = 'ok'; });
    await shareBtn(page).click();
    await settle(page);
    check('retry: sent', await page.evaluate(() => window.__sends === 1));
    check('retry: error cleared', (await page.locator('.cl-sn-share-error').count()) === 0);
    await ctx.close();
}

// ── Keyboard ────────────────────────────────────────────────────────────────
{
    const { ctx, page } = await open('receive');
    await page.keyboard.press('Tab');
    const first = await focusInfo(page);
    await page.keyboard.press('Tab');
    const second = await focusInfo(page);
    check('keyboard: Check first, then Share mine back', first.text.includes('Check this code') && second.text.includes('Share mine back'), `${first.text} > ${second.text}`);
    await shot(page, '5-keyboard-focus');

    await page.evaluate(() => { window.__send = 'fail'; });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await settle(page);
    const afterFail = await focusInfo(page);
    check('keyboard: Enter sends, focus returns to the button after a failure', afterFail.tag === 'BUTTON' && afterFail.text.includes('Share mine back'), JSON.stringify(afterFail));

    await page.evaluate(() => { window.__send = 'ok'; });
    await page.keyboard.press('Space');
    await page.waitForTimeout(150);
    await settle(page);
    const afterSend = await focusInfo(page);
    check('keyboard: Space sends, focus lands on the sent line', String(afterSend.cls).includes('cl-sn-shared'), JSON.stringify(afterSend));
    await shot(page, '6-keyboard-after-sending');
    await ctx.close();
}

// ── Derived from the conversation; own card; narrow ─────────────────────────
{
    const { ctx, page } = await open('settled');
    check('reopen: quiet line with no button', (await shareBtn(page).count()) === 0 && (await page.locator('.cl-sn-shared').count()) === 1);
    await shot(page, '7-reopened-already-shared');
    await ctx.close();
}
{
    const { ctx, page } = await open('mine');
    check('own card: no button', (await page.locator('.cl-sn-share').count()) === 0);
    await shot(page, '8-own-sent-card');
    await ctx.close();
}
{
    const { ctx, page } = await open('receive&name=themostunreasonablylongusername32');
    const labelFits = await page.evaluate(() => {
        const c = document.querySelector('.cl-sn-share .cap');
        return c.scrollWidth <= c.clientWidth;
    });
    check('long name: label not clipped', labelFits);
    await shareBtn(page).click();
    await settle(page);
    const lineFits = await page.evaluate(() => {
        const card = document.querySelector('.cl-sn-card').getBoundingClientRect();
        const r = document.createRange();
        r.selectNodeContents(document.querySelector('.cl-sn-shared span'));
        return r.getBoundingClientRect().right <= card.right;
    });
    check('long name: the sent line wraps inside the card', lineFits);
    await shot(page, '9-long-name-after-sending');
    await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
