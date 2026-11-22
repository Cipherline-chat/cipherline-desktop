// Channel mute screenshots + behaviour checks (harness/channel-mute-main.tsx).
//
//   CMU_PORT=5241 npx vite --config harness/channel-mute.vite.config.ts   (another shell)
//   CMU_PORT=5241 node harness/channel-mute-shots.mjs --shots=<dir>
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.CMU_PORT ?? 5241;
const shots = arg('shots', '');
if (shots) fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const SIZES = [['1000x720', 1000, 720, 1], ['1366x768', 1366, 768, 1], ['1920x1080', 1920, 1080, 1], ['1280x800@1.5', 1280, 800, 1.5]];

async function open(ctx, query) {
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${port}/harness/channel-mute.html?${query}`, { waitUntil: 'commit', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
  await page.waitForTimeout(500);
  return page;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const items = (page) => page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim()));
const row = (page, name) => page.locator(`[data-channel-id="${name}"]`);

try {
  for (const [label, w, h, dsf] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
    for (const theme of ['dark', 'light']) {
      // 1. menu with the Mute submenu open
      let page = await open(ctx, `theme=${theme}&scene=list`);
      await row(page, 'joinery').click({ button: 'right' });
      await page.waitForTimeout(250);
      const base = await items(page);
      if (label === SIZES[0][0] && theme === 'dark') check('channel menu offers "Mute Channel"', base.includes('Mute Channel'), JSON.stringify(base));
      await page.locator('[role="menuitem"]', { hasText: 'Mute Channel' }).hover();
      await page.waitForTimeout(350);
      const sub = await items(page);
      if (label === SIZES[0][0] && theme === 'dark') check('submenu has the five durations', ['For 15 minutes', 'For 1 hour', 'For 8 hours', 'For 24 hours', 'Until I turn it back on'].every(x => sub.includes(x)), JSON.stringify(sub));
      await shot(page, `01-mute-submenu-${theme}-${label}`);
      await page.close();

      // 2. channel list with muted channel (1 h) + muted category, and the unmute hint
      page = await open(ctx, `theme=${theme}&scene=list&seed=1`);
      await shot(page, `02-muted-channel-list-${theme}-${label}`);
      if (label === SIZES[0][0] && theme === 'dark') {
        check('muted channel shows the muted glyph', (await row(page, 'finishes').locator('[aria-label="muted"]').count()) === 1);
        check('channel of a muted category shows the glyph', (await row(page, 'off-topic').locator('[aria-label="muted"]').count()) === 1);
        check('unmuted channel has no glyph', (await row(page, 'joinery').locator('[aria-label="muted"]').count()) === 0);
      }
      await row(page, 'finishes').click({ button: 'right' });
      await page.waitForTimeout(250);
      const mi = await items(page);
      if (label === SIZES[0][0] && theme === 'dark') check('muted channel menu: Unmute + "Muted until" hint', mi.includes('Unmute Channel') && mi.some(t => /^Muted until \d/.test(t)), JSON.stringify(mi));
      await shot(page, `03-unmute-hint-${theme}-${label}`);
      if (label === SIZES[0][0] && theme === 'dark') {
        await page.locator('[role="menuitem"]', { hasText: 'Unmute Channel' }).click();
        await page.waitForTimeout(300);
        check('Unmute clears the glyph', (await row(page, 'finishes').locator('[aria-label="muted"]').count()) === 0);
      }
      await page.close();
    }
    await ctx.close();
  }
  // Calls panel (one size, both themes)
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  for (const theme of ['dark', 'light']) {
    const page = await open(ctx, `theme=${theme}&scene=calls`);
    await page.getByText('lounge', { exact: true }).first().click({ button: 'right' });
    await page.waitForTimeout(300);
    const mi = await items(page);
    if (theme === 'dark') check('Calls channel menu offers Mute Channel', mi.includes('Mute Channel'), JSON.stringify(mi));
    await shot(page, `04-calls-channel-menu-${theme}`);
    await page.close();
  }
  await ctx.close();
} finally {
  await browser.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
