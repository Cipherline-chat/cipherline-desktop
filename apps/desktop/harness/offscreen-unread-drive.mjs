// Renders the real ServerChannelList (harness/offscreen-unread-main.tsx) in
// headless Chromium on the Intel GPU path and takes the owner-facing shots at
// 2x device scale, plus DOM assertions on the click behaviour.
//
//   OUP_PORT=5218 node harness/offscreen-unread-drive.mjs --shots=<dir> [--dsf=2]
//
// Shots:
//   01-new-unreads-below      plain unreads below the fold   -> lume "New unreads"
//   02-two-mentions-below     two @mentions below            -> red "2 mentions"
//   03-top-and-bottom         scrolled mid-list              -> pills on both edges
//   04-after-click            the moment after a click       -> target row pulsing
//   05-quiet-unreads-below    "@mentions only" server        -> grey pill
//   06-collapsed-category     a collapsed category hides an unread/mention (header stands in)
//   07-collapsed-after-click  click expands it and lands on the channel
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.OUP_PORT ?? 5218;
const shots = arg('shots', '');
const dsf = Number(arg('dsf', '2'));
if (shots) fs.mkdirSync(shots, { recursive: true });

const GPU = ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
const browser = await chromium.launch({ executablePath: exe, args: GPU });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

async function open(ctx, scene, extra = '') {
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/harness/offscreen-unread.html?scene=${scene}${extra}`, { waitUntil: 'commit', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
  await page.waitForTimeout(500); // pill entrance animation + measure settle
  return page;
}
const frame = (page) => page.locator('#root > div > div').first();
const shot = async (page, name) => {
  if (!shots) return;
  const box = await frame(page).boundingBox();
  const pad = 14;
  await page.screenshot({
    path: path.join(shots, `${name}.png`),
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
    animations: 'allow',
  });
};
const pill = (page, dir) => page.locator(`[data-unread-pill="${dir}"]`);
const scroller = (page) => page.locator('[tabindex="-1"].custom-scrollbar');
const scrollTop = (page) => scroller(page).evaluate(el => el.scrollTop);
const pulsing = (page) => page.evaluate(() => [...document.querySelectorAll('.cl-unread-pulse')].map(e => e.textContent.trim()));

try {
  const ctx = await browser.newContext({ viewport: { width: 380, height: 640 }, deviceScaleFactor: dsf });

  // 1 — plain unreads below
  let page = await open(ctx, 'below');
  check('below: pill at bottom', await pill(page, 'below').count() === 1);
  check('below: no pill at top', await pill(page, 'above').count() === 0);
  check('below: label', (await pill(page, 'below').innerText()).trim() === 'New unreads', await pill(page, 'below').innerText());
  await shot(page, '01-new-unreads-below');

  // 4 — the moment after a click (same page)
  const before = await scrollTop(page);
  await pill(page, 'below').click();
  await page.waitForTimeout(650);
  const after = await scrollTop(page);
  check('click: list scrolled down', after > before, `${before} -> ${after}`);
  const hot = await pulsing(page);
  check('click: exactly one row is pulsing', hot.length === 1, JSON.stringify(hot));
  check('click: it is the NEAREST unread below (design)', hot[0]?.startsWith('design'), hot[0]);
  const rowBox = await page.locator('.cl-unread-pulse').boundingBox();
  const sBox = await scroller(page).boundingBox();
  const mid = rowBox.y + rowBox.height / 2 - (sBox.y + sBox.height / 2);
  check('click: target is roughly centred in the list', Math.abs(mid) < sBox.height * 0.2, `offset ${mid.toFixed(0)}px of ${sBox.height.toFixed(0)}`);
  await shot(page, '04-after-click');
  // repeated clicks step on
  await page.waitForTimeout(1600);
  await pill(page, 'below').click(); await page.waitForTimeout(650);
  const hot2 = await pulsing(page);
  check('click 2: skips the unreads already in view and steps to the next OFF-screen one (random)', hot2[0]?.startsWith('random'), JSON.stringify(hot2));
  await page.close();

  // 2 — mentions below
  page = await open(ctx, 'mentions');
  check('mentions: red pill', await pill(page, 'below').getAttribute('data-tone') === 'mention');
  check('mentions: "2 mentions"', (await pill(page, 'below').innerText()).trim() === '2 mentions');
  await shot(page, '02-two-mentions-below');
  await page.close();

  // 3 — both edges
  page = await open(ctx, 'both');
  check('both: pill above', await pill(page, 'above').count() === 1, (await pill(page, 'above').innerText()).trim());
  check('both: pill below (mention)', await pill(page, 'below').getAttribute('data-tone') === 'mention', (await pill(page, 'below').innerText()).trim());
  await shot(page, '03-top-and-bottom');
  const t0 = await scrollTop(page);
  await pill(page, 'above').click(); await page.waitForTimeout(650);
  check('both: clicking the top pill scrolls UP', await scrollTop(page) < t0);
  await page.close();

  // 5 — quiet
  page = await open(ctx, 'quiet');
  check('quiet: grey pill', await pill(page, 'below').getAttribute('data-tone') === 'quiet');
  await shot(page, '05-quiet-unreads-below');
  await page.close();

  // negative control
  page = await open(ctx, 'none');
  check('none: no pills at all', await page.locator('[data-unread-pill]').count() === 0);
  await page.close();

  // 6/7 — collapsed category: the header stands in for what it hides; click expands + lands
  page = await open(ctx, 'collapsed');
  check('collapsed (before): pill counts the mention in Off topic', (await pill(page, 'below').innerText()).trim() === '2 mentions');
  await page.evaluate(() => [...document.querySelectorAll('.group')].find(e => /off topic/i.test(e.textContent)).click());
  await page.waitForTimeout(500);
  check('collapsed: the header is registered as an anchor', await page.locator('[data-unread-anchor^="cat:"]').count() === 1);
  check('collapsed: travel row is not rendered', await page.locator('[data-unread-anchor="ch:travel"]').count() === 0);
  check('collapsed: pill STILL counts the hidden mention', (await pill(page, 'below').innerText()).trim() === '2 mentions', (await pill(page, 'below').innerText()).trim());
  await shot(page, '06-collapsed-category');
  await pill(page, 'below').click();          // nearest off-screen unread first: `design`
  await page.waitForTimeout(700);
  check('collapsed: first click lands on the nearer plain unread (design), category still collapsed', (await pulsing(page))[0]?.startsWith('design') && await page.locator('[data-unread-anchor="ch:travel"]').count() === 0);
  await pill(page, 'below').click();          // next: the collapsed header's hidden mention
  await page.waitForTimeout(900);
  check('collapsed: second click expanded the category (travel rendered)', await page.locator('[data-unread-anchor="ch:travel"]').count() === 1);
  const hot3 = await pulsing(page);
  check('collapsed: landed on travel, pulsing', hot3[0]?.startsWith('travel'), JSON.stringify(hot3));
  await shot(page, '07-collapsed-after-click');
  await page.close();

  // reduced motion
  const rctx = await browser.newContext({ viewport: { width: 380, height: 640 }, deviceScaleFactor: dsf, reducedMotion: 'reduce' });
  page = await open(rctx, 'below');
  const rb = await scrollTop(page);
  await pill(page, 'below').click();
  await page.waitForTimeout(80);
  check('reduced motion: scroll is instant (already there after 80ms)', (await scrollTop(page)) > rb);
  check('reduced motion: no pulse', (await pulsing(page)).length === 0);
  await page.close();
  await rctx.close();

  // keyboard
  page = await open(ctx, 'below');
  await page.keyboard.press('Tab');
  let focused = '';
  for (let i = 0; i < 60 && !focused.includes('pill'); i++) {
    focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-unread-pill') ? 'pill' : '');
    if (!focused) await page.keyboard.press('Tab');
  }
  check('keyboard: pill is reachable by Tab', focused === 'pill');
  const kb = await scrollTop(page);
  await page.keyboard.press('Enter'); await page.waitForTimeout(650);
  check('keyboard: Enter scrolls', (await scrollTop(page)) > kb);
  await page.close();
  await ctx.close();
} finally {
  await browser.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
