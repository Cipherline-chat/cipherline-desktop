// Kick / ban dialog: screenshots + behaviour checks, real Chromium at 1280x800.
//
//   TAG=x npx vite --config harness/dialogs-wave2.vite.config.ts        (serves :5331; PORT=… to move it)
//   OUT=<dir>/after node harness/dialogs-wave2-shots.mjs                 (set CHECK=1 on the "after" tree to run the checks)
//   node harness/dialogs-wave2-shots.mjs --sheets <before-dir> <after-dir> <sheet-dir>
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5331/harness/dialogs-wave2.html';
const DSF = Number(process.env.DSF ?? 1.5);

const SHOTS = {
    'kick-1-default': '?d=kick',
    'ban-1-default': '?d=ban',
    'kick-2-long-names': '?d=kick&s=long',
    'ban-2-long-names': '?d=ban&s=long',
};
const GROUPS = { kick: ['kick-1-default', 'kick-2-long-names'], ban: ['ban-1-default', 'ban-2-long-names'] };

async function sheets(beforeDir, afterDir, outDir) {
    mkdirSync(outDir, { recursive: true });
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    for (const [group, names] of Object.entries(GROUPS)) {
        const uri = f => existsSync(f) ? 'data:image/png;base64,' + readFileSync(f).toString('base64') : '';
        const cells = names.map(n => `<div class="row"><div class="lab">${n}</div><div class="pair"><figure><figcaption>before</figcaption><img src="${uri(`${beforeDir}/${n}.png`)}"></figure><figure><figcaption>after</figcaption><img src="${uri(`${afterDir}/${n}.png`)}"></figure></div></div>`).join('');
        const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#05070f;font:600 20px sans-serif;color:#8fa0c8;padding:24px}
.row{margin-bottom:36px}.lab{font-size:26px;color:#e9eefc;margin-bottom:10px}.pair{display:flex;gap:24px}figure{margin:0;flex:1}
figcaption{margin-bottom:6px;letter-spacing:.1em;text-transform:uppercase;font-size:14px}img{width:100%;display:block;border:1px solid #1e2848}</style>${cells}`;
        const page = await browser.newPage({ viewport: { width: 3200, height: 800 } });
        await page.setContent(html);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${outDir}/${group}.png`, fullPage: true });
        await page.close();
        console.log('sheet', `${outDir}/${group}.png`);
    }
    await browser.close();
}
if (process.argv[2] === '--sheets') { await sheets(process.argv[3], process.argv[4], process.argv[5]); process.exit(0); }

const OUT = process.env.OUT ?? '/tmp/dialogs-wave2-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
async function open(q, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: DSF, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + q + (process.env.OLD ? '&old=1' : ''));
    await page.waitForSelector('.mcard, .fade-pop-exit, [class*=max-w-sm]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    return { ctx, page };
}
try {
    for (const [name, q] of Object.entries(SHOTS)) {
        const { ctx, page } = await open(q);
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/${name}.png` });
        console.log('shot', name);
        await ctx.close();
    }
    if (process.env.CHECK) {
        for (const kind of ['kick', 'ban']) {
            const { ctx, page } = await open(`?d=${kind}`);
            const Kind = kind[0].toUpperCase() + kind.slice(1);
            const info = await page.evaluate(() => ({
                title: document.querySelector('.dlg-title')?.textContent,
                focus: document.activeElement?.textContent?.trim(),
                buttons: [...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent.trim()),
            }));
            check(`${kind}: title names member + server`, info.title === `${Kind} Alex from Game night?`, info.title);
            check(`${kind}: focus starts on Cancel`, info.focus === 'Cancel', info.focus);
            check(`${kind}: footer = Cancel + ${Kind}`, info.buttons.join('|') === `Cancel|${Kind}`, info.buttons.join('|'));
            await page.keyboard.press('Enter'); // Enter on the focused Cancel must NOT confirm
            await page.waitForTimeout(500);
            let r = await page.evaluate(() => ({ c: window.__confirmed, x: window.__closed }));
            check(`${kind}: Enter on the default focus cancels, never confirms`, r.c === 0 && r.x === 1, JSON.stringify(r));
            await page.click('#reopen'); await page.waitForTimeout(600);
            await page.click(`.dlg-foot-actions button:has-text("${Kind}")`); await page.waitForTimeout(500);
            r = await page.evaluate(() => ({ c: window.__confirmed, x: window.__closed }));
            check(`${kind}: primary fires onConfirm once and closes`, r.c === 1 && r.x === 2, JSON.stringify(r));
            await page.click('#reopen'); await page.waitForTimeout(600);
            await page.keyboard.press('Escape'); await page.waitForTimeout(500);
            r = await page.evaluate(() => ({ c: window.__confirmed, x: window.__closed }));
            check(`${kind}: Escape cancels`, r.c === 1 && r.x === 3, JSON.stringify(r));
            await ctx.close();
        }
        const { ctx, page } = await open('?d=ban', { reduced: true });
        const op = await page.evaluate(() => getComputedStyle(document.querySelector('.mcard')).opacity);
        check('reduced motion: card fully visible at rest', op === '1', op);
        await ctx.close();
    }
} finally {
    await browser.close();
}
process.exit(failures ? 1 : 0);
