// Shots + DOM checks for "all divider types can be placed anywhere and seen" (harness/dividers-anywhere-main.tsx).
//
//   DA_PORT=5241 npx vite --config harness/dividers-anywhere.vite.config.ts   (in another shell)
//   DA_PORT=5241 node harness/dividers-anywhere-shots.mjs --shots=<dir> [--dsf=1] [--only=label,line]
//
// Per style x theme (dark, light) x size (1000x720, 1366x768) x list (text, calls): a shot of the list with
// that style placed at the top (first + last), in a category (first / between / last), in a sub-category
// (first + last, text only) and alone in an otherwise empty category - plus DOM checks that every one of
// them is drawn, for the manager AND for a plain member. Then two real drags (pointer events through dnd-kit).
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const port = process.env.DA_PORT ?? 5241;
const shots = arg('shots', '');
const dsf = Number(arg('dsf', '1'));
const STYLES = ['label', 'header', 'pill', 'text', 'line', 'dots', 'space'];
const only = arg('only', '');
const styles = only ? only.split(',') : STYLES;
const SIZES = [[1000, 720], [1366, 768]];
if (shots) fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

async function open(ctx, query) {
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(`http://127.0.0.1:${port}/harness/dividers-anywhere.html?${query}`, { waitUntil: 'commit', timeout: 240000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 240000 });
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
  await page.waitForTimeout(400);
  return page;
}
const sepCount = (page) => page.locator('[role="separator"]').count();
const EXPECT = { text: 8, calls: 6 };

try {
  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
    for (const theme of ['dark', 'light']) {
      for (const scene of ['text', 'calls']) {
        for (const style of styles) {
          const page = await open(ctx, `scene=${scene}&style=${style}&theme=${theme}`);
          const n = await sepCount(page);
          check(`${scene}/${style}/${theme}/${w}x${h}: manager sees every divider`, n === EXPECT[scene], `(${n}/${EXPECT[scene]})`);
          if (shots) {
            const base = `${scene}-${style}-${theme}-${w}x${h}`;
            await page.screenshot({ path: path.join(shots, `${base}.png`) });
            const more = await page.locator('[data-frame]').evaluate(e => e.scrollHeight > e.clientHeight + 4);
            if (more) {
              await page.locator('[data-frame]').evaluate(e => { e.scrollTop = e.scrollHeight; });
              await page.waitForTimeout(150);
              await page.screenshot({ path: path.join(shots, `${base}-scrolled.png`) });
            }
          }
          await page.close();
        }
      }
    }
    await ctx.close();
  }

  // Members see every one too (no manage rights), every style, both lists.
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1 });
    for (const scene of ['text', 'calls']) {
      for (const style of styles) {
        const page = await open(ctx, `scene=${scene}&style=${style}&theme=dark&member=1`);
        const n = await sepCount(page);
        check(`${scene}/${style}: MEMBER sees every divider`, n === EXPECT[scene], `(${n}/${EXPECT[scene]})`);
        await page.close();
      }
    }

    // Real drags.
    let page = await open(ctx, 'scene=calls&style=pill&theme=dark');
    const before = await page.evaluate(() => window.__requests.length);
    const src = await page.locator('[data-calls-divider-id="hang-last"]').boundingBox();
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2 + 12, { steps: 4 });
    const tgt = await page.locator('[data-calls-divider-id="top-last"]').boundingBox();
    await page.mouse.move(tgt.x + tgt.width / 2, tgt.y + tgt.height + 10, { steps: 25 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const calls = (await page.evaluate(() => window.__requests)).slice(before).filter(r => r.method === 'PATCH');
    const body = calls[0]?.body;
    const topC = body?.containers?.find(c => c.parent_category_id === null);
    check('calls drag: a divider dragged out of a Calls category lands at the Calls top (PATCH, list_kind calls)',
      !!topC && topC.list_kind === 'calls' && topC.items.some(i => i.id === 'hang-last' && i.kind === 'divider'), JSON.stringify(body));
    await page.close();

    page = await open(ctx, 'scene=text&style=pill&theme=dark');
    const b2 = await page.evaluate(() => window.__requests.length);
    const s2 = await page.locator('[data-divider-id="top-last"]').boundingBox();
    await page.mouse.move(s2.x + s2.width / 2, s2.y + s2.height / 2);
    await page.mouse.down();
    await page.mouse.move(s2.x + s2.width / 2, s2.y + s2.height / 2 + 12, { steps: 4 });
    const t2 = await page.locator('[data-divider-id="wood-first"]').boundingBox();
    await page.mouse.move(t2.x + t2.width / 2, t2.y + 2, { steps: 25 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const r2 = (await page.evaluate(() => window.__requests)).slice(b2).filter(r => r.method === 'PATCH');
    const wood = r2[0]?.body?.containers?.find(c => c.parent_category_id === 'wood');
    check('text drag: a top-of-list divider dropped into a sub-category lands there (PATCH)', !!wood && wood.items.some(i => i.id === 'top-last'), JSON.stringify(r2[0]?.body));
    await page.close();
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
