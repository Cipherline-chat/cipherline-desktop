// See fullscreen-own-share.vite.config.ts. Screenshots and real-pointer checks of the fullscreen
// call view with your own share in it. Window blur here is a dispatched event, not a real one.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome`;
const BASE = process.env.BASE ?? 'http://127.0.0.1:5498/harness/fullscreen-own-share.html';
const OUT = process.env.OUT ?? '/tmp/fullscreen-own-share';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open(query = '') {
    const page = await ctx.newPage();
    page.setDefaultTimeout(120_000);
    page.on('pageerror', e => console.log('pageerror ' + e.message.slice(0, 400)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_|Network Error|AxiosError/.test(m.text())) console.log('console.error: ' + m.text().slice(0, 300)); });
    await page.goto(BASE + query);
    await page.waitForFunction(() => window.H && window.H.fullscreen);
    await page.evaluate(() => window.H.fullscreen(true));
    await page.waitForFunction(() => [...document.querySelectorAll('video')].filter(v => v.videoWidth > 0).length >= 2);
    await sleep(700);
    return page;
}
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const tiles = page => page.evaluate(() => [...document.querySelectorAll('video')].map(v => {
    const r = v.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), vw: v.videoWidth };
}));
/** Where a video of this intrinsic width sits, for a real pointer. */
const centre = async (page, vw) => {
    const t = (await tiles(page)).find(v => v.vw === vw);
    return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
};
const OWN = 1920, BOB = 2560, AMY = 1280;
const rightClick = async (page, vw) => {
    const c = await centre(page, vw);
    await page.mouse.move(c.x, c.y);
    await page.mouse.click(c.x, c.y, { button: 'right' });
    await page.waitForSelector('.ctxm');
    await sleep(350);
};
const menuRows = page => page.evaluate(() => [...document.querySelectorAll('.ctxm [role^="menuitem"]')].map(e => e.textContent));
const clickRow = (page, label) => page.locator('.ctxm [role^="menuitem"]', { hasText: label }).click();
const state = page => page.evaluate(() => ({ ...window.H.state(), fs: !!document.fullscreenElement, active: document.activeElement?.className ?? '', strip: !!document.querySelector('[aria-label="Call participants"]'), title: !!document.querySelector('.cl-fs-titlestrip'), paused: document.body.textContent.includes('Preview paused') }));

// ── Own share on the stage ──────────────────────────────────────────────────
let page = await open();
let vs = await tiles(page);
check('grid: bob, own share and amy all on stage', vs.length === 3, JSON.stringify(vs.map(v => v.vw)));
await shot(page, '01-own-share-in-grid');

await rightClick(page, OWN);
let rows = await menuRows(page);
check('own share menu is exactly Fill and Hide', JSON.stringify(rows) === JSON.stringify(['Fill Entire Screen', 'Hide Screen Share']), JSON.stringify(rows));
await shot(page, '02-own-share-right-click-menu');
await page.keyboard.press('Escape');
await sleep(150);
check('Escape closes the menu and nothing else', (await state(page)).fullscreen && !(await page.$('.ctxm')));

await rightClick(page, AMY);
rows = await menuRows(page);
check('remote menu keeps its rows and gains Fill', rows.includes('Fill Entire Screen') && rows.includes('Mute'), JSON.stringify(rows));
await shot(page, '03-remote-camera-right-click-menu');
await page.keyboard.press('Escape');
await sleep(100);

// A focus underneath: the strip has own share in it.
await page.evaluate(() => window.H.focus('bob'));
await sleep(600);
await shot(page, '04-own-share-in-strip');

// ── Fill ────────────────────────────────────────────────────────────────────
await rightClick(page, BOB);
await clickRow(page, 'Fill Entire Screen');
await sleep(900);
let s = await state(page);
vs = await tiles(page);
check('fill: one video, no strip, no title strip', vs.length === 1 && !s.strip && !s.title, JSON.stringify({ vs, s }));
check('fill: took the OS window fullscreen', s.fs);
check('fill: the video box is the whole viewport', vs[0].w === 1600 && vs[0].h === 900 && vs[0].x === 0 && vs[0].y === 0, JSON.stringify(vs[0]));
check('fill: keyboard focus is on the stage', /cl-fs-fill/.test(s.active), s.active);
await shot(page, '05-fill-awake-console-showing');
await sleep(4200);
await shot(page, '06-fill-idle-nothing-over-it');
const idleOpacity = await page.evaluate(() => getComputedStyle(document.getElementById('call-fullscreen-controls-root')).opacity);
check('fill: console idles out', idleOpacity === '0', idleOpacity);

await page.mouse.move(400, 300);
await sleep(300);
await rightClick(page, BOB);
rows = await menuRows(page);
check('fill: the same item now says Exit', rows.includes('Exit Fill Screen') && !rows.includes('Fill Entire Screen'), JSON.stringify(rows));
await shot(page, '07-fill-menu-exit');
await clickRow(page, 'Exit Fill Screen');
await sleep(600);
s = await state(page);
check('Exit returns to the focus layout, fullscreen still up', s.fullscreen && s.strip && !s.fs && s.focused?.identity === 'bob', JSON.stringify(s));

await rightClick(page, AMY);
const menuBottom = await page.evaluate(() => document.querySelector('.ctxm').getBoundingClientRect().bottom);
check('a menu opened from the strip stays on screen', menuBottom <= 900, String(menuBottom));
await clickRow(page, 'Fill Entire Screen');
await sleep(600);
vs = await tiles(page);
check('a strip thumbnail can fill too', vs.length === 1 && vs[0].vw === AMY, JSON.stringify(vs));
await shot(page, '08-fill-camera');

await page.keyboard.press('Escape');
await sleep(600);
s = await state(page);
check('Escape steps back one level: strip back, still fullscreen', s.fullscreen && s.strip && !s.fs, JSON.stringify(s));
await page.keyboard.press('Escape');
await sleep(600);
s = await state(page);
check('second Escape leaves fullscreen', !s.fullscreen, JSON.stringify(s));
await page.close();

// ── A fill across a republish and a real end ────────────────────────────────
page = await open();
await rightClick(page, BOB);
await clickRow(page, 'Fill Entire Screen');
await sleep(500);
await page.evaluate(() => window.H.setBob(false));
await sleep(400);
await shot(page, '09-fill-stream-dropped-grace');
s = await state(page);
check('stream dropped: inside the grace the fill holds', !s.strip && /cl-fs-fill/.test(await page.evaluate(() => document.querySelector('.cl-fs-fill')?.className ?? '')));
await page.evaluate(() => window.H.setBob(true));
await sleep(1800);
vs = await tiles(page);
check('stream back inside the grace: still filling, with a picture', vs.length === 1 && vs[0].vw === BOB, JSON.stringify(vs));
await page.evaluate(() => window.H.setBob(false));
await sleep(1800);
s = await state(page);
vs = await tiles(page);
check('stream really ended: stepped back, fullscreen still up', s.fullscreen && !s.fs && vs.length === 2, JSON.stringify({ s, vs }));
await page.evaluate(() => window.H.setBob(true));
await sleep(500);
await page.close();

// ── Paused ──────────────────────────────────────────────────────────────────
page = await open();
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await sleep(400);
s = await state(page);
vs = await tiles(page);
check('blur event: own preview paused, the rest keep playing', s.paused && vs.length === 2 && !vs.some(v => v.vw === OWN), JSON.stringify(vs));
await shot(page, '10-paused-in-grid');
await page.evaluate(() => window.H.focus('me'));
await sleep(500);
await shot(page, '11-paused-focused');
await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.H.focus(null); });
await sleep(500);
s = await state(page);
check('focus event: preview back', !s.paused && (await tiles(page)).length === 3);
await rightClick(page, OWN);
await clickRow(page, 'Fill Entire Screen');
await sleep(600);
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await sleep(400);
await shot(page, '12-paused-filling');
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await sleep(300);
await page.keyboard.press('Escape');
await sleep(400);

// ── Hidden and the way back ─────────────────────────────────────────────────
await rightClick(page, OWN);
await clickRow(page, 'Hide Screen Share');
await sleep(500);
s = await state(page);
vs = await tiles(page);
check('hide: no own tile, the rest stay', vs.length === 2 && !vs.some(v => v.vw === OWN) && s.hidden.includes('me'), JSON.stringify(vs));
await shot(page, '13-own-share-hidden');
// The name pill lets the pointer through; the card's cell is what a person right-clicks.
const cell = await page.evaluate(() => {
    const name = [...document.querySelectorAll('span')].find(e => e.textContent === 'Dawson');
    const r = name.closest('.rounded-xl').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(cell.x, cell.y, { button: 'right' });
await page.waitForSelector('.ctxm');
await sleep(350);
rows = await menuRows(page);
check('way back 1: right-click your own card offers Show', JSON.stringify(rows) === JSON.stringify(['Show Screen Share']), JSON.stringify(rows));
await shot(page, '14-hidden-way-back-card-menu');
await clickRow(page, 'Show Screen Share');
await sleep(500);
check('Show brings the tile back', (await tiles(page)).some(v => v.vw === OWN));

await rightClick(page, OWN);
await clickRow(page, 'Hide Screen Share');
await sleep(400);
await page.locator('.cl-share-chev').click();
await sleep(500);
await shot(page, '15-hidden-way-back-share-menu');
const previewRow = await page.evaluate(() => {
    const row = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Show My Preview')).getBoundingClientRect();
    const hit = document.elementFromPoint(row.x + row.width / 2, row.bottom - 4);
    return hit?.closest('button')?.textContent ?? '';
});
check('the share menu is not under the console', previewRow.includes('Show My Preview'), previewRow);
await page.getByText('Show My Preview').click();
await sleep(500);
check('way back 2: the share menu brings it back', (await tiles(page)).some(v => v.vw === OWN));
await page.close();

// ── Your camera tile, while your share is hidden ────────────────────────────
page = await open('?mycam=1');
await sleep(300);
await rightClick(page, OWN);
await clickRow(page, 'Hide Screen Share');
await sleep(500);
await rightClick(page, AMY); // Close any doubt about which tile: amy and my camera share a width.
await page.keyboard.press('Escape');
await sleep(150);
const camTiles = (await tiles(page)).filter(v => v.vw === AMY);
await page.mouse.click(camTiles[0].x + camTiles[0].w / 2, camTiles[0].y + camTiles[0].h / 2, { button: 'right' });
await page.waitForSelector('.ctxm');
await sleep(300);
rows = await menuRows(page);
check('way back 3: your camera tile offers Fill and Show', JSON.stringify(rows) === JSON.stringify(['Fill Entire Screen', 'Show Screen Share']), JSON.stringify(rows));
await page.close();

await browser.close();
const failed = results.filter(r => !r).length;
console.log(`${results.length - failed}/${results.length} checks passed. Screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
