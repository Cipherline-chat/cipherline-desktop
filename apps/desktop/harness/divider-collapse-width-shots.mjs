// Divider-category collapse width (2026-11-18): after CLICKING a divider
// category header (mouse), the divider's rules must reach the row's right edge
// as soon as the pointer leaves, with no lingering "+" / "..." slot and no
// slow grow. Measures the divider's right edge against the header row's at
// ~50 ms and 1 s after the click, and again after the pointer leaves.
//
//   SCL_PORT=5237 npx vite --config harness/subcat-list.vite.config.ts   (other shell)
//   SCL_PORT=5237 node harness/divider-collapse-width-shots.mjs --shots=<dir>
//
// Exit code 1 when a check fails. One headless browser, closed at the end.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.SCL_PORT ?? 5237;
const shots = arg('shots', '');
if (shots) fs.mkdirSync(shots, { recursive: true });
const SIZES = [[1000, 720], [1366, 768], [1920, 1080]];
const STYLES = ['label', 'header', 'pill', 'text'];

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

// Gap between the divider's right edge and the header row's inner right edge.
const gap = (page, name) => page.evaluate((n) => {
  const row = document.querySelector(`[role="button"][aria-label^="${n},"]`);
  const div = row.querySelector('[data-divider-category]');
  const r = row.getBoundingClientRect(), d = div.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(row).paddingRight);
  // Slack = empty room right of the divider that is NOT a displayed sibling (the collapsed unread
  // roll-up dot + count is legitimate and counted out; a hidden "+" slot has display:none).
  let used = 0;
  for (let el = div.nextElementSibling; el; el = el.nextElementSibling) {
    if (getComputedStyle(el).display === "none") continue;
    used += el.getBoundingClientRect().width + parseFloat(getComputedStyle(row).columnGap || "0");
  }
  return Math.round((r.right - pad) - d.right - used);
}, name);

try {
  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    for (const style of STYLES) {
      const page = await ctx.newPage();
      page.on('pageerror', e => console.log('PAGEERROR', e.message));
      await page.goto(`http://127.0.0.1:${port}/harness/category-round.html?scene=list&style=${style}`, { waitUntil: 'commit', timeout: 180000 });
      await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
      await page.waitForTimeout(500);
      const row = page.locator('[role="button"][aria-label^="Game Nights,"]').first();
      const tag = `${w}x${h}-${style}`;
      const clip = async (file) => {
        if (!shots) return;
        const b = await row.boundingBox();
        await page.screenshot({ path: path.join(shots, `${tag}-${file}.png`), clip: { x: Math.max(0, b.x - 12), y: Math.max(0, b.y - 12), width: b.width + 24, height: b.height + 24 } });
      };
      const bb = await row.boundingBox();
      await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await page.mouse.down(); await page.mouse.up();      // click: collapse (and focuses the row)
      await page.waitForTimeout(50);
      const hoverGap = await gap(page, 'Game Nights');
      await clip('1-click-50ms');
      // Pointer leaves the row. The row keeps focus after a mouse click; that
      // must NOT keep the action slot open.
      await page.mouse.move(bb.x + bb.width / 2, 4);
      await page.waitForTimeout(50);
      const g50 = await gap(page, 'Game Nights');
      await clip('2-left-50ms');
      await page.waitForTimeout(1000);
      const g1s = await gap(page, 'Game Nights');
      await clip('3-left-1s');
      check(`${tag}: after click + pointer leave, divider reaches the row edge at ~50 ms and 1 s`, g50 <= 1 && g1s <= 1, `gap50=${g50}px gap1s=${g1s}px (hovering=${hoverGap}px)`);
      // Keyboard: Tab away and back must still reveal the buttons for keyboard users.
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('Tab');
      for (let i = 0; i < 40; i++) {
        const on = await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Game Nights,'));
        if (on) break;
        await page.keyboard.press('Tab');
      }
      await page.waitForTimeout(400);
      const kb = await page.evaluate(() => {
        const row = document.activeElement;
        return { focusVisible: row.matches(':focus-visible'), actions: [...row.querySelectorAll('button')].filter(b => b.offsetParent !== null && Number(getComputedStyle(b.parentElement).opacity) > 0.99 && getComputedStyle(b.parentElement).pointerEvents !== 'none').length };
      });
      await clip('4-keyboard-focus');
      check(`${tag}: keyboard focus on the header still shows the + / ... buttons`, kb.focusVisible && kb.actions >= 2, JSON.stringify(kb));
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
