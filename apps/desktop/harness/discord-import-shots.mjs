// "Import from Discord" wizard: screenshots (Dark + Light x 1366x768 + 1000x720) and fit checks (all four window sizes).
//   npx vite --config harness/discord-import.vite.config.ts        (serves :5352; PORT=... to move it)
//   OUT=<dir> node harness/discord-import-shots.mjs                 (env: PW_CHROMIUM_EXE, BASE)
// Output: <OUT>/<theme>-<WxH>-<NN>-<scene>.png. A MOCK Discord only: no real token or server is ever involved.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5352/harness/discord-import.html';
const OUT = process.env.OUT ?? '/tmp/discord-import-shots';
mkdirSync(OUT, { recursive: true });

// A fake token-shaped string. It is not a credential for anything.
const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const SIZES = [
    { w: 1366, h: 768, dsf: 1, shots: true }, { w: 1000, h: 720, dsf: 1, shots: true },
    { w: 1920, h: 1080, dsf: 1, shots: false }, { w: 1280, h: 800, dsf: 1.5, shots: false },
];
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const ONLY = process.env.SCENES ? process.env.SCENES.split(',') : null;      // SCENES=preview,done re-shoots just those
const ONLY_SIZE = process.env.SIZE ?? null;                                  // SIZE=1366 limits to one width

let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

const btn = (p, re) => p.locator('.mcard button').filter({ hasText: new RegExp(re, 'i') }).last();
const click = async (p, re, ms = 500) => { await btn(p, re).click(); await p.waitForTimeout(ms); };

/** Walk the wizard to `upto`; every step is a real click against the real components. */
async function walk(p, upto) {
    const order = ['token', 'token-error', 'token-saved', 'guild', 'preview', 'consent', 'consent-checked', 'run', 'done'];
    const at = order.indexOf(upto);
    if (upto === 'token') return;
    if (upto === 'token-error') { await p.locator('input[type=password]').fill(FAKE_TOKEN); await click(p, 'Check token', 900); return; }
    await p.locator('input[type=password]').fill(FAKE_TOKEN);
    await click(p, 'Check token', 900);
    if (upto === 'token-saved') return;
    await click(p, '^Continue$', 900);
    if (upto === 'guild') return;
    await p.locator('[role=radio]').first().click();
    await p.waitForTimeout(200);
    await click(p, '^Preview$', 1600);
    if (upto === 'preview') return;
    await click(p, '^Continue$');
    if (upto === 'consent') return;
    await p.locator('[role=checkbox]').last().click();
    await p.waitForTimeout(300);
    if (upto === 'consent-checked') return;
    await click(p, 'Import server', upto === 'run' ? 800 : 6500);
    void at;
}

const SCENES = [
    ['token', ''], ['token-error', 'token=bad'], ['token-saved', ''], ['guild', ''],
    ['preview', ''], ['consent', ''], ['consent-checked', ''], ['run', 'run=hang'], ['done', ''],
];

async function fit(p, label) {
    // The card must fit the window, the body scrolls inside it, and nothing overflows sideways.
    const r = await p.evaluate(() => {
        const card = document.querySelector('.mcard:last-of-type') ?? document.querySelector('.mcard');
        if (!card) return null;
        const b = card.getBoundingClientRect();
        const body = card.querySelector('.dlg-body');
        const foot = card.querySelector('.dlg-foot');
        const f = foot ? foot.getBoundingClientRect() : null;
        return {
            top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right),
            vh: innerHeight, vw: innerWidth,
            hScroll: body ? body.scrollWidth > body.clientWidth + 1 : false,
            footVisible: f ? f.bottom <= innerHeight + 1 && f.top >= 0 : true,
        };
    });
    if (!r) { check(`${label}: card present`, false); return; }
    check(`${label}: card inside the window`, r.top >= 0 && r.bottom <= r.vh + 1 && r.left >= 0 && r.right <= r.vw, `${r.top}..${r.bottom}/${r.vh}`);
    check(`${label}: footer buttons visible`, r.footVisible);
    check(`${label}: no sideways scroll`, !r.hScroll);
}

for (const theme of THEMES) {
    for (const sz of SIZES) {
        if (ONLY_SIZE && String(sz.w) !== ONLY_SIZE) continue;
        let n = 0;
        for (const [scene, extra] of SCENES) {
            n++;
            if (ONLY && !ONLY.includes(scene)) continue;
            if (!sz.shots && !['token', 'preview', 'consent', 'done'].includes(scene)) continue;   // the two extra sizes: fit checks on the tall scenes only
            const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dsf, reducedMotion: 'reduce' });
            const page = await ctx.newPage();
            page.setDefaultTimeout(15000);
            const errs = [];
            page.on('pageerror', e => errs.push(e.message));
            try {
                await page.goto(`${BASE}?theme=${theme}${extra ? '&' + extra : ''}`, { timeout: 90000 });
                await page.waitForSelector('.mcard', { timeout: 20000 });
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(700);
                await walk(page, scene);
                await page.mouse.move(2, 2);
                await page.waitForTimeout(400);
                const label = `${theme} ${sz.w}x${sz.h}@${sz.dsf} ${scene}`;
                await fit(page, label);
                if (scene === 'token-saved' || scene === 'run' || scene === 'done') {
                    const html = await page.content();
                    check(`${label}: token never in the page`, !html.includes(FAKE_TOKEN));
                }
                if (sz.shots) await page.screenshot({ path: `${OUT}/${theme}-${sz.w}x${sz.h}-${String(n).padStart(2, '0')}-${scene}.png` });
            } catch (e) {
                failures++;
                console.log(`FAILED ${theme} ${sz.w}x${sz.h} ${scene}: ${e.message.split('\n')[0]}`);
                try { await page.screenshot({ path: `${OUT}/FAILED-${theme}-${sz.w}x${sz.h}-${scene}.png` }); } catch {}
            }
            if (errs.length) { failures++; console.log('PAGEERRORS', scene, errs.join(' | ')); }
            await ctx.close();
        }
    }
}
await browser.close();
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
