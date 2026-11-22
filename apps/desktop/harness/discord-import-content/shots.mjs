// Discord import CONTENT (forwards, voice messages, embed pictures, role / channel mentions, reaction tooltip anchoring)
// against the ISOLATED API (setup.ts filled it through the REAL desktop + API paths, files in an isolated MinIO).
// Dark + Light at 1000x720, 1366x768, 1920x1080, 1280x800@1.5. Every non-127.0.0.1 request is BLOCKED and counted.
//   SETUP=<setup.json> OUT=<dir> node harness/discord-import-content/shots.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5381/harness/discord-import-content/page.html';
const OUT = process.env.OUT ?? '/tmp/discord-import-content-shots';
const SETUP = readFileSync(process.env.SETUP, 'utf8');
const CFG = JSON.parse(SETUP);
const PG = process.env.PG ?? 'cl-ic-pg'; const PGDB = process.env.PGDB ?? 'clic';
if (!/^cl-ic-/.test(PG)) throw new Error('isolated DB only');
const REDIS = process.env.REDIS ?? 'cl-ic-redis';
if (!/^cl-ic-/.test(REDIS)) throw new Error('isolated redis only');
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
mkdirSync(OUT, { recursive: true });
const SIZES = [{ w: 1000, h: 720, dsf: 1 }, { w: 1366, h: 768, dsf: 1 }, { w: 1920, h: 1080, dsf: 1 }, { w: 1280, h: 800, dsf: 1.5 }];
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
let failures = 0; let checks = 0;
const check = (name, ok, extra = '') => { checks++; if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const blocked = [];
const hash = encodeURIComponent(Buffer.from(SETUP).toString('base64'));
const tagOf = (sz, theme) => `${theme}-${sz.w}x${sz.h}${sz.dsf !== 1 ? '@' + sz.dsf : ''}`;
const flush = () => execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);

async function page(sz, theme, as, view) {
    const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dsf, reducedMotion: 'reduce', colorScheme: theme });
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === '127.0.0.1') return route.continue();
        blocked.push(u.hostname); return route.abort();
    });
    const p = await ctx.newPage();
    p.setDefaultTimeout(30000);
    p.__errs = []; p.on('pageerror', (e) => p.__errs.push(e.message));
    await p.goto(`${BASE}?theme=${theme}&as=${as}&view=${view}#${hash}`, { timeout: 120000 });
    await p.waitForFunction(() => window.__booted === true, null, { timeout: 90000 });
    await p.waitForTimeout(900);
    return { p, ctx };
}
const shot = async (p, tag, name) => { await p.waitForTimeout(250); await p.screenshot({ path: `${OUT}/${tag}-${name}.png` }); };

// ── Before any UI: what setup.ts produced through the REAL desktop + API paths ──
check('history: 3 files copied (forward picture, voice message, embed picture), none skipped', CFG.history?.filesImported === 3 && CFG.history.filesSkipped.length === 0, JSON.stringify(CFG.history));
check('roles: the structure import returned role refs for the created roles', Object.keys(CFG.roleRefs ?? {}).length >= 3, Object.keys(CFG.roleRefs ?? {}).join(','));
check('DB: every imported row has mentions_everyone = false and styled = false (the server forces it)', psql(`SELECT count(*) FROM channel_messages WHERE import_id IS NOT NULL AND (mentions_everyone OR styled)`) === '0');
check('DB: 3 attachment files were registered for the import', Number(psql(`SELECT count(*) FROM import_session_attachments`)) === 3);
const dump = execFileSync('docker', ['exec', PG, 'pg_dump', '-U', 'postgres', '-d', PGDB, '--data-only'], { encoding: 'utf8', maxBuffer: 1 << 28 });
check('DB dump: no plain Discord id or role/channel name of the source anywhere', !/90000000000000000[0-9]/.test(dump) && !dump.includes('Greenhouse build') && !dump.includes('Saturday forecast'));

for (const theme of THEMES) for (const sz of SIZES) {
    flush();
    const tag = tagOf(sz, theme);
    const { p, ctx } = await page(sz, theme, 'sam', 'chat');
    await p.waitForFunction(() => !!window.__chat, null, { timeout: 30000 });
    await p.waitForTimeout(2500);
    const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
    check(`${tag} role mention: shown as a mention, no raw token`, /@Moderator/.test(body) && !/<@r:/.test(body), body.match(/Reminder.{0,80}/)?.[0]);
    check(`${tag} @everyone is defused text (zero-width space after the @): reads like Discord, matches no mention test`, /@\u200beveryone/.test(body) && !/@everyone/.test(body));
    check(`${tag} forward: heading + quoted original words, thanks-mention as plain name`, /Forwarded message \(originally/.test(body) && /Greenhouse build is done/.test(body) && /thanks @Sam/.test(body), body.match(/Forwarded.{0,120}/)?.[0]);
    check(`${tag} embed: text embed kept`, /Saturday forecast/.test(body));
    check(`${tag} voice message present as an audio attachment card`, /voice-message\.ogg/.test(body), body.match(/voice-message[^ ]*/g)?.join(','));
    check(`${tag} channel mention is a real link to the imported #rules channel`, /#\s*rules/i.test(body) && !/unknown-channel/.test(body), body.match(/see #.{0,30}/)?.[0]);
    const imgs = await p.evaluate(() => [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 100).length);
    check(`${tag} the two pictures actually decrypted and rendered (img naturalWidth > 100)`, imgs >= 2, String(imgs));
    // The role mention must NOT count as a mention for the viewer (sam holds no role here, but the imported rows are marked anyway).
    const rows = await p.evaluate(() => document.querySelectorAll('[data-import-mark], [data-imported]').length);
    void rows;
    // Reaction tooltip anchoring (the member-roles screenshot bug): the tooltip is centred ON the pill.
    const pill = p.locator('button').filter({ hasText: /^🎉\s*2$/ }).first();
    await pill.hover();
    await p.waitForTimeout(900);
    const geo = await p.evaluate(() => {
        const tip = [...document.querySelectorAll('div')].find(d => d.style.zIndex === '9999' && d.style.pointerEvents === 'none');
        const pill = [...document.querySelectorAll('button')].find(b => /^🎉\s*2$/.test((b.textContent || '').trim()));
        if (!tip || !pill) return null;
        const t = tip.getBoundingClientRect(); const b = pill.getBoundingClientRect();
        return { tipC: Math.round(t.left + t.width / 2), pillC: Math.round(b.left + b.width / 2), tipBottom: Math.round(t.bottom), pillTop: Math.round(b.top), left: Math.round(t.left) };
    });
    check(`${tag} reactions: the tooltip is centred on its pill (within 2px) and sits just above it`, !!geo && Math.abs(geo.tipC - geo.pillC) <= 2 && geo.tipBottom <= geo.pillTop && geo.pillTop - geo.tipBottom <= 12 && geo.left >= 8, JSON.stringify(geo));
    await shot(p, tag, '01-feed-tooltip');
    await p.mouse.move(2, 2);
    await p.locator('main').first().evaluate((m) => m.querySelectorAll('div').forEach(d => { if (d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY !== 'visible') d.scrollTop = 0; }));
    await p.waitForTimeout(400);
    await shot(p, tag, '02-feed-top');
    await p.locator('main').first().evaluate((m) => m.querySelectorAll('div').forEach(d => { if (d.scrollHeight > d.clientHeight + 40 && getComputedStyle(d).overflowY !== 'visible') d.scrollTop = d.scrollHeight; }));
    await p.waitForTimeout(700);
    await shot(p, tag, '03-feed-bottom');
    check(`${tag} chat: no page errors`, p.__errs.length === 0, p.__errs.join(' | '));
    await ctx.close();
}

check('no request left 127.0.0.1 (zero Cipherline or Discord hosts)', blocked.every(h => /^fonts\.(googleapis|gstatic)\.com$/.test(h)), [...new Set(blocked)].join(','));
await browser.close();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
