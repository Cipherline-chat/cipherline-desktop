// Discord HISTORY import against an ISOLATED local API: one real import per (theme x window size), screenshots + checks.
//   SETUP=<json from discord-history-setup.mjs> OUT=<dir> node harness/discord-history-shots.mjs
//   env: BASE (default http://127.0.0.1:5353/harness/discord-history.html), REDIS (container whose throttle counters are
//        reset between runs; the ISOLATED one only), THEMES, SIZE, PW_CHROMIUM_EXE
// Every request the page makes to anything but 127.0.0.1 is BLOCKED and counted (must be zero to Cipherline hosts).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5353/harness/discord-history.html';
const OUT = process.env.OUT ?? '/tmp/discord-history-shots';
const SETUP = readFileSync(process.env.SETUP, 'utf8');
const REDIS = process.env.REDIS ?? 'clih-redis';
if (!/^clih-/.test(REDIS)) throw new Error('only the isolated redis may be flushed');
mkdirSync(OUT, { recursive: true });
const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const SIZES = [
    { w: 1366, h: 768, dsf: 1, all: true }, { w: 1000, h: 720, dsf: 1, all: true },
    { w: 1920, h: 1080, dsf: 1, all: false }, { w: 1280, h: 800, dsf: 1.5, all: false },
];
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const ONLY_SIZE = process.env.SIZE ?? null;
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const btn = (p, re) => p.locator('.mcard button').filter({ hasText: new RegExp(re, 'i') }).last();
const click = async (p, re, ms = 500) => { await btn(p, re).click(); await p.waitForTimeout(ms); };

async function fitModal(p, label) {
    const r = await p.evaluate(() => {
        const card = document.querySelector('.mcard'); if (!card) return null;
        const b = card.getBoundingClientRect(); const body = card.querySelector('.dlg-body'); const foot = card.querySelector('.dlg-foot');
        const f = foot ? foot.getBoundingClientRect() : null;
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, vh: innerHeight, vw: innerWidth, hScroll: body ? body.scrollWidth > body.clientWidth + 1 : false, foot: f ? f.bottom <= innerHeight + 1 && f.top >= 0 : true };
    });
    if (!r) return check(`${label}: card present`, false);
    check(`${label}: card inside the window, footer visible, no sideways scroll`, r.top >= 0 && r.bottom <= r.vh + 1 && r.left >= 0 && r.right <= r.vw && r.foot && !r.hScroll);
}

for (const theme of THEMES) {
    for (const sz of SIZES) {
        if (ONLY_SIZE && String(sz.w) !== ONLY_SIZE) continue;
        execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']); // the ISOLATED stack's throttle counters only
        const tag = `${theme}-${sz.w}x${sz.h}${sz.dsf !== 1 ? '@' + sz.dsf : ''}`;
        const shot = async (p, name) => { await p.mouse.move(2, 2); await p.waitForTimeout(300); await p.screenshot({ path: `${OUT}/${tag}-${name}.png` }); };
        const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dsf, reducedMotion: 'reduce' });
        const blocked = [];
        await ctx.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === '127.0.0.1') return route.continue();
            blocked.push(u.hostname); return route.abort();
        });
        const page = await ctx.newPage();
        page.setDefaultTimeout(20000);
        const errs = []; page.on('pageerror', e => errs.push(e.message));
        try {
            await page.goto(`${BASE}?theme=${theme}#${encodeURIComponent(Buffer.from(SETUP).toString('base64'))}`, { timeout: 90000 });
            await page.waitForSelector('.mcard', { timeout: 30000 });
            const apiBase = await page.evaluate(() => window.__apiBase);
            check(`${tag}: network target is the isolated local API`, /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(apiBase), apiBase);
            await page.waitForTimeout(600);
            // token -> add the bot (invite, list refreshes itself) -> preview (wizard v2)
            await page.locator('input[type=password]').fill(FAKE_TOKEN);
            await click(page, 'Check token', 900);
            await click(page, '^Continue$', 900);
            await click(page, '^\\s*Open invite link$', 300);
            await page.locator('[role=radio]').first().waitFor({ timeout: 15000 });
            await page.waitForTimeout(200);
            await click(page, '^Preview$', 2000);
            const section = page.locator('[data-testid=history-section]');
            check(`${tag}: preview offers messages`, await section.count() === 1);
            // Keep the run short: no icon / emoji copy (phase 1, covered by its own harness).
            for (const lbl of [/Copy the server/, /custom emoji/]) {
                const cb = page.locator('.mcard [role=checkbox]').filter({ hasText: lbl });
                if (await cb.count()) await cb.first().click();
            }
            await section.scrollIntoViewIfNeeded();
            await fitModal(page, `${tag} preview`);
            if (sz.all) await shot(page, '01-preview-messages');
            await click(page, '^Continue$');
            const cont = await btn(page, 'Import server').isDisabled();
            const boxes = page.locator('.mcard [role=checkbox]');
            check(`${tag}: consent has three boxes and blocks the run until all are ticked`, (await boxes.count()) === 3 && cont);
            for (let i = 0; i < 3; i++) { await boxes.nth(i).click(); await page.waitForTimeout(120); }
            await fitModal(page, `${tag} consent`);
            if (sz.all) await shot(page, '02-consent');
            await btn(page, 'Import server').click();
            await page.waitForSelector('[data-testid=run-label]', { timeout: 20000 });
            await page.waitForTimeout(250);
            if (sz.all) await shot(page, '03-run');
            await page.waitForSelector('[data-testid=history-report]', { timeout: 120000 });
            await page.waitForTimeout(500);
            const report = await page.locator('[data-testid=history-report]').innerText();
            check(`${tag}: report counts the rules channel's messages and its pins`, /rules — 9 messages, 3 pins saved and pinned/.test(report), report.split('\n')[0]);
            await fitModal(page, `${tag} done`);
            if (sz.all) await shot(page, '04-report');
            check(`${tag}: bot token never in the page`, !(await page.content()).includes(FAKE_TOKEN));
            await click(page, '^Open server$', 1200);
            await page.waitForSelector('[data-testid=keep-channels]', { timeout: 20000 });
            await page.waitForTimeout(400);
            const keepBtn = page.locator('[data-testid=keep-channels] li').filter({ hasText: 'rules' }).locator('button');
            check(`${tag}: popup offers "Save all" for #rules (it fits)`, (await keepBtn.count()) === 1 && !(await keepBtn.isDisabled()));
            await fitModal(page, `${tag} keep`);
            await shot(page, '05-popup');
            await click(page, '^Done$', 600);
            // Channel view: real rows read back from the API through the app's ingest gates.
            await page.evaluate(() => window.__showChat());
            await page.waitForSelector('#chat .cl-msg-row', { timeout: 20000 });
            await page.waitForTimeout(1500);
            const chat = await page.evaluate(() => window.__chat);
            check(`${tag}: rows read back, imported ones carry the server mark`, chat.marked >= 9 && chat.rows === chat.marked + 1, JSON.stringify(chat));
            const facts = await page.evaluate(() => {
                const rows = [...document.querySelectorAll('#chat .cl-msg-row')];
                const forged = rows.find(r => r.textContent.includes('Totally me, Alex'));
                const head = forged && forged.querySelector('.cl-msg-head');
                return {
                    forgedHead: head ? head.textContent : null,
                    forgedHasImportedName: !!(forged && forged.querySelector('[data-imported-author-name]')),
                    suffixes: [...document.querySelectorAll('[data-imported-author-suffix]')].map(e => e.textContent),
                    names: [...document.querySelectorAll('[data-imported-author-name]')].map(e => e.textContent),
                };
            });
            check(`${tag}: POSITIVE CONTROL: a normal message claiming "Alex" renders as its real sender (sam)`, !!facts.forgedHead && facts.forgedHead.startsWith('sam') && !facts.forgedHasImportedName, facts.forgedHead ?? 'not found');
            check(`${tag}: imported authors render (Alex, Sam, Riley Q, FarmBot)`, ['Alex', 'Sam', 'Riley Q', 'FarmBot'].every(n => facts.names.includes(n)), facts.names.join(','));
            check(`${tag}: collision: Sam shows "· @samwise.k", Alex has no suffix`, facts.suffixes.length > 0 && facts.suffixes.every(s => s.includes('@samwise.k')), facts.suffixes.join(','));
            await shot(page, '06-channel');
            const sam = page.locator('[data-imported-author-name]').filter({ hasText: /^Sam$/ }).first();
            await sam.scrollIntoViewIfNeeded(); await sam.click(); await page.waitForTimeout(400);
            const card = await page.locator('[data-imported-author-card]').innerText().catch(() => '');
            check(`${tag}: clicking an imported author opens "Not on Cipherline yet", never a profile`, card.includes('Not on Cipherline yet') && !(await page.evaluate(() => window.__log.some(l => l[0] === 'open-profile'))));
            await page.screenshot({ path: `${OUT}/${tag}-07-not-on-cipherline-card.png` });
            await page.keyboard.press('Escape'); await page.waitForTimeout(300);
            check(`${tag}: Escape closes the card`, (await page.locator('[data-imported-author-card]').count()) === 0);
            await page.evaluate(() => window.__showChat({ pins: true }));
            await page.waitForTimeout(1500);
            const pinsTxt = await page.locator('#pinned-panel-root').innerText().catch(() => '');
            check(`${tag}: Pins panel lists the imported pins under their authors`, /Alex/.test(pinsTxt) && /Founding post/.test(pinsTxt), pinsTxt.slice(0, 80).replace(/\n/g, ' | '));
            await shot(page, '08-pins');
        } catch (e) {
            failures++;
            console.log(`FAILED ${tag}: ${e.message.split('\n')[0]}`);
            try { await page.screenshot({ path: `${OUT}/FAILED-${tag}.png` }); } catch {}
        }
        const cipherline = blocked.filter(h => /cipherline/i.test(h));
        check(`${tag}: no request left the machine for a Cipherline host`, cipherline.length === 0, [...new Set(blocked)].join(',') || 'none blocked');
        if (errs.length) { failures++; console.log('PAGEERRORS', tag, errs.join(' | ').slice(0, 500)); }
        await ctx.close();
    }
}
await browser.close();
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
