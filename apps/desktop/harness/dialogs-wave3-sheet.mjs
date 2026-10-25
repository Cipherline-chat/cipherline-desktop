// Contact sheets from the shots script's card clips.
//   OUT=<dir> node harness/dialogs-wave3-sheet.mjs <dialog> [<dialog> ...]
// Writes <OUT>/sheets/<dialog>.png: one row per state, BEFORE on the left and AFTER on the right
// (a dialog with no 'after' set — a "kept as is" one — shows only the before column, labelled KEPT).
import { createRequire } from 'node:module';
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const OUT = process.env.OUT ?? '/tmp/dialogs-wave3';
mkdirSync(`${OUT}/sheets`, { recursive: true });
const names = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const list = (label) => existsSync(`${OUT}/${label}`) ? readdirSync(`${OUT}/${label}`).filter(f => f.endsWith('.card.png')) : [];
for (const d of names) {
    const states = [...new Set([...list('before'), ...list('after')].filter(f => f.startsWith(d + '--')).map(f => f.slice(d.length + 2, -9)))];
    const hasAfter = states.some(s => existsSync(`${OUT}/after/${d}--${s}.card.png`));
    const cell = (label, s, tag) => existsSync(`${OUT}/${label}/${d}--${s}.card.png`)
        ? `<figure><figcaption>${tag}</figcaption><img src="file://${OUT}/${label}/${d}--${s}.card.png"></figure>` : '<figure></figure>';
    const rows = states.map(s => `<section><h3>${s}</h3><div class="row">${cell('before', s, hasAfter ? 'BEFORE' : 'KEPT AS IS')}${hasAfter ? cell('after', s, 'AFTER') : ''}</div></section>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:24px;background:#05080F;color:#A7B3D4;font:600 13px Nunito,system-ui,sans-serif}
      h1{margin:0 0 18px;font-size:20px;color:#F4F7FF}h3{margin:18px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5E6B8F}
      .row{display:flex;gap:20px;align-items:flex-start}figure{margin:0}figcaption{font-size:11px;font-weight:800;letter-spacing:.1em;margin-bottom:6px;color:#25E0C8}
      img{display:block;max-width:760px;height:auto;border-radius:6px;outline:1px solid #1E2848}</style>
      <h1>${d}${hasAfter ? '' : ' — kept as is'}</h1>${rows}`;
    const f = `${OUT}/sheets/${d}.html`;
    writeFileSync(f, html);
    const page = await browser.newPage({ viewport: { width: hasAfter ? 1680 : 900, height: 400 }, deviceScaleFactor: 1 });
    await page.goto('file://' + f);
    await page.waitForLoadState('load');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/sheets/${d}.png`, fullPage: true });
    await page.close();
    console.log('sheet', d, states.length, 'states', hasAfter ? 'before+after' : 'kept');
}
await browser.close();
