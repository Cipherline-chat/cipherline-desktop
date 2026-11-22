// Discord import wizard v2 (token first, invite derived from the token, Administrator, self-refreshing server list,
// copy buttons) against an ISOLATED local API + the MOCK Discord in harness/discord-history-main.tsx.
//   SETUP=<json from discord-history-setup.mjs> OUT=<dir> node harness/discord-wizard-v2-shots.mjs
//   env: BASE (default http://127.0.0.1:5353/harness/discord-history.html), REDIS (isolated: clih-*), THEMES, SIZE
// Every request the page makes to anything but 127.0.0.1 is BLOCKED and counted (must be zero to Cipherline hosts).
// Scenes: the owner's reported state (?preseed=other: his OTHER bot is already in the server) walked through
// token -> "isn't in any server yet" -> Open invite link -> server appears by itself -> preview -> consent (copy
// announcement) -> at 1366 a real import to the report + popup. Extra at every size: intents off, Discord down,
// clipboard refused (fallback).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5353/harness/discord-history.html';
const OUT = process.env.OUT ?? '/tmp/discord-wizard-v2-shots';
const SETUP = readFileSync(process.env.SETUP, 'utf8');
const REDIS = process.env.REDIS ?? 'clih-redis';
if (!/^clih-/.test(REDIS)) throw new Error('only the isolated redis may be flushed');
mkdirSync(OUT, { recursive: true });
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.'); // the mock importer's fake token
const IMPORTER_APP = '800000000000000900';
const SIZES = [
    { w: 1000, h: 720, dsf: 1 }, { w: 1366, h: 768, dsf: 1, run: true },
    { w: 1920, h: 1080, dsf: 1 }, { w: 1280, h: 800, dsf: 1.5 },
];
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const ONLY_SIZE = process.env.SIZE ?? null;
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const btn = (p, re) => p.locator('.mcard button').filter({ hasText: new RegExp(re, 'i') }).last();
const click = async (p, re, ms = 500) => { await btn(p, re).click(); await p.waitForTimeout(ms); };
const blockedTotal = [];

async function fit(p, label) {
    const r = await p.evaluate(() => {
        const card = document.querySelector('.mcard'); if (!card) return null;
        const b = card.getBoundingClientRect(); const body = card.querySelector('.dlg-body'); const foot = card.querySelector('.dlg-foot');
        const f = foot ? foot.getBoundingClientRect() : null;
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, vh: innerHeight, vw: innerWidth, hScroll: body ? body.scrollWidth > body.clientWidth + 1 : false, docH: document.documentElement.scrollWidth > innerWidth + 1, foot: f ? f.bottom <= innerHeight + 1 && f.top >= 0 : true };
    });
    if (!r) return check(`${label}: card present`, false);
    check(`${label}: card inside the window, footer visible, no sideways scroll`, r.top >= 0 && r.bottom <= r.vh + 1 && r.left >= 0 && r.right <= r.vw && r.foot && !r.hScroll && !r.docH,
        `${Math.round(r.top)}..${Math.round(r.bottom)}/${r.vh}`);
}

async function open(theme, sz, params) {
    const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dsf, reducedMotion: 'reduce' });
    const blocked = [];
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === '127.0.0.1') return route.continue();
        blocked.push(u.hostname); blockedTotal.push(u.hostname); return route.abort();
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(`${BASE}?theme=${theme}${params ? '&' + params : ''}#${encodeURIComponent(Buffer.from(SETUP).toString('base64'))}`, { timeout: 90000 });
    await page.waitForSelector('.mcard', { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    return { ctx, page, blocked, errs };
}

for (const theme of THEMES) {
    for (const sz of SIZES) {
        if (ONLY_SIZE && String(sz.w) !== ONLY_SIZE) continue;
        execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']); // the ISOLATED stack's throttle counters only
        const tag = `${theme}-${sz.w}x${sz.h}${sz.dsf !== 1 ? '@' + sz.dsf : ''}`;
        const shot = async (p, name) => { await p.mouse.move(2, 2); await p.waitForTimeout(250); await p.screenshot({ path: `${OUT}/${tag}-${name}.png` }); };

        // ── Main scene: the owner's state ──
        {
            const { ctx, page, errs } = await open(theme, sz, 'preseed=other');
            try {
                const apiBase = await page.evaluate(() => window.__apiBase);
                check(`${tag}: network target is the isolated local API`, /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(apiBase), apiBase);
                check(`${tag}: page one asks for the token; no application id field`, (await page.locator('input[type=password]').count()) === 1 && (await page.locator('input[inputmode=numeric]').count()) === 0);
                await fit(page, `${tag} token`);
                const lay = await page.evaluate(() => {
                    const code = document.querySelector('ol[aria-label="Get a bot token"] code');
                    const row = document.querySelector('[data-testid=portal-link-row]');
                    const btn = row?.querySelector('button');
                    const step = row?.parentElement;
                    const textEnd = step ? [...step.querySelectorAll('b')].pop()?.getBoundingClientRect() : null;
                    return {
                        codeLines: code ? code.getClientRects().length : -1,
                        ownLine: !!(btn && textEnd && btn.getBoundingClientRect().top >= textEnd.bottom),
                        leftAligned: !!(btn && step && Math.abs(btn.getBoundingClientRect().left - step.getBoundingClientRect().left) <= 1),
                    };
                });
                check(`${tag}: step 1: "Cipherline Importer" chip on one line; portal button on its own line, left-aligned`, lay.codeLines === 1 && lay.ownLine && lay.leftAligned, JSON.stringify(lay));
                await shot(page, '01-token');
                await page.locator('input[type=password]').fill(TOKEN);
                await click(page, 'Check token', 900);
                check(`${tag}: both intents shown on`, (await page.locator('[data-testid=intent-on]').count()) === 2);
                await fit(page, `${tag} token-checked`);
                await shot(page, '02-token-checked');
                await click(page, '^Continue$', 1200);
                const noServers = await page.locator('[data-testid=no-servers]').innerText().catch(() => '');
                check(`${tag}: owner's state (his OTHER bot is in the server): honest "isn't in any server yet" for the importer`, /Cipherline Importer isn’t in any server yet/.test(noServers));
                const invite = await page.locator('[data-testid=invite-url]').textContent();
                const u = new URL(invite);
                check(`${tag}: invite = token's application + Administrator`, u.searchParams.get('client_id') === IMPORTER_APP && u.searchParams.get('permissions') === '8', invite);
                await fit(page, `${tag} no-servers`);
                await shot(page, '03-not-in-any-server');
                await click(page, '^\\s*Copy link$', 300);
                const clip = await page.evaluate(() => window.__clipboard);
                check(`${tag}: Copy link goes through the app clipboard path and says Copied`, clip.at(-1) === invite && (await btn(page, '^\\s*Copied$').count()) === 1);
                const t0 = Date.now();
                await click(page, '^\\s*Open invite link$', 100);
                await page.locator('[role=radio]').first().waitFor({ timeout: 15000 });
                const secs = ((Date.now() - t0) / 1000).toFixed(1);
                check(`${tag}: after Authorize the server appears with no click (self-refreshing list)`, (await page.locator('[data-testid=no-servers]').count()) === 0, `${secs}s`);
                check(`${tag}: the only server is picked`, (await page.locator('[role=radio][aria-checked=true]').count()) === 1);
                await page.waitForTimeout(300);
                await fit(page, `${tag} server-listed`);
                await shot(page, '04-server-listed');
                await click(page, '^Preview$', 2200);
                const section = page.locator('[data-testid=history-section]');
                check(`${tag}: preview offers messages (intent on)`, (await section.count()) === 1 && (await page.locator('[data-testid=content-intent-off]').count()) === 0);
                for (const lbl of [/Copy the server/, /custom emoji/]) {
                    const cb = page.locator('.mcard [role=checkbox]').filter({ hasText: lbl });
                    if (await cb.count()) await cb.first().click();
                }
                await fit(page, `${tag} preview`);
                await shot(page, '05-preview');
                await click(page, '^Continue$');
                await page.locator('[data-testid=copy-announcement]').click();
                await page.waitForTimeout(200);
                const ann = await page.evaluate(() => window.__clipboard.at(-1));
                check(`${tag}: Copy announcement copies the announcement and shows "Copied"`, /moving this server to Cipherline/.test(ann ?? '') && /Copied/.test(await page.locator('[data-testid=copy-announcement]').innerText()));
                await fit(page, `${tag} consent`);
                await shot(page, '06-consent-copied');
                if (sz.run) {
                    const boxes = page.locator('.mcard [role=checkbox]');
                    for (let i = 0; i < 3; i++) { await boxes.nth(i).click(); await page.waitForTimeout(120); }
                    await btn(page, 'Import server').click();
                    await page.waitForSelector('[data-testid=history-report]', { timeout: 180000 });
                    await page.waitForTimeout(500);
                    const report = await page.locator('[data-testid=history-report]').innerText();
                    check(`${tag}: real import through the isolated API: report counts the rules channel's messages and pins`, /rules — 9 messages, 3 pins saved and pinned/.test(report), report.split('\n')[0]);
                    await shot(page, '07-report');
                    check(`${tag}: bot token never in the page`, !(await page.content()).includes(TOKEN));
                    await click(page, '^Open server$', 1200);
                    await page.waitForSelector('[data-testid=keep-channels]', { timeout: 20000 });
                    await page.waitForTimeout(300);
                    check(`${tag}: post-import popup still works`, (await page.locator('[data-testid=keep-channels] li').filter({ hasText: 'rules' }).count()) === 1);
                    await shot(page, '08-popup');
                }
                const log = await page.evaluate(() => window.__log.filter(l => l[0] === 'discord').map(l => l[1]));
                check(`${tag}: GET /oauth2/applications/@me was used to derive the invite`, log.includes('/oauth2/applications/@me'));
            } catch (e) {
                failures++; console.log(`FAILED ${tag} main: ${e.message.split('\n')[0]}`);
                try { await page.screenshot({ path: `${OUT}/FAILED-${tag}-main.png` }); } catch {}
            }
            if (errs.length) { failures++; console.log('PAGEERRORS', tag, errs.join(' | ')); }
            await ctx.close();
        }

        // ── Intents off ──
        {
            const { ctx, page, errs } = await open(theme, sz, 'intents=off&preseed=importer');
            try {
                await page.locator('input[type=password]').fill(TOKEN);
                await click(page, 'Check token', 900);
                check(`${tag}: intents off are named with why + the fix`, (await page.locator('[data-testid=intent-off]').count()) === 2 && (await btn(page, 'Check again').count()) === 1);
                await fit(page, `${tag} intents-off`);
                await shot(page, '09-intents-off');
            } catch (e) { failures++; console.log(`FAILED ${tag} intents: ${e.message.split('\n')[0]}`); }
            if (errs.length) { failures++; console.log('PAGEERRORS', tag, errs.join(' | ')); }
            await ctx.close();
        }

        // ── Discord down: not "no server" ──
        {
            const { ctx, page, errs } = await open(theme, sz, 'discord=down');
            try {
                await page.locator('input[type=password]').fill(TOKEN);
                await click(page, 'Check token', 900);
                await click(page, '^Continue$', 2500);
                check(`${tag}: Discord down shows "Couldn't reach Discord", not "isn't in any server"`, (await page.locator('[data-testid=unreachable]').count()) === 1 && (await page.locator('[data-testid=no-servers]').count()) === 0);
                await fit(page, `${tag} unreachable`);
                await shot(page, '10-discord-unreachable');
            } catch (e) { failures++; console.log(`FAILED ${tag} down: ${e.message.split('\n')[0]}`); }
            if (errs.length) { failures++; console.log('PAGEERRORS', tag, errs.join(' | ')); }
            await ctx.close();
        }

        // ── Clipboard refused: fallback text, selected ──
        {
            const { ctx, page, errs } = await open(theme, sz, 'clip=fail&preseed=importer');
            try {
                await page.locator('input[type=password]').fill(TOKEN);
                await click(page, 'Check token', 900);
                await click(page, '^Continue$', 1500);
                await page.locator('[role=radio]').first().waitFor({ timeout: 15000 });
                await click(page, '^Preview$', 2200);
                await click(page, '^Continue$');
                await page.locator('[data-testid=copy-announcement]').click();
                await page.waitForTimeout(300);
                const sel = await page.evaluate(() => { const t = document.querySelector('[data-testid=announcement-fallback]'); return t ? { focused: document.activeElement === t, all: t.selectionStart === 0 && t.selectionEnd === t.value.length } : null; });
                check(`${tag}: clipboard refused: no fake "Copied"; the text is shown, focused and selected`, !!sel && sel.focused && sel.all && !/Copied/.test(await page.locator('[data-testid=copy-announcement]').innerText()));
                await page.locator('[data-testid=announcement-fallback]').scrollIntoViewIfNeeded();
                await fit(page, `${tag} copy-fallback`);
                await page.screenshot({ path: `${OUT}/${tag}-11-copy-fallback.png` });
            } catch (e) { failures++; console.log(`FAILED ${tag} clip: ${e.message.split('\n')[0]}`); }
            if (errs.length) { failures++; console.log('PAGEERRORS', tag, errs.join(' | ')); }
            await ctx.close();
        }
    }
}
await browser.close();
const hosts = [...new Set(blockedTotal)];
check('no request to any Cipherline host (all non-loopback requests were blocked; list)', !hosts.some(h => /cipherline/i.test(h)), hosts.join(',') || 'none');
console.log(failures ? `${failures} FAILURES` : 'ALL OK');
process.exit(failures ? 1 : 0);
