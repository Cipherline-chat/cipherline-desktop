// Server dialogs: screenshots (1280x800 full page + 2x clip of the dialog card) and behaviour checks.
//   TAG=x npx vite --config harness/server-dialogs.vite.config.ts            (serves :5342; PORT=... to move it)
//   LABEL=before OUT=<dir> node harness/server-dialogs-shots.mjs [scene ...]  (parent-commit checkout)
//   LABEL=after  OUT=<dir> CHECK=1 node harness/server-dialogs-shots.mjs [scene ...]
//   node harness/server-dialogs-shots.mjs --overview <OUT>   (overview.png from <OUT>/before + <OUT>/after card clips)
// Output: <OUT>/<LABEL>/<scene>--<state>.png (full) and <scene>--<state>.card.png (2x card clip).
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5342/harness/server-dialogs.html';

/* ───────────────────────── overview composite ───────────────────────── */
const ROWS = [
    ['Create a Server: empty', 'create--default'],
    ['Create a Server: filled', 'create--filled'],
    ['Create a Server: name too short (error)', 'create--error'],
    ['Create a Server: creating', 'create--loading'],
    ['Create a Server: server refused (API message)', 'create--api-error'],
    ['Create a Server: 50-character name', 'create--long'],
    ['Discord import: paste a link', 'import--link'],
    ['Discord import: not a template link (error)', 'import--link-error'],
    ['Discord import: fetching the template', 'import--link-loading'],
    ['Discord import: template not found (error)', 'import--link-notfound'],
    ['Discord import: preview', 'import--preview'],
    ['Discord import: preview, skipped list open', 'import--preview-skipped'],
    ['Discord import: preview, very long names', 'import--preview-long'],
    ['Discord import: position the icon (cropper, unchanged primitive)', 'import--cropper'],
    ['Discord import: icon chosen', 'import--icon'],
    ['Discord import: creating (the loading state the owner flagged)', 'import--creating'],
    ['Discord import: import failed (error)', 'import--import-error'],
    ['Join a Server: empty', 'join--default'],
    ['Join a Server: filled', 'join--filled'],
    ['Join a Server: invalid / expired (error)', 'join--error'],
    ['Join a Server: joining', 'join--loading'],
    ['Invite: checking', 'preview--loading'],
    ['Invite: preview', 'preview--valid'],
    ['Invite: preview, long name + description', 'preview--long'],
    ['Invite: arrival (carried through signup)', 'preview--arrival'],
    ['Invite: joining', 'preview--joining'],
    ['Invite: join refused (error)', 'preview--join-error'],
    ['Invite: already a member', 'preview--joined'],
    ['Invite: expired', 'preview--invalid'],
    ['Invite: could not load (retry)', 'preview--error'],
    ['Invite People: default', 'invite--default'],
    ['Invite People: creating a link', 'invite--loading'],
    ['Invite People: link settings open', 'invite--options'],
    ['Invite People: custom expiry and uses', 'invite--custom'],
    ['Invite People: copied', 'invite--copied'],
    ['Invite People: could not create (error)', 'invite--error'],
    ['Invite People: long server name', 'invite--long'],
    ['Invite People: friend sent (Sent state)', 'invite--sent'],
    ['Invite People: friend send in flight', 'invite--sending'],
    ['Invite People: friend send failed (Retry)', 'invite--send-error'],
    ['Invite People: friend search', 'invite--search'],
    ['Invite People: friend search, no match', 'invite--search-none'],
    ['Invite People: already-members marked', 'invite--member'],
    ['Invite People: settings changed, link updating', 'invite--updating'],
    ['Invite People: settings applied automatically', 'invite--applied'],
    ['Invite People: long friend name + long server name', 'invite--friends-long'],
    ['Create a Server at the 1000px minimum window', 'create--narrow'],
    ['Discord preview at the 1000x720 minimum window', 'import--preview-min'],
];
async function overview(dir) {
    const uri = f => existsSync(f) ? 'data:image/png;base64,' + readFileSync(f).toString('base64') : '';
    const cell = (label, n, tag) => {
        const u = uri(`${dir}/${label}/${n}.card.png`);
        return `<figure><figcaption>${tag}</figcaption>${u ? `<img src="${u}">` : '<div class="none">n/a</div>'}</figure>`;
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
      <h1>Server dialogs: before / after</h1><p class="sub">Create a Server, Discord import, Join a Server, invite preview, Invite People. Real components over stub data. Cards clipped at 2x.</p>${rows}`;
    const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1556, height: 800 }, deviceScaleFactor: 1 });
    await page.setContent(html);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${dir}/overview.png`, fullPage: true });
    await browser.close();
    console.log('overview', `${dir}/overview.png`);
}
if (process.argv[2] === '--overview') { await overview(process.argv[3]); process.exit(0); }

/* ───────────────────────── shots ───────────────────────── */
const LABEL = process.env.LABEL ?? 'after';
const OUT = (process.env.OUT ?? '/tmp/server-dialogs') + '/' + LABEL;
const CHECK = !!process.env.CHECK;
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

async function open(dialog, query = '', opts = {}) {
    const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 }, deviceScaleFactor: opts.dsf ?? 2, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    const errs = [];
    page.on('pageerror', e => { errs.push(e.message); });
    await page.goto(`${BASE}?d=${dialog}${query ? '&' + query : ''}`, { timeout: 90000 });
    await page.waitForSelector('[role=dialog], .mcard', { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    return { ctx, page, errs };
}

async function shoot(page, dialog, state, errs, vp) {
    await page.mouse.move(3, 3);
    await page.waitForTimeout(500);
    // Finish the kit's transitions (slow on a loaded box) so a shot never catches one half-way; looping ones are skipped.
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    const base = `${OUT}/${dialog}--${state}`;
    await page.screenshot({ path: `${base}.png`, timeout: 40000 });
    const card = page.locator('.mcard').last();
    let info = {};
    if (await card.count()) {
        const bb = await card.boundingBox();
        if (bb) {
            await page.screenshot({ path: `${base}.card.png`, timeout: 40000, clip: { x: Math.max(0, bb.x - 24), y: Math.max(0, bb.y - 24), width: Math.min(vp.width, bb.width + 48), height: Math.min(vp.height, bb.height + 48) } });
            info = { card: [Math.round(bb.width), Math.round(bb.height)] };
        }
    }
    console.log(`shot ${dialog}--${state}`, JSON.stringify(info), errs.length ? 'PAGEERRORS ' + errs.join(' | ') : '');
}

async function scene(dialog, state, query, actions = async () => {}, opts = {}) {
    if (only.length && !only.includes(dialog)) return;
    if (process.env.STATE && !process.env.STATE.split(',').includes(state)) return;   // STATE=updating,applied re-shoots just those scenes
    const { ctx, page, errs } = await open(dialog, query, opts);
    try { await actions(page); await shoot(page, dialog, state, errs, opts.viewport ?? { width: 1280, height: 800 }); }
    catch (e) {
        console.log(`FAILED ${dialog}--${state}: ${e.message.split('\n')[0]}`);
        try { await page.screenshot({ path: `${OUT}/${dialog}--${state}.FAILED.png` }); } catch {}
    } finally { await ctx.close(); }
}

// Buttons by their visible label (case-insensitive, whole label) so the old and new markup both match.
const btnAll = (page, re) => page.locator('.mcard button').filter({ hasText: new RegExp(re, 'i') });
const btn = (page, re) => btnAll(page, re).last();
const click = async (page, re, wait = 400) => { await btn(page, re).click(); await page.waitForTimeout(wait); };
const field = (page) => page.locator('.mcard input:not([type=file]):not([type=number])').first();
const fill = async (page, v) => { await field(page).fill(v); await page.waitForTimeout(150); };
const hover = async (page, sel) => { await page.locator(sel).first().hover(); };

const NAME = 'Game night';
const LONGNAME = 'The Absolutely Magnificent Westmarch Adventurers Guild';
const LINK = 'https://discord.new/BX8jqYy8vu3y';
const toPreview = async (page) => { await fill(page, LINK); await click(page, '^Preview template$', 900); };
// A real 160x160 PNG (gradient) for the icon picker, built with zlib.
import { deflateSync } from 'node:zlib';
const mkPng = (w, h) => {
    const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40 + (x * 200) / w; raw[o + 1] = 220 - (y * 120) / h; raw[o + 2] = 200 - (x * 90) / w; } }
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const PNG = mkPng(160, 160);

await scene('create', 'default', '');
await scene('create', 'filled', '', async (p) => { await fill(p, NAME); });
await scene('create', 'error', '', async (p) => { await fill(p, 'a'); await click(p, '^Create server$'); });
await scene('create', 'loading', 's=loading', async (p) => { await fill(p, NAME); await click(p, '^Create server$', 500); });
await scene('create', 'api-error', 's=api-error', async (p) => { await fill(p, NAME); await click(p, '^Create server$', 600); });
await scene('create', 'long', '', async (p) => { await fill(p, LONGNAME); });
await scene('import', 'link', '');
await scene('import', 'link-error', '', async (p) => { await fill(p, 'https://discord.com.evil.tld/template/x'); await click(p, '^Preview template$'); });
await scene('import', 'link-loading', 's=loading', async (p) => { await fill(p, LINK); await click(p, '^Preview template$', 500); });
await scene('import', 'link-notfound', 's=preview-error', async (p) => { await fill(p, LINK); await click(p, '^Preview template$', 800); });
await scene('import', 'preview', '', toPreview);
await scene('import', 'preview-skipped', '', async (p) => { await toPreview(p); await click(p, 'imported \\(\\d+\\)'); });
await scene('import', 'preview-long', 'long=1', toPreview);
await scene('import', 'cropper', '', async (p) => {
    await toPreview(p);
    await p.locator('input[type=file]').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: PNG });
    await p.waitForTimeout(1200);
});
await scene('import', 'icon', '', async (p) => {
    await toPreview(p);
    await p.locator('input[type=file]').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: PNG });
    await p.waitForTimeout(1200);
    await p.locator('.mcard button:has-text("Confirm"), .mcard button:has-text("Save"), .mcard button:has-text("Use"), .mcard button:has-text("Apply"), .mcard button:has-text("Done")').last().click();
    await p.waitForTimeout(700);
});
await scene('import', 'creating', 's=creating', async (p) => { await toPreview(p); await click(p, '^Create server$', 600); });
await scene('import', 'import-error', 's=import-error', async (p) => { await toPreview(p); await click(p, '^Create server$', 700); });
await scene('join', 'default', '');
await scene('join', 'filled', '', async (p) => { await fill(p, 'https://cipherline.chat/invite/AbCd1234'); });
await scene('join', 'error', 's=error', async (p) => { await fill(p, 'AbCd1234'); await click(p, '^Join server$', 600); });
await scene('join', 'loading', 's=loading', async (p) => { await fill(p, 'AbCd1234'); await click(p, '^Join server$', 500); });
await scene('preview', 'loading', 's=loading');
await scene('preview', 'valid', '');
await scene('preview', 'long', 'long=1');
await scene('preview', 'arrival', 'arrival=1', async (p) => { await p.waitForTimeout(1200); });
await scene('preview', 'joining', 's=joining', async (p) => { await click(p, '^Join'); await p.waitForTimeout(300); });
await scene('preview', 'join-error', 's=join-error', async (p) => { await click(p, '^Join', 700); });
await scene('preview', 'joined', 's=joined');
await scene('preview', 'invalid', 's=invalid');
await scene('preview', 'error', 's=error', async (p) => { await p.waitForTimeout(500); });
await scene('invite', 'default', '');
await scene('invite', 'loading', 's=loading');
await scene('invite', 'options', '', async (p) => { await click(p, 'link settings'); });
await scene('invite', 'custom', '', async (p) => { await click(p, 'link settings'); await btnAll(p, '^Custom').first().click(); await p.waitForTimeout(200); await btnAll(p, '^Custom').last().click(); await p.waitForTimeout(300); });
await scene('invite', 'copied', '', async (p) => { await click(p, 'Copy link', 500); });
await scene('invite', 'error', 's=error');
await scene('invite', 'long', 'long=1');
const inviteBtn = (p) => btnAll(p, '^\\s*Invite').first();
await scene('invite', 'sent', 's=sent', async (p) => { await inviteBtn(p).click(); await p.waitForTimeout(1200); });
await scene('invite', 'sending', 's=sending', async (p) => { await inviteBtn(p).click(); await p.waitForTimeout(300); });
await scene('invite', 'send-error', 's=send-error', async (p) => { await inviteBtn(p).click(); await p.waitForTimeout(1200); });
await scene('invite', 'search', '', async (p) => { await p.locator('.mcard .srch input').fill('a'); await p.waitForTimeout(300); });
await scene('invite', 'search-none', '', async (p) => { await p.locator('.mcard .srch input').fill('zzz'); await p.waitForTimeout(300); });
await scene('invite', 'member', 's=member', async (p) => { await p.waitForTimeout(600); });
await scene('invite', 'updating', 's=updating', async (p) => { await click(p, 'link settings'); await btnAll(p, '^10$').first().click(); await p.waitForTimeout(250); });
await scene('invite', 'applied', '', async (p) => { await click(p, 'link settings'); await btnAll(p, '^10$').first().click(); await p.waitForTimeout(2200); });
await scene('invite', 'friends-long', 'long=1', async (p) => { await p.waitForTimeout(300); });
await scene('create', 'narrow', '', async (p) => { await fill(p, NAME); }, { viewport: { width: 1000, height: 720 } });
await scene('import', 'preview-min', '', toPreview, { viewport: { width: 1000, height: 720 } });

/* ───────────────────────── behaviour checks (after tree only) ───────────────────────── */
if (CHECK) {
    const checks = await import('./server-dialogs-checks.mjs');
    await checks.run({ open, check });
}
await browser.close();
if (CHECK) { console.log(failures ? `${failures} CHECK(S) FAILED` : 'all checks passed'); }
process.exit(failures ? 1 : 0);
