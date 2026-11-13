// Dialogs-restyle: screenshots (1280x800 full page + 2x clip of the dialog card) and behaviour checks.
//   TAG=x npx vite --config harness/dialogs-restyle.vite.config.ts           (serves :5341; PORT=... to move it)
//   LABEL=before V=old OUT=<dir> node harness/dialogs-restyle-shots.mjs [scene ...]   (parent-commit checkout)
//   LABEL=after  V=new OUT=<dir> CHECK=1 node harness/dialogs-restyle-shots.mjs [scene ...]
//   node harness/dialogs-restyle-shots.mjs --overview <OUT>   (composite overview.png from <OUT>/before + <OUT>/after card clips)
// Output: <OUT>/<LABEL>/<scene>--<state>.png (full) and <scene>--<state>.card.png (2x card clip).
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5341/harness/dialogs-restyle.html';

/* ───────────────────────── overview composite ───────────────────────── */
// Rows: label | before | after. One tall PNG: the owner can see the whole change at a glance.
const ROWS = [
    ['Block user (every menu: sidebar, profile, member list, DM header)', 'block--default', 'The request that started this'],
    ['Block user, long name', 'block--long-name', ''],
    ['Block (DM header menu: was a different hand-rolled overlay)', 'block-dm--default', ''],
    ['Remove friend (Dashboard menus had NO confirmation)', 'unfriend--default', ''],
    ['Remove device (was native window.confirm)', 'devices-remove--default', ''],
    ['Sign out other devices (was native window.confirm)', 'devices-others--default', ''],
    ['Delete server', 'delete-server--default', ''],
    ['Delete server, wrong password', 'delete-server--error', ''],
    ['Transfer ownership', 'transfer--default', ''],
    ['Report user', 'report--default', ''],
    ['Report user, filled', 'report--filled', ''],
    ['Report sent', 'report--sent', ''],
    ['Animated avatar', 'animated--avatar', ''],
    ['Rename call', 'rename--default', ''],
    ['Change nickname', 'nickname--default', ''],
    ['Disable authenticator', 'totp--disable', ''],
    ['Regenerate backup codes', 'totp--regen-auth', ''],
    ['New backup codes', 'totp--regen-codes', ''],
    ['Channel topic', 'topic--default', ''],
];
async function overview(dir) {
    const uri = f => existsSync(f) ? 'data:image/png;base64,' + readFileSync(f).toString('base64') : '';
    const cell = (label, n, tag) => {
        const u = uri(`${dir}/${label}/${n}.card.png`);
        return `<figure><figcaption>${tag}</figcaption>${u ? `<img src="${u}">` : '<div class="none">unchanged</div>'}</figure>`;
    };
    const rows = ROWS.filter(([, n]) => existsSync(`${dir}/after/${n}.card.png`))
        .map(([title, n]) => `<section><h3>${title}</h3><div class="row">${cell('before', n, 'BEFORE')}${cell('after', n, 'AFTER')}</div></section>`).join('');
    const html = `<!doctype html><meta charset=utf-8><style>
      body{margin:0;padding:28px;background:#05080F;color:#A7B3D4;font:600 13px Nunito,system-ui,sans-serif;width:1500px}
      h1{margin:0 0 6px;font-size:22px;color:#F4F7FF}p.sub{margin:0 0 20px;color:#5E6B8F}
      h3{margin:26px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8fa0c8}
      .row{display:flex;gap:24px;align-items:flex-start}figure{margin:0;flex:1}
      figcaption{font-size:11px;font-weight:800;letter-spacing:.1em;margin-bottom:6px;color:#25E0C8}
      figure:first-child figcaption{color:#FF6B5E}
      img{display:block;max-width:100%;height:auto;border-radius:6px;outline:1px solid #1E2848}
      .none{padding:40px;border:1px dashed #243056;border-radius:6px;color:#5E6B8F}</style>
      <h1>Dialogs restyle: before / after</h1><p class="sub">Real components over stub data. Cards clipped at 2x.</p>${rows}`;
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1556, height: 800 }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/overview.png`, fullPage: true });
    await browser.close();
    console.log('overview', `${dir}/overview.png`);
}
if (process.argv[2] === '--overview') { await overview(process.argv[3]); process.exit(0); }

/* ───────────────────────── shots ───────────────────────── */
const LABEL = process.env.LABEL ?? 'after';
const V = process.env.V ?? 'new';
const OUT = (process.env.OUT ?? '/tmp/dialogs-restyle') + '/' + LABEL;
const CHECK = !!process.env.CHECK;
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

async function open(dialog, query = '', opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: opts.dsf ?? 2, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const errs = [];
    page.on('pageerror', e => { errs.push(e.message); });
    await page.goto(`${BASE}?d=${dialog}&v=${V}${query ? '&' + query : ''}`, { timeout: 90000 });
    await page.waitForSelector('[role=dialog], .mcard, .fade-pop-enter', { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    return { ctx, page, errs };
}

async function shoot(page, dialog, state, errs) {
    await page.mouse.move(3, 3);
    await page.waitForTimeout(500);
    const base = `${OUT}/${dialog}--${state}`;
    await page.screenshot({ path: `${base}.png` });
    const card = page.locator('.mcard, .fade-pop-enter, [data-shot]').last();
    let info = {};
    if (await card.count()) {
        const bb = await card.boundingBox();
        if (bb) {
            await page.screenshot({ path: `${base}.card.png`, clip: { x: Math.max(0, bb.x - 24), y: Math.max(0, bb.y - 24), width: Math.min(1280, bb.width + 48), height: Math.min(800, bb.height + 48) } });
            info = { card: [Math.round(bb.width), Math.round(bb.height)] };
        }
    }
    console.log(`shot ${dialog}--${state}`, JSON.stringify(info), errs.length ? 'PAGEERRORS ' + errs.join(' | ') : '');
}

async function scene(dialog, state, query, actions = async () => {}) {
    if (only.length && !only.includes(dialog)) return;
    const { ctx, page, errs } = await open(dialog, query);
    try { await actions(page); await shoot(page, dialog, state, errs); }
    catch (e) {
        console.log(`FAILED ${dialog}--${state}: ${e.message.split('\n')[0]}`);
        try { await page.screenshot({ path: `${OUT}/${dialog}--${state}.FAILED.png` }); } catch {}
    } finally { await ctx.close(); }
}

const click = async (page, t) => { await page.locator(`button:has-text("${t}")`).first().click(); await page.waitForTimeout(500); };
const pickReason = async (page) => {
    await page.locator('.mcard [role=combobox], .mcard .sel, .mcard button:has-text("Select a reason")').first().click();
    await page.waitForTimeout(300);
    await page.locator('text=Harassment or bullying').last().click();
    await page.waitForTimeout(300);
};
const digits = async (page, s) => { await page.locator('.mcard input').first().focus(); await page.keyboard.type(s, { delay: 60 }); await page.waitForTimeout(700); };

await scene('block', 'default', '');
await scene('block', 'long-name', 's=long');
await scene('block-dm', 'default', '');
await scene('unfriend', 'default', '');
await scene('unfriend', 'long-name', 's=long');
await scene('devices-remove', 'default', '');
await scene('devices-others', 'default', '');
await scene('delete-server', 'default', '');
await scene('delete-server', 'error', 'pw=1&err=1');
await scene('transfer', 'default', '');
await scene('report', 'default', '');
await scene('report', 'filled', 'snippet=1', async (p) => { await pickReason(p); await p.locator('textarea').first().fill('Repeatedly sent threatening messages after I asked them to stop.'); });
await scene('report', 'sent', 'snippet=1', async (p) => { await pickReason(p); await click(p, 'Submit report'); await p.waitForTimeout(600); });
await scene('animated', 'avatar', 'kind=avatar');
await scene('animated', 'banner', 'kind=banner');
await scene('rename', 'default', '');
await scene('nickname', 'default', '');
await scene('nickname', 'error', 'err=1');
await scene('topic', 'default', '');
await scene('totp', 'disable', '', async (p) => { await click(p, 'Disable'); await p.waitForTimeout(500); });
await scene('totp', 'regen-auth', '', async (p) => { await click(p, 'Regen codes'); await p.waitForTimeout(500); });
await scene('totp', 'regen-codes', '', async (p) => { await click(p, 'Regen codes'); await p.waitForTimeout(500); await digits(p, '123456'); });

/* ───────────────────────── behaviour checks (after tree only) ───────────────────────── */
if (CHECK) {
    const calls = async (page) => page.evaluate(() => ({ confirm: window.__log.filter(a => a[0] === 'confirm').length, close: window.__log.filter(a => a[0] === 'close' || a[0] === 'cancel').length }));
    for (const [d, label, kind] of [['block', 'Block', 'block'], ['unfriend', 'Remove', 'unfriend']]) {
        const { ctx, page } = await open(d);
        const info = await page.evaluate(() => ({
            title: document.querySelector('.dlg-title')?.textContent,
            focus: document.activeElement?.textContent?.trim(),
            buttons: [...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent.trim()),
            danger: !!document.querySelector('.dlg-head-icon--danger'),
        }));
        check(`${kind}: names the person`, /Mira/.test(info.title ?? ''), info.title);
        check(`${kind}: danger icon tile`, info.danger);
        check(`${kind}: footer = Cancel + ${label}`, info.buttons.join('|') === `Cancel|${label}`, info.buttons.join('|'));
        check(`${kind}: focus starts on Cancel`, info.focus === 'Cancel', info.focus);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        let r = await calls(page);
        check(`${kind}: Enter on the default focus cancels, never confirms`, r.confirm === 0 && r.close === 1, JSON.stringify(r));
        await ctx.close();
        const b = await open(d);
        await b.page.locator(`.dlg-foot-actions button:has-text("${label}")`).dblclick();
        await b.page.waitForTimeout(700);
        r = await calls(b.page);
        check(`${kind}: double-click on the danger button confirms exactly once`, r.confirm === 1 && r.close === 1, JSON.stringify(r));
        await b.ctx.close();
        const c = await open(d);
        await c.page.keyboard.press('Escape');
        await c.page.waitForTimeout(600);
        r = await calls(c.page);
        check(`${kind}: Escape cancels without acting`, r.confirm === 0 && r.close === 1, JSON.stringify(r));
        await c.ctx.close();
    }
    {
        const { ctx, page } = await open('block', '', { reduced: true });
        const op = await page.evaluate(() => getComputedStyle(document.querySelector('.mcard')).opacity);
        check('reduced motion: block card fully visible at rest', op === '1', op);
        await ctx.close();
    }
    {
        const { ctx, page } = await open('delete-server');
        const info = await page.evaluate(() => ({
            focus: document.activeElement?.getAttribute('type'),
            disabled: [...document.querySelectorAll('.dlg-foot-actions button')].find(b => /Delete server/.test(b.textContent))?.disabled,
        }));
        check('delete-server: password field focused, delete disabled while empty', info.focus === 'password' && info.disabled === true, JSON.stringify(info));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const submitted = await page.evaluate(() => window.__log.filter(a => a[0] === 'submit').length);
        check('delete-server: Enter with an empty password submits nothing', submitted === 0);
        await ctx.close();
    }
}
await browser.close();
process.exit(failures ? 1 : 0);
