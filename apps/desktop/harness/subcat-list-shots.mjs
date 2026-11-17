// Shots + DOM checks for sub-categories and dividers (harness/subcat-list-main.tsx).
//
//   SCL_PORT=5231 npx vite --config harness/subcat-list.vite.config.ts   (in another shell)
//   SCL_PORT=5231 node harness/subcat-list-shots.mjs --shots=<dir> [--dsf=2]
//
// Owner-facing UX shots (names are what they show):
//   01-list-member, 02-list-member-subcategory-collapsed, 03-list-manager,
//   04-create-menu, 05-create-subcategory-dialog,
//   06..09-divider-dialog-<style> (labelled with the colour picker open),
//   10-category-context-menu, 11-subcategory-context-menu,
//   12-delete-blocked-private-parent, 13-channel-settings-category-picker,
//   14-drag-channel-into-subcategory, 15-dropped, 16-labelled-divider-custom-colour
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.SCL_PORT ?? 5231;
const shots = arg('shots', '');
const dsf = Number(arg('dsf', '2'));
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
  await page.waitForTimeout(500);
  return page;
}
/** Clip to an element (+pad), or the whole viewport when no selector. */
const shot = async (page, name, sel) => {
  if (!shots) return;
  if (!sel) { await page.screenshot({ path: path.join(shots, `${name}.png`) }); return; }
  const box = await page.locator(sel).first().boundingBox();
  const pad = 14;
  await page.screenshot({
    path: path.join(shots, `${name}.png`),
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
};
const FRAME = '#root > div > div';
const separators = (page) => page.evaluate(() => [...document.querySelectorAll('[role="separator"]')].map(e => e.getAttribute('aria-label')));
const menuItems = (page) => page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim()));
const subHeader = (page, id) => page.locator(`[data-subcategory-id="${id}"] [role="button"]`).first();
const catHeader = (page, name) => page.locator('[role="button"][aria-expanded]').filter({ hasText: name }).first();

try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: dsf });

  // ── Member view ──────────────────────────────────────────────────────
  let page = await open(ctx, 'scene=member');
  const seps = await separators(page);
  check('member: labelled divider over visible channels is drawn', seps.includes('Section: Community'), JSON.stringify(seps));
  check('member: labelled divider over a hidden section is NOT drawn', !seps.includes('Section: Staff only'));
  check('member: separators (line, dots) drawn', seps.filter(s => s === 'Divider').length === 2);
  check('member: four sub-category headers', await page.locator('[data-subcategory-id]').count() === 4);
  const font = await page.locator('[data-subcategory-id="wood"] [role="button"] span.truncate').evaluate(e => getComputedStyle(e).fontFamily);
  check('member: sub-category name in Fredoka', /Fredoka/i.test(font), font);
  const guide = await page.locator('[data-subcategory-id="wood"]').evaluate(e => getComputedStyle(e).borderLeftStyle);
  check('member: guide line on the sub-category block', guide === 'solid', guide);
  check('member: dividers are not keyboard stops', await page.locator('[role="separator"][tabindex]').count() === 0);
  await shot(page, '01-list-member', FRAME);

  await subHeader(page, 'paper').click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(250);
  const paperHeader = subHeader(page, 'paper');
  check('collapsed: aria-expanded=false', (await paperHeader.getAttribute('aria-expanded')) === 'false');
  check('collapsed: channels hidden', await page.locator('[data-channel-id="origami"]').count() === 0);
  check('collapsed: header announces the mention', /1 mentions/.test(await paperHeader.getAttribute('aria-label') ?? ''));
  await shot(page, '02-list-member-subcategory-collapsed', FRAME);
  await paperHeader.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('keyboard: Enter expands again', (await paperHeader.getAttribute('aria-expanded')) === 'true');
  // Members get Mark as Read + Copy ID on a category (parity), nothing that writes.
  await catHeader(page, 'Crafting').click({ button: 'right' });
  await page.waitForTimeout(200);
  const memberMenu = await menuItems(page);
  check('member: category menu = Mark as Read + Copy ID only', JSON.stringify(memberMenu) === JSON.stringify(['Mark as Read', 'Copy Category ID']), JSON.stringify(memberMenu));
  await page.close();

  // ── Manager view ─────────────────────────────────────────────────────
  page = await open(ctx, 'scene=manager');
  const mseps = await separators(page);
  check('manager: the would-be-hidden divider is drawn for editing', mseps.includes('Section: Staff only'));
  const op = await page.locator('[data-divider-id="staffonly"]').evaluate(e => getComputedStyle(e).opacity);
  check('manager: ...and NOT dimmed (marked with an eye-off + tooltip instead)', Number(op) === 1, op);
  check('manager: ...marked hidden-from-members', await page.locator('[data-divider-id="staffonly"] [data-testid="divider-hidden-mark"]').count() === 1);
  check('manager: a visible divider is NOT marked', await page.locator('[data-divider-id="community"] [data-testid="divider-hidden-mark"]').count() === 0);
  await shot(page, '24-divider-member-hidden', '[data-divider-id="staffonly"]');
  await shot(page, '03-list-manager', FRAME);

  // Create menu (right-click empty list space)
  // Right-click on the list's own background (not on a row or a header).
  await page.locator('[tabindex="-1"].custom-scrollbar').evaluate(el => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 140, clientY: r.top + 220 }));
  });
  await page.waitForTimeout(250);
  const create = await menuItems(page);
  check('create menu: Channel / Category / Divider (no Sub-category: only from a category)', JSON.stringify(create) === JSON.stringify(['Create Channel', 'Create Category', 'Add Divider']), JSON.stringify(create));
  await shot(page, '04-create-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Category context menu
  await catHeader(page, 'Crafting').click({ button: 'right' });
  await page.waitForTimeout(250);
  const catMenu = await menuItems(page);
  check('category menu: has Create Sub-category Here + Add Divider Here', catMenu.includes('Create Sub-category Here') && catMenu.includes('Add Divider Here'), JSON.stringify(catMenu));
  await shot(page, '10-category-context-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Sub-category context menu
  await subHeader(page, 'wood').click({ button: 'right' });
  await page.waitForTimeout(250);
  const subMenu = await menuItems(page);
  check('sub-category menu: Move to top level, no Create Sub-category', subMenu.includes('Move to top level') && !subMenu.includes('Create Sub-category Here'), JSON.stringify(subMenu));
  check('sub-category menu: same items as a category otherwise', ['Mark as Read', 'Create Channel Here', 'Add Divider Here', 'Edit Sub-category', 'Edit Permissions', 'Copy Sub-category ID', 'Delete Sub-category'].every(l => subMenu.includes(l)));
  await shot(page, '11-subcategory-context-menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Delete-blocked dialog for the private "Staff" (it holds "Mod tools")
  await catHeader(page, 'Staff').click({ button: 'right' });
  await page.waitForTimeout(250);
  await page.locator('[role="menuitem"]', { hasText: 'Delete Category' }).click();
  await page.waitForTimeout(700);
  const dialogText = await page.locator('[role="dialog"]').last().innerText();
  check('delete blocked: explains why', dialogText.includes("Move or delete the sub-categories in \"Staff\" first. It's private"), dialogText.slice(0, 120));
  check('delete blocked: no Delete button at all', await page.locator('[role="dialog"] button', { hasText: 'Delete' }).count() === 0);
  check('delete blocked: one "Got it" button', await page.locator('[role="dialog"] button', { hasText: 'Got it' }).count() === 1);
  check('delete blocked: move hint kept', dialogText.includes('Move to top level'));
  await shot(page, '12-delete-blocked-private-parent');
  await page.locator('[role="dialog"] button', { hasText: 'Got it' }).last().click();
  await page.waitForTimeout(500);

  // Channel settings: category picker lists sub-categories as breadcrumbs
  await page.locator('[data-channel-id="joinery"]').click({ button: 'right' });
  await page.waitForTimeout(250);
  await page.locator('[role="menuitem"]', { hasText: 'Edit Channel' }).click();
  await page.waitForTimeout(900);
  await page.locator('[aria-label="Category"]').first().click();
  await page.waitForTimeout(400);
  const options = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')].map(e => e.textContent.trim()));
  check('channel settings: sub-categories listed under their parent', options.some(o => o.includes('Crafting › Woodworking')), JSON.stringify(options));
  await shot(page, '13-channel-settings-category-picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await page.close();

  // Drag a channel into a sub-category
  page = await open(ctx, 'scene=manager');
  const src = await page.locator('[data-channel-id="show-and-tell"]').boundingBox();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 + 12, { steps: 4 });
  await page.waitForTimeout(200); // drop zones open once a drag starts: measure after
  const dst = await page.locator('[data-channel-id="welding"]').boundingBox();
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height - 3, { steps: 25 });
  await page.waitForTimeout(250);
  await shot(page, '14-drag-channel-into-subcategory', FRAME);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const reqs = await page.evaluate(() => window.__requests.filter(r => r.method === 'PATCH' && r.url.endsWith('/channel-layout')));
  const metal = reqs[0]?.body?.containers?.find(c => c.parent_category_id === 'metal');
  check('drag: one PATCH, channel lands in Metalwork after welding', JSON.stringify(metal?.items?.map(i => i.id)) === '["welding","show-and-tell"]', JSON.stringify(reqs[0]?.body));
  check('drag: drawn inside the sub-category now (optimistic)', await page.locator('[data-subcategory-id="metal"] [data-channel-id="show-and-tell"]').count() === 1);
  await page.mouse.move(5, 5);
  await shot(page, '15-dropped', FRAME);
  await page.close();

  // Labelled divider in a custom colour
  page = await open(ctx, 'scene=colour');
  const colour = await page.locator('[data-divider-id="tools"] span.truncate').evaluate(e => getComputedStyle(e.parentElement).color);
  check('colour: labelled divider uses its colour', colour === 'rgb(37, 224, 200)', colour);
  await shot(page, '16-labelled-divider-custom-colour', FRAME);
  await page.close();

  // Create sub-category dialog
  page = await open(ctx, 'scene=subcat-dialog');
  await page.waitForTimeout(600);
  const dlg = await page.locator('[role="dialog"]').first().innerText();
  check('sub-category dialog: titled + sits in Crafting', dlg.includes('Create sub-category') && /in crafting/i.test(dlg), dlg.slice(0, 100));
  check('sub-category dialog: no emoji button, approved icon picker + parent picker', await page.locator('[aria-label^="Sub-category emoji"]').count() === 0 && await page.locator('span.inline-flex.shrink-0 button').count() >= 1 && await page.locator('[aria-label="Parent category"]').count() === 1);
  await page.locator('[aria-label="Sub-category name"]').fill('Leatherwork');
  await page.waitForTimeout(200);
  await shot(page, '05-create-subcategory-dialog');
  // The icon button is the approved picker (curated lucide set), not an emoji picker.
  await page.locator('span.inline-flex.shrink-0 button').first().click();
  await page.waitForTimeout(400);
  check('sub-category dialog: icon picker is the approved set (search + Default + tiles)', await page.locator('input[placeholder="Search icons\u2026"]').count() === 1 && await page.locator('.fade-pop-enter button').count() > 60);
  check('sub-category dialog: no emoji picker opened', await page.locator('em-emoji-picker').count() === 0);
  await shot(page, '20-subcategory-icon-picker');
  await page.locator('.fade-pop-enter button').nth(30).click();
  await page.waitForTimeout(300);
  await page.close();

  // Divider dialog, each style
  const styles = [['label', '06-divider-dialog-labelled-colour-picker'], ['line', '07-divider-dialog-line'], ['dots', '08-divider-dialog-dots'], ['space', '09-divider-dialog-blank-space'], ['header', '09b-divider-dialog-header'], ['pill', '09c-divider-dialog-pill'], ['text', '09d-divider-dialog-text']];
  for (const [style, name] of styles) {
    page = await open(ctx, `scene=dialog&new=1&style=${style}`);
    if (style !== 'label') {
      await page.locator(`[role="radio"][data-style="${style}"]`).click();
      if (['header', 'pill', 'text'].includes(style)) await page.locator('[aria-label="Divider label"]').fill('Community');
      await page.waitForTimeout(200);
    } else {
      await page.locator('[aria-label="Divider label"]').fill('Community');
      await page.locator('[aria-label="Pick a custom divider colour"]').click();
      await page.waitForTimeout(400);
      const tile = await page.locator('[data-style="label"]').innerText();
      check('divider dialog: Labelled tile shows its sample whole (no ellipsis)', !tile.includes('…'), JSON.stringify(tile));
    }
    check(`divider dialog (${style}): no emoji button`, await page.locator('[aria-label^="Divider emoji"]').count() === 0);
    check(`divider dialog (${style}): ${style} selected`, (await page.locator(`[data-style="${style}"]`).getAttribute('aria-checked')) === 'true');
    await shot(page, name);
    await page.close();
  }

  // Every label style in the dialog's grid (22) and in the real sidebar (23).
  page = await open(ctx, 'scene=dialog&new=1&style=label');
  await page.locator('[aria-label="Divider label"]').fill('Community');
  await page.waitForTimeout(250);
  check('styles grid: seven tiles, none clipped (no ellipsis in a tile)', await page.locator('[role="radio"][data-style]').count() === 7 && !(await page.locator('[role="radiogroup"]').innerText()).includes('\u2026'));
  await shot(page, '22-divider-styles-grid');
  await page.close();

  page = await open(ctx, 'scene=styles');
  const ids = ['s-header', 'community', 's-pill', 's-text'];
  for (const id of ids) {
    const t = await page.locator(`[data-divider-id="${id}"]`).innerText();
    check(`styles sidebar: ${id} shows its label exactly as typed (no added stars)`, !/[\u2726\u2727\u2728]/.test(t) && t.trim().length > 0, JSON.stringify(t));
    const op = await page.locator(`[data-divider-id="${id}"]`).evaluate(e => getComputedStyle(e).opacity);
    check(`styles sidebar: ${id} is fully opaque`, Number(op) === 1, op);
  }
  check('styles sidebar: unknown style draws as a line', await page.locator('[data-divider-id="s-unknown"] .h-px').count() === 1);
  await page.mouse.move(5, 5);
  await shot(page, '23-divider-styles-sidebar', FRAME);
  await page.close();

  // Hit area (manager rows >= 24px tall, full width; members' rows are inert) + vertical centring of the rules.
  for (const scaleDsf of [1, 1.25, 1.5]) {
    const c2 = await browser.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: scaleDsf });
    const pg = await open(c2, 'scene=styles');
    const hit = await pg.evaluate(() => [...document.querySelectorAll('[role="separator"]')].map(e => {
      const r = e.getBoundingClientRect(); const p = e.parentElement.getBoundingClientRect();
      return { id: e.getAttribute('data-divider-id'), h: r.height, w: r.width, pw: p.width };
    }));
    check(`hit area @${scaleDsf}x: every manager divider >= 24px tall`, hit.every(x => x.h >= 24 - 0.01), JSON.stringify(hit.map(x => [x.id, +x.h.toFixed(1)])));
    check(`hit area @${scaleDsf}x: full row width`, hit.every(x => Math.abs(x.w - x.pw) < 1));
    // Pixel check: rendered rule centre vs glyph box of the label's caps.
    for (const id of ['community', 's-header', 's-pill']) {
      const m = await pg.evaluate(async (id) => {
        const row = document.querySelector(`[data-divider-id="${id}"]`);
        const rule = row.querySelector('span.h-px'); const text = row.querySelector('span.truncate');
        const rr = rule.getBoundingClientRect(); const tr = text.getBoundingClientRect();
        // Cap height centre from real font metrics: baseline - capHeight/2.
        const cs = getComputedStyle(text); const cv = document.createElement('canvas').getContext('2d');
        cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const mt = cv.measureText('H');
        const lineBox = parseFloat(cs.lineHeight) || tr.height;
        // Baseline sits at (box top + (box h + ascent - descent)/2) for the font's own ascent/descent.
        const fm = cv.measureText('Hx');
        const baseline = tr.top + (tr.height + fm.fontBoundingBoxAscent - fm.fontBoundingBoxDescent) / 2;
        const capMid = baseline - mt.actualBoundingBoxAscent / 2;
        return { rule: rr.top + rr.height / 2, capMid, boxMid: tr.top + tr.height / 2 };
      }, id);
      check(`centring @${scaleDsf}x ${id}: rule within 0.75px of cap-height centre`, Math.abs(m.rule - m.capMid) <= 0.75, JSON.stringify(m));
    }
    if (scaleDsf === 1.5) await shot(pg, '31-divider-centring-1_5x', '[data-divider-id="community"]');
    await pg.close(); await c2.close();
  }
  const mpage = await open(ctx, 'scene=member');
  const minfo = await mpage.evaluate(() => [...document.querySelectorAll('[role="separator"]')].map(e => ({ cls: e.className, tab: e.getAttribute('tabindex'), cur: getComputedStyle(e).cursor })));
  check('member: dividers inert (no cursor, no tab stop, no hover wash)', minfo.every(x => x.tab === null && x.cur !== 'grab' && !/hover:bg|min-h-\[24px\]|cursor-grab/.test(x.cls)), JSON.stringify(minfo[0]));
  await mpage.close();
} finally {
  await browser.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
