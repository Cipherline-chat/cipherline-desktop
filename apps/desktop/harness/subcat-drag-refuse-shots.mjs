// A sub-category dragged outside a category (owner, 2026-11-16): red preview
// mid-drag, a "Got it" dialog on release, and the valid-drop control.
// Real ServerChannelList + kit CSS via harness/subcat-list-main.tsx (scene=manager).
//
//   SCL_PORT=5287 npx vite --config harness/subcat-list.vite.config.ts   (another shell)
//   SCL_PORT=5287 node harness/subcat-drag-refuse-shots.mjs --shots=<dir>
//
// Shots: 01-red-line-over-top-channel, 02-red-zone-end-of-list,
//        03-refused-dialog, 04-valid-drop-green (control)
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.SCL_PORT ?? 5231;
const shots = arg('shots', '');
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

async function open(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${port}/harness/subcat-list.html?scene=manager`, { waitUntil: 'commit', timeout: 300000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 300000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
  await page.waitForTimeout(600);
  return page;
}
const FRAME = '#root > div > div';
const shot = async (page, name, sel) => {
  if (!shots) return;
  if (!sel) { await page.screenshot({ path: path.join(shots, `${name}.png`) }); return; }
  const box = await page.locator(sel).first().boundingBox();
  const pad = 14;
  await page.screenshot({ path: path.join(shots, `${name}.png`), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
};
const subHeader = (page, id) => page.locator(`[data-subcategory-id="${id}"] [role="button"]`).first();
const patches = (page) => page.evaluate(() => window.__requests.filter(r => r.method === 'PATCH'));
const state = (page) => page.evaluate(() => ({
  refusedLines: document.querySelectorAll('[data-drop-indicator="refused"]').length,
  okLines: document.querySelectorAll('[data-drop-indicator="ok"]').length,
  zone: document.querySelector('[data-drop-zone]')?.getAttribute('data-drop-zone') ?? null,
  htmlClass: document.documentElement.classList.contains('cl-drag-refused'),
  hint: document.querySelector('[data-testid="drag-refused-hint"]')?.textContent ?? null,
  lineColour: (() => { const l = document.querySelector('[data-drop-indicator] > div:last-child'); return l ? getComputedStyle(l).backgroundColor : null; })(),
}));
const cursorAt = (page, x, y) => page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? getComputedStyle(el).cursor : null; }, [x, y]);

async function startDrag(page, loc) {
  const b = await loc.boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + b.height / 2 - 12, { steps: 4 });
  await page.waitForTimeout(250); // the end-of-list zone opens once a drag starts
}

try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });

  // ── 1. Over an uncategorized channel: red drop line, ghost + hint, not-allowed ──
  let page = await open(ctx);
  await startDrag(page, subHeader(page, 'metal'));
  const general = await page.locator('[data-channel-id="general"]').boundingBox();
  const gx = general.x + general.width / 2, gy = general.y + general.height - 4;
  await page.mouse.move(gx, gy, { steps: 25 });
  await page.waitForTimeout(300);
  let s = await state(page);
  check('over #general: one RED drop line, no accent line', s.refusedLines === 1 && s.okLines === 0, JSON.stringify(s));
  check('the red line is the flash token (rgb(255, 107, 94))', s.lineColour === 'rgb(255, 107, 94)', s.lineColour);
  check('inline hint under the ghost', s.hint === 'Sub-categories go inside a category', s.hint);
  check('not-allowed cursor under the pointer', (await cursorAt(page, gx, gy)) === 'not-allowed', await cursorAt(page, gx, gy));
  await shot(page, '01-red-line-over-top-channel', FRAME);

  // ── 2. The end-of-list zone (the gap above the first category) ──
  const zone = await page.evaluate(() => {
    const el = document.querySelector('.custom-scrollbar > div.rounded-md.transition-colors');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
  });
  await page.mouse.move(zone.x, zone.y, { steps: 10 });
  await page.waitForTimeout(300);
  s = await state(page);
  check('over the end-of-list zone: zone drawn refused (red)', s.zone === 'refused' && s.htmlClass, JSON.stringify({ ...s, zone }));
  const zoneBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-drop-zone]')).backgroundColor);
  check('zone tint is the flash token at 10%', /rgba\(255, 107, 94, 0\.1\d*\)/.test(zoneBg), zoneBg);
  await shot(page, '02-red-zone-end-of-list', FRAME);

  // ── 3. Release: nothing moves, the dialog explains, Escape closes ──
  await page.mouse.up();
  await page.waitForTimeout(700);
  const dlg = page.locator('[role="dialog"]').first();
  check('release: a dialog opens', (await dlg.count()) === 1);
  const text = await dlg.innerText();
  check('dialog says sub-categories have to be under a category', /Sub-categories have to be under a category/.test(text), text.replace(/\n/g, ' | '));
  const btns = await dlg.locator('button').allInnerTexts();
  check('one "Got it" button only', JSON.stringify(btns.map(b => b.trim())) === '["Got it"]', JSON.stringify(btns));
  check('no PATCH was sent', (await patches(page)).length === 0);
  check('Metalwork is still inside Crafting', await page.locator('[data-subcategory-id="metal"]').count() === 1);
  check('cursor class cleared after release', !(await state(page)).htmlClass);
  await page.waitForTimeout(1500);
  check('still open 1.5 s later (not a toast)', (await page.locator('[role="dialog"]').count()) === 1);
  await shot(page, '03-refused-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  check('Escape closes it', (await page.locator('[role="dialog"]').count()) === 0);
  await page.close();

  // ── 4. Control: the same sub-category over a channel in Events = normal move ──
  page = await open(ctx);
  await startDrag(page, subHeader(page, 'metal'));
  const build = await page.locator('[data-channel-id="build-nights"]').boundingBox();
  await page.mouse.move(build.x + build.width / 2, build.y + build.height - 4, { steps: 25 });
  await page.waitForTimeout(300);
  s = await state(page);
  check('control: over #build-nights the line is the accent, not red', s.okLines === 1 && s.refusedLines === 0 && !s.htmlClass && s.hint === null, JSON.stringify(s));
  check('control: accent colour (rgb(37, 224, 200))', s.lineColour === 'rgb(37, 224, 200)', s.lineColour);
  await shot(page, '04-valid-drop-green', FRAME);
  await page.mouse.up();
  await page.waitForTimeout(600);
  check('control: one PATCH, no dialog', (await patches(page)).length === 1 && (await page.locator('[role="dialog"]').count()) === 0);
  await page.close();
} finally {
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
