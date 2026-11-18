// Shots + DOM checks for the 2026-11-17 channel-list round (harness/category-round-main.tsx).
//
//   SCL_PORT=5237 npx vite --config harness/subcat-list.vite.config.ts   (in another shell)
//   SCL_PORT=5237 node harness/category-round-shots.mjs --shots=<dir> [--dsf=2]
//
// One headless browser for the whole run, closed at the end.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.SCL_PORT ?? 5237;
const shots = arg('shots', '');
const dsf = Number(arg('dsf', '2'));
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

async function open(ctx, query) {
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${port}/harness/category-round.html?${query}`, { waitUntil: 'commit', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
  await page.waitForTimeout(600);
  return page;
}
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
const header = (page, name) => page.locator(`[role="button"][aria-label^="${name},"]`).first();
const labelMetrics = (page) => page.evaluate(() => {
  const cat = [...document.querySelectorAll('[aria-label$=", category"] span.uppercase')].find(s => s.textContent === 'Crafting');
  const sub = [...document.querySelectorAll('[data-subcategory-id="wood"] span')].find(s => s.textContent === 'Woodworking');
  const chan = [...document.querySelectorAll('span, div')].find(s => s.textContent === 'joinery' && s.children.length === 0);
  const m = (el) => { const cs = getComputedStyle(el); return { size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), color: cs.color, transform: cs.textTransform }; };
  return { cat: m(cat), sub: m(sub), chan: chan ? m(chan) : null };
});
// WCAG relative luminance of an rgb() string against the sidebar.
const lum = (rgb) => {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

try {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: dsf });

  // ── 1. Hierarchy before / after ─────────────────────────────────────
  let page = await open(ctx, 'scene=list&before=1&style=none');
  const before = await labelMetrics(page);
  await shot(page, '01-hierarchy-before', FRAME);
  await page.close();
  page = await open(ctx, 'scene=list&style=none');
  const after = await labelMetrics(page);
  await shot(page, '02-hierarchy-after', FRAME);
  const SIDEBAR = 'rgb(19, 26, 48)';
  console.log('before', JSON.stringify(before));
  console.log('after ', JSON.stringify(after));
  check('before: category label was smaller AND fainter than the sub-category label (the reported problem)',
    before.cat.size < before.sub.size && contrast(before.cat.color, SIDEBAR) < contrast(before.sub.color, SIDEBAR));
  check('after: category label weight >= sub-category weight', after.cat.weight >= after.sub.weight, `${after.cat.weight} vs ${after.sub.weight}`);
  check('after: category label contrast >= sub-category contrast',
    contrast(after.cat.color, SIDEBAR) >= contrast(after.sub.color, SIDEBAR) - 0.01,
    `${contrast(after.cat.color, SIDEBAR).toFixed(2)} vs ${contrast(after.sub.color, SIDEBAR).toFixed(2)}`);
  check('after: still distinct from a channel name (uppercase mono)', after.cat.transform === 'uppercase');
  await page.close();

  // ── 2. Divider category: expanded / collapsed, dark / light ─────────
  for (const theme of ['dark', 'light']) {
    page = await open(ctx, `scene=list&theme=${theme}&style=header`);
    const games = header(page, 'Game Nights');
    check(`${theme}: divider category drawn as a divider`, await games.locator('[data-divider-category="header"]').count() === 1);
    check(`${theme}: its sub-category is under it`, await page.locator('[data-subcategory-id="tabletop"]').count() === 1);
    check(`${theme}: an ordinary category has no colour on its label`,
      !(await page.locator('[aria-label="Crafting, category"] span.uppercase').getAttribute('style') ?? '').includes('color'));
    await shot(page, `03-divider-category-expanded-${theme}`, FRAME);
    await games.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    check(`${theme}: Enter collapses it (aria-expanded=false)`, await games.getAttribute('aria-expanded') === 'false');
    check(`${theme}: collapsed shows the unread roll-up`, await games.locator('.bg-cl-flash, .bg-cl-lume').count() === 1);
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement?.blur());
    await shot(page, `04-divider-category-collapsed-${theme}`, FRAME);
    await games.focus();
    await page.keyboard.press(' ');
    await page.waitForTimeout(250);
    check(`${theme}: Space expands it again`, await games.getAttribute('aria-expanded') === 'true');
    await page.close();
  }
  // The other three divider styles, dark, for the owner to compare.
  for (const st of ['label', 'pill', 'text']) {
    page = await open(ctx, `scene=list&style=${st}&color=${encodeURIComponent(st === 'pill' ? '#a78bfa' : st === 'text' ? '#ff8fb1' : '#ffc94d')}`);
    await shot(page, `05-divider-category-style-${st}`, FRAME);
    await page.close();
  }

  // ── 3. Create dialog with the new choice ────────────────────────────
  page = await open(ctx, 'scene=create');
  await page.locator('input[aria-label="Category name"]').fill('Game Nights');
  await shot(page, '06-create-dialog-category', '[role="dialog"]');
  await page.locator('button', { hasText: /^Divider category$/ }).click();
  await page.locator('[data-style="pill"]').click();
  await page.locator('[aria-label="Colour #25e0c8"]').click();
  await page.waitForTimeout(300);
  check('create: style tiles + colour picker shown for a divider category',
    await page.locator('[data-style="label"]').count() === 1 && await page.locator('[aria-label="Colour #ffc94d (default)"]').count() === 1);
  await shot(page, '07-create-dialog-divider-category', '[role="dialog"]');
  await page.close();

  // ── 4. Delete dialog, both states ───────────────────────────────────
  page = await open(ctx, 'scene=delete');
  await shot(page, '08-delete-dialog-category-only', '[role="dialog"]');
  await page.close();
  page = await open(ctx, 'scene=delete&choice=everything');
  const go = page.locator('button', { hasText: 'Delete 4 channels' });
  check('delete everything: button disabled until the tick', await go.isDisabled());
  await shot(page, '09-delete-dialog-everything-unconfirmed', '[role="dialog"]');
  await page.locator('text=I understand 4 channels').click();
  await page.waitForTimeout(200);
  check('delete everything: tick enables it', !(await go.isDisabled()));
  await shot(page, '10-delete-dialog-everything-confirmed', '[role="dialog"]');
  await page.close();
} finally {
  await browser.close();
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
