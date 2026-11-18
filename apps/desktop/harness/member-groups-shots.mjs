// Shots + DOM checks for collapsible member-list groups (harness/member-groups-main.tsx).
// (The channel-header hide-member-list button and its cases were removed 2026-11-18; the
// narrow-panel overflow check lives in harness/member-panel-narrow-shots.mjs.)
//
//   MG_PORT=5237 npx vite --config harness/member-groups.vite.config.ts   (in another shell)
//   MG_PORT=5237 node harness/member-groups-shots.mjs --shots=<dir> [--dsf=2]
//
// Shots: 01-expanded, 02-collapsed (Moderators + Offline), 03-keyboard-focus
// (focus ring on a header, toggled with Space/Enter), 04-restored-after-remount,

import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.MG_PORT ?? 5237;
const shots = arg('shots', '');
const dsf = Number(arg('dsf', '2'));
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

async function open(ctx, query = '') {
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${port}/harness/member-groups.html?${query}`, { waitUntil: 'commit', timeout: 180000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 180000 });
  await page.waitForSelector('.cl-mgroup-head', { timeout: 60000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
  await page.waitForTimeout(400);
  return page;
}
const shot = async (page, name, sel = 'body') => {
  if (!shots) return;
  const box = await page.locator(sel).first().boundingBox();
  const pad = 12;
  await page.screenshot({
    path: path.join(shots, `${name}.png`),
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: Math.min(box.height + pad * 2, 1000) },
  });
};
const heads = (page) => page.evaluate(() => [...document.querySelectorAll('.cl-mgroup-head')].map(b => ({
  text: b.textContent.replace(/\s+/g, ' ').trim(), expanded: b.getAttribute('aria-expanded'),
})));
const rowCount = (page) => page.evaluate(() => [...document.querySelectorAll('.cl-mgroup-body')].map(b => b.querySelectorAll('[class*="py-1.5"]').length));
const head = (page, label) => page.locator('.cl-mgroup-head').filter({ hasText: label }).first();

try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 980 }, deviceScaleFactor: dsf });

  // ── Expanded (default) ────────────────────────────────────────────────
  let page = await open(ctx);
  check('account bound in the harness store', await page.evaluate(() => window.__accountReady === true));
  let h = await heads(page);
  check('four group headers, all expanded', h.length === 4 && h.every(x => x.expanded === 'true'), JSON.stringify(h));
  check('headers carry counts', h.map(x => x.text).join('|') === 'Moderators — 3|Artists — 2|Online — 3|Offline — 8', h.map(x => x.text).join('|'));
  check('headers are native buttons with aria-controls', await page.evaluate(() => [...document.querySelectorAll('.cl-mgroup-head')].every(b => b.tagName === 'BUTTON' && document.getElementById(b.getAttribute('aria-controls')))));
  await shot(page, '01-expanded', '#panel');

  // ── Collapse by click ─────────────────────────────────────────────────
  await head(page, 'Moderators').click();
  await head(page, 'Offline').click();
  await page.waitForTimeout(400);
  h = await heads(page);
  check('clicked groups collapse; count stays', h[0].text === 'Moderators — 3' && h[0].expanded === 'false' && h[3].text === 'Offline — 8' && h[3].expanded === 'false', JSON.stringify(h));
  const rows = await rowCount(page);
  check('collapsed groups mount no rows', rows[0] === 0 && rows[3] === 0 && rows[1] === 2 && rows[2] === 3, JSON.stringify(rows));
  check('stored per account+server', (await page.evaluate(() => window.__stored())) === '["offline","role:mods"]', await page.evaluate(() => window.__stored()));
  await page.mouse.move(700, 900);
  await shot(page, '02-collapsed', '#panel');

  // ── Keyboard: Tab to a header, Space / Enter toggle it ────────────────
  await head(page, 'Artists').focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  check('Space collapses the focused header', (await heads(page))[1].expanded === 'false');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check('Enter expands it again', (await heads(page))[1].expanded === 'true');
  // :focus-visible needs a keyboard-originated focus: Shift+Tab then Tab back.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent?.replace(/\s+/g, ' ').trim());
  check('keyboard focus lands on the header', focused === 'Artists — 2', focused);
  check('focus ring drawn (:focus-visible)', await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow !== 'none'));
  await shot(page, '03-keyboard-focus', '#panel');

  // ── Remembered across a remount (re-read from secureLocalStore) ───────
  await page.evaluate(() => window.__remount());
  await page.waitForSelector('.cl-mgroup-head');
  await page.waitForTimeout(300);
  h = await heads(page);
  check('state survives remount', h[0].expanded === 'false' && h[3].expanded === 'false' && h[1].expanded === 'true', JSON.stringify(h));
  await shot(page, '04-restored-after-remount', '#panel');

  await page.close();

  // ── Stale ids pruned (deleted role) ───────────────────────────────────
  page = await open(ctx, 'seed=offline&deleted=1');
  await page.waitForTimeout(300);
  check('stale role id pruned from the store', (await page.evaluate(() => window.__stored())) === '["offline"]', await page.evaluate(() => window.__stored()));
  check('seeded group starts collapsed (a restart)', (await heads(page))[3].expanded === 'false');
  await page.close();

  // ── Reduced motion: transitions off, same resting picture ─────────────
  const rctx = await browser.newContext({ viewport: { width: 1200, height: 980 }, deviceScaleFactor: dsf, reducedMotion: 'reduce' });
  page = await open(rctx);
  check('reduced motion: no transition on the body', await page.evaluate(() => getComputedStyle(document.querySelector('.cl-mgroup-body')).transitionDuration.split(',').every(d => parseFloat(d) === 0)));
  await head(page, 'Online').click();
  await page.waitForTimeout(50);
  const hgt = await page.evaluate(() => [...document.querySelectorAll('.cl-mgroup-body')][2].getBoundingClientRect().height);
  check('reduced motion: collapses at once', hgt === 0, String(hgt));
  await shot(page, '06-reduced-motion-collapsed', '#panel');
  await rctx.close();

  // ── Normal motion: mid-transition height is between open and closed ───
  page = await open(ctx);
  const full = await page.evaluate(() => [...document.querySelectorAll('.cl-mgroup-body')][2].getBoundingClientRect().height);
  await head(page, 'Online').click();
  await page.waitForTimeout(60);
  const mid = await page.evaluate(() => [...document.querySelectorAll('.cl-mgroup-body')][2].getBoundingClientRect().height);
  await page.waitForTimeout(400);
  const end = await page.evaluate(() => [...document.querySelectorAll('.cl-mgroup-body')][2].getBoundingClientRect().height);
  check('animates: mid-fold height between full and 0', mid > 0 && mid < full && end === 0, `full=${full} mid=${mid} end=${end}`);
  await page.close();
} finally {
  await browser.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
