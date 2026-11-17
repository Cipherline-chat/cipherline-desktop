// Header "+" menus, blank-space menu, header centring and the Calls panel dividers
// (harness/subcat-list-main.tsx scenes manager / member / calls).
//
//   SCL_PORT=5231 npx vite --config harness/subcat-list.vite.config.ts   (another shell)
//   SCL_PORT=5231 node harness/subcat-menus-shots.mjs --shots=<dir>
//
// Shots: 25-category-plus-menu, 26-subcategory-plus-menu, 27-headers-centred-100/125/150,
//        28-blank-space-menu-no-subcategory, 29-calls-panel-dividers, 30-calls-panel-divider-drag
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.SCL_PORT ?? 5231;
const shots = arg('shots', '');
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

async function open(ctx, query) {
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${port}/harness/subcat-list.html?${query}`, { waitUntil: 'commit', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
  await page.waitForTimeout(600);
  return page;
}
const clip = async (page, name, box, pad = 14) => {
  if (!shots) return;
  await page.screenshot({ path: path.join(shots, `${name}.png`), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
};
const menuItems = (page) => page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim()));
const catHeader = (page, name) => page.locator('[role="button"][aria-expanded]').filter({ hasText: name }).first();
const subHeader = (page, id) => page.locator(`[data-subcategory-id="${id}"] [role="button"]`).first();

try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 });

  // ── "+" menus + blank-space menu ──────────────────────────────────────
  let page = await open(ctx, 'scene=manager');
  await catHeader(page, 'Crafting').hover();
  await page.waitForTimeout(250);
  await catHeader(page, 'Crafting').locator('button[aria-label="Add to this category"]').click();
  await page.waitForTimeout(300);
  let items = await menuItems(page);
  check('category "+" menu: Create Channel, Add Divider, Create Sub-category', JSON.stringify(items) === JSON.stringify(['Create Channel', 'Add Divider', 'Create Sub-category']), JSON.stringify(items));
  const plusBox = await catHeader(page, 'Crafting').locator('button[aria-label="Add to this category"]').boundingBox();
  const menuBox = await page.locator('[role="menu"]').first().boundingBox();
  check('category "+" menu is anchored to the button', Math.abs(menuBox.x - plusBox.x) < 24 && menuBox.y >= plusBox.y + plusBox.height - 2 && menuBox.y < plusBox.y + plusBox.height + 24, JSON.stringify({ plusBox, menuBox }));
  await clip(page, '25-category-plus-menu', { x: plusBox.x - 200, y: plusBox.y - 20, width: 330, height: 190 });
  // keyboard: arrows move, Escape closes
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('category "+" menu closes on Escape', (await page.locator('[role="menu"]').count()) === 0);
  // Enter on the focused button opens it too
  await catHeader(page, 'Crafting').locator('button[aria-label="Add to this category"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  check('category "+" opens with Enter', (await page.locator('[role="menu"]').count()) === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // "Create Sub-category" from the "+" menu preselects the category
  await catHeader(page, 'Crafting').hover();
  await catHeader(page, 'Crafting').locator('button[aria-label="Add to this category"]').click();
  await page.waitForTimeout(250);
  await page.locator('[role="menuitem"]', { hasText: 'Create Sub-category' }).click();
  await page.waitForTimeout(700);
  const dlg = await page.locator('[role="dialog"]').first().innerText();
  check('"+" > Create Sub-category opens the dialog sitting in that category', /in crafting/i.test(dlg), dlg.slice(0, 80));
  check('sub-category dialog: no top-level choice (no "Top level" option anywhere)', !/top level/i.test(dlg));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await subHeader(page, 'wood').hover();
  await page.waitForTimeout(250);
  await subHeader(page, 'wood').locator('button[aria-label="Add to this sub-category"]').click();
  await page.waitForTimeout(300);
  items = await menuItems(page);
  check('sub-category "+" menu: Create Channel, Add Divider only', JSON.stringify(items) === JSON.stringify(['Create Channel', 'Add Divider']), JSON.stringify(items));
  const sBox = await subHeader(page, 'wood').locator('button[aria-label="Add to this sub-category"]').boundingBox();
  await clip(page, '26-subcategory-plus-menu', { x: sBox.x - 200, y: sBox.y - 20, width: 330, height: 150 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // blank-space menu
  await page.locator('[tabindex="-1"].custom-scrollbar').evaluate(el => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 140, clientY: r.bottom - 20 }));
  });
  await page.waitForTimeout(300);
  items = await menuItems(page);
  check('blank-space menu: Channel / Category / Divider - NO sub-category', JSON.stringify(items) === JSON.stringify(['Create Channel', 'Create Category', 'Add Divider']), JSON.stringify(items));
  await clip(page, '28-blank-space-menu-no-subcategory', (await page.locator('[role="menu"]').first().boundingBox()), 60);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // the category's own right-click menu still offers it; a sub-category's does not
  await catHeader(page, 'Crafting').click({ button: 'right' });
  await page.waitForTimeout(250);
  check('category right-click menu still offers Create Sub-category Here', (await menuItems(page)).includes('Create Sub-category Here'));
  await page.keyboard.press('Escape');
  await page.close();

  // ── Header centring at 100 / 125 / 150% ───────────────────────────────
  for (const dsf of [1, 1.25, 1.5]) {
    const c2 = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: dsf });
    const pg = await open(c2, 'scene=manager');
    for (const [label, loc] of [['category', catHeader(pg, 'Crafting')], ['sub-category', subHeader(pg, 'wood')]]) {
      await loc.hover();
      await pg.waitForTimeout(300);
      const m = await loc.evaluate((row) => {
        const rr = row.getBoundingClientRect();
        const mid = (r) => r.top + r.height / 2;
        const out = { row: mid(rr) };
        const chev = row.querySelector('svg'); out.chevron = mid(chev.getBoundingClientRect());
        const text = row.querySelector('span.truncate'); out.text = mid(text.getBoundingClientRect());
        const btns = [...row.querySelectorAll('button')]; out.buttons = btns.map(b => { const r = b.getBoundingClientRect(); return { mid: mid(r), w: r.width, h: r.height }; });
        out.btnIcons = btns.map(b => mid(b.querySelector('svg').getBoundingClientRect()));
        return out;
      });
      const tol = 0.51;
      check(`headers @${dsf}x ${label}: chevron / text box / buttons / button glyphs share the row's centre line`,
        Math.abs(m.chevron - m.row) <= tol && Math.abs(m.text - m.row) <= tol && m.buttons.every(b => Math.abs(b.mid - m.row) <= tol) && m.btnIcons.every(b => Math.abs(b - m.row) <= tol), JSON.stringify(m));
      check(`headers @${dsf}x ${label}: "+" and "..." are equal-sized squares`, m.buttons.length === 2 && m.buttons.every(b => b.w === b.h && b.w === m.buttons[0].w), JSON.stringify(m.buttons));
      // Ink: the label's glyph rows vs the row's middle (pixel level)
      const png = await loc.screenshot();
      const ink = await pg.evaluate(async ({ b64, dsf }) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data;
        const lum = (x, y) => { const i = (y * c.width + x) * 4; return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; };
        // sample columns in the label area (after the chevron/icon), skip the hover buttons on the right
        const xa = Math.floor(c.width * 0.18), xb = Math.floor(c.width * 0.5);
        const bg = lum(2, 2);
        const rows = []; for (let y = 0; y < c.height; y++) { for (let x = xa; x < xb; x++) { if (Math.abs(lum(x, y) - bg) > 40) { rows.push(y); break; } } }
        return { top: rows[0], bottom: rows[rows.length - 1], h: c.height };
      }, { b64: png.toString('base64'), dsf });
      const inkMid = (ink.top + ink.bottom) / 2, rowMid = ink.h / 2;
      // Lower-case names have descenders/ascenders; a 1.5 device-px budget keeps it honest but not brittle.
      check(`headers @${dsf}x ${label}: label ink centred on the row (within 1.5 device px)`, Math.abs(inkMid - rowMid) <= 1.5 * Math.max(1, dsf), JSON.stringify({ ...ink, inkMid, rowMid }));
    }
    if (dsf === 1 || dsf === 1.25 || dsf === 1.5) {
      await catHeader(pg, 'Crafting').hover();
      const box = await pg.locator('[data-subcategory-id="wood"]').first().boundingBox();
      const cb = await catHeader(pg, 'Crafting').boundingBox();
      await clip(pg, `27-headers-centred-${Math.round(dsf * 100)}`, { x: cb.x, y: cb.y, width: cb.width, height: box.y + 40 - cb.y }, 10);
    }
    await pg.close(); await c2.close();
  }

  // ── Calls panel dividers ──────────────────────────────────────────────
  page = await open(ctx, 'scene=calls&member=1');
  let seps = await page.evaluate(() => [...document.querySelectorAll('[role="separator"]')].map(e => e.getAttribute('aria-label')));
  check('calls (member): header + line dividers drawn, text-list divider NOT, trailing pill hidden', JSON.stringify(seps) === JSON.stringify(['Section: After hours', 'Divider']), JSON.stringify(seps));
  check('calls (member): dividers inert', await page.locator('[role="separator"][tabindex]').count() === 0);
  await page.close();

  page = await open(ctx, 'scene=calls');
  seps = await page.evaluate(() => [...document.querySelectorAll('[role="separator"]')].map(e => e.getAttribute('aria-label')));
  check('calls (manager): trailing divider shown, marked hidden-from-members, text-list divider still absent', seps.includes('Section: Nothing below') && !seps.some(x => /TEXT LIST/.test(x ?? '')), JSON.stringify(seps));
  check('calls (manager): trailing divider has the eye-off mark and full opacity',
    await page.locator('[data-divider-id="c-trail"] [data-testid="divider-hidden-mark"]').count() === 1
    && Number(await page.locator('[data-divider-id="c-trail"]').evaluate(e => getComputedStyle(e).opacity)) === 1);
  const hit = await page.evaluate(() => [...document.querySelectorAll('[role="separator"]')].map(e => e.getBoundingClientRect().height));
  check('calls (manager): every divider row >= 24px', hit.every(h => h >= 24 - 0.01), JSON.stringify(hit));
  await page.locator('[data-calls-divider-id="c-chill"]').hover();
  await page.mouse.move(2, 2);
  const panel = await page.locator('#root > div > div').first().boundingBox();
  await clip(page, '29-calls-panel-dividers', panel, 6);

  // header "+" menu and category menu in the Calls panel: no sub-category anywhere
  const hang = page.locator('.group', { hasText: 'Hangouts' }).first();
  await hang.hover();
  await hang.locator('button[aria-label="Add to this category"]').click();
  await page.waitForTimeout(300);
  items = await menuItems(page);
  check('calls "+" menu: Create Calls Channel, Add Divider - no sub-category', JSON.stringify(items) === JSON.stringify(['Create Calls Channel', 'Add Divider']), JSON.stringify(items));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  const hb = await hang.boundingBox();
  await page.mouse.click(hb.x + 60, hb.y + hb.height / 2, { button: 'right' });
  await page.waitForTimeout(350);
  items = await menuItems(page);
  check('calls category menu has Add Divider Here and no sub-category', items.includes('Add Divider Here') && !items.some(i => /sub-category/i.test(i)), JSON.stringify(items));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const content = await page.locator('div.px-2.pb-3.space-y-4').first().boundingBox();
  await page.mouse.click(content.x + 3, content.y + content.height / 2, { button: 'right' });
  await page.waitForTimeout(350);
  items = await menuItems(page);
  check('calls blank-space menu: Create Calls Category + Add Divider', items.includes('Add Divider') && items.includes('Create Calls Category') && !items.some(i => /sub-category/i.test(i)), JSON.stringify(items));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Drag the "After hours" divider below "games" (same category).
  const src = await page.locator('[data-calls-divider-id="c-chill"] [role="separator"]').boundingBox();
  const over = await page.locator('[data-channel-id="games"]').boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 + 12, { steps: 4 });
  await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2 + 6, { steps: 10 });
  await page.waitForTimeout(300);
  await clip(page, '30-calls-panel-divider-drag', panel, 6);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const reqs = await page.evaluate(() => window.__requests.filter(r => r.method === 'PATCH'));
  const lay = reqs.find(r => /channel-layout$/.test(r.url));
  check('calls drag: ONE channel-layout PATCH, tagged list_kind=calls, divider after games', !!lay && lay.body.containers.length === 1 && lay.body.containers[0].list_kind === 'calls'
    && lay.body.containers[0].parent_category_id === 'hang' && JSON.stringify(lay.body.containers[0].items.map(i => i.id)) === JSON.stringify(['lounge', 'games', 'c-chill']), JSON.stringify(lay?.body));
  check('calls drag: no legacy channels/reorder call', !reqs.some(r => /channels\/reorder$/.test(r.url)));
  await page.close();
} finally {
  await browser.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
