// Discord import member roles / bans / nicknames / reactions against the ISOLATED API (setup.ts filled it):
// the claim confirm naming sam's roles, the claim itself (DB: roles + per-channel override + nickname), the imported
// reactions under the B6.2 rules, the Roles tab's import bar + Review, Settings > Profile > Discord.
// Dark + Light at 1000x720, 1366x768, 1920x1080, 1280x800@1.5. Every non-127.0.0.1 request is BLOCKED and counted.
//   SETUP=<setup.json> OUT=<dir> node harness/discord-member-roles/shots.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5371/harness/discord-member-roles/page.html';
const OUT = process.env.OUT ?? '/tmp/discord-member-roles-shots';
const SETUP = readFileSync(process.env.SETUP, 'utf8');
const CFG = JSON.parse(SETUP);
const PG = process.env.PG ?? 'cl-mr-pg'; const PGDB = process.env.PGDB ?? 'clmr';
if (!/^cl-mr-/.test(PG)) throw new Error('isolated DB only');
const REDIS = process.env.REDIS ?? 'cl-mr-redis';
if (!/^cl-mr-/.test(REDIS)) throw new Error('isolated redis only');
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
mkdirSync(OUT, { recursive: true });
const SIZES = [{ w: 1000, h: 720, dsf: 1 }, { w: 1366, h: 768, dsf: 1 }, { w: 1920, h: 1080, dsf: 1 }, { w: 1280, h: 800, dsf: 1.5 }];
const THEMES = ['dark', 'light'];
let failures = 0; let checks = 0;
const check = (name, ok, extra = '') => { checks++; if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const blocked = [];
const hash = encodeURIComponent(Buffer.from(SETUP).toString('base64'));
const tagOf = (sz, theme) => `${theme}-${sz.w}x${sz.h}${sz.dsf !== 1 ? '@' + sz.dsf : ''}`;

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
async function fits(p, sel, label) {
    const r = await p.evaluate((s) => {
        const el = document.querySelector(s); if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), vw: innerWidth, vh: innerHeight, hs: document.documentElement.scrollWidth > innerWidth + 1 };
    }, sel);
    check(`${label}: inside the window, no sideways scroll`, !!r && r.top >= 0 && r.left >= 0 && r.right <= r.vw + 1 && r.bottom <= r.vh + 1 && !r.hs, r ? JSON.stringify(r) : 'missing');
}
const flush = () => execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);

// ── Before any UI: what setup.ts produced through the REAL desktop + API paths ──
check('setup: the banned Discord account was refused at the invite (403, banned)', /^refused 403/.test(CFG.spammerJoin), CFG.spammerJoin);
check('DB: the banned account is banned with the Discord reason', psql(`SELECT banned::text || '|' || coalesce(ban_reason,'') FROM server_members WHERE user_id = '${CFG.spammer.user_id}'`) === 'true|Spam links');
check('DB: alex (auto-mapped before the import, joined after) got Farmhand ON JOIN', psql(`SELECT string_agg(r.name, ',') FROM member_roles mr JOIN roles r USING (role_id) WHERE mr.user_id = '${CFG.alex.user_id}'`) === 'Farmhand');
check('DB: sam has nothing yet (linked, not claimed)', psql(`SELECT count(*) FROM member_roles WHERE user_id = '${CFG.sam.user_id}'`) === '0');
check('report: people saved', CFG.report.people?.status === 'saved' && CFG.report.people.roles === 3, JSON.stringify(CFG.report.people));
check('history report: the foreign custom-emoji reaction was counted as left out', CFG.history?.reactionsSkipped === 1, JSON.stringify(CFG.history));
check('Discord reads: members + bans + one request per (message, emoji) for reactors', CFG.discordCalls.includes('/guilds/:id/members') && CFG.discordCalls.includes('/guilds/:id/bans') && CFG.reactionRequests === 3, `${CFG.reactionRequests}`);

// ── Phase A: the claim confirm (sam), every size + theme, BEFORE claiming ──
for (const theme of THEMES) for (const sz of SIZES) {
    flush();
    const tag = tagOf(sz, theme);
    const { p, ctx } = await page(sz, theme, 'sam', 'notice');
    await p.waitForSelector('[data-claim-grants]');
    const roles = await p.locator('[data-claim-roles] li').allTextContents();
    check(`${tag} confirm: names the roles BEFORE Claim (Moderator, Farmhand)`, roles.map(s => s.trim()).join(',') === 'Moderator,Farmhand', roles.join(','));
    const t = (await p.locator('.mcard').first().textContent()) ?? '';
    check(`${tag} confirm: nickname + channel permission + importer`, t.includes('Sammy') && /1 channel or category/.test(t) && t.includes('@importer'), t.slice(0, 160).replace(/\s+/g, ' '));
    await fits(p, '.mcard', `${tag} confirm`);
    await shot(p, tag, '01-claim-confirm-roles');
    check(`${tag} confirm: no page errors`, p.__errs.length === 0, p.__errs.join(' | '));
    await ctx.close();
}

// ── Phase B (once): Claim -> roles, the per-channel override, the nickname ──
{
    flush();
    const { p, ctx } = await page(SIZES[1], 'dark', 'sam', 'notice');
    await p.waitForSelector('[data-claim-grants]');
    await p.locator('.mcard button', { hasText: /^Claim/ }).click();
    await p.waitForTimeout(2500);
    const roles = psql(`SELECT string_agg(r.name, ',' ORDER BY r.name) FROM member_roles mr JOIN roles r USING (role_id) WHERE mr.user_id = '${CFG.sam.user_id}'`);
    check('claim: sam now has Farmhand + Moderator', roles === 'Farmhand,Moderator', roles);
    const ov = psql(`SELECT c.name || ':' || o.allow_bits FROM channel_overrides o JOIN channels c USING (channel_id) WHERE o.target_kind = 'member' AND o.target_id = '${CFG.sam.user_id}'`);
    check('claim: sam has his per-user override on #mod-chat (Send Messages)', /^mod-chat:\d+$/.test(ov), ov);
    check('claim: nickname Sammy', psql(`SELECT nickname FROM server_members WHERE user_id = '${CFG.sam.user_id}'`) === 'Sammy');
    const audit = psql(`SELECT count(*) FROM audit_log_entries WHERE data_jsonb->>'source' = 'discord_import' AND (target_user_id = '${CFG.sam.user_id}' OR data_jsonb::text LIKE '%${CFG.sam.user_id}%')`);
    check('claim: the audit log says it came from the Discord import', Number(audit) >= 3, audit);
    check('claim: the grants are "applied"', psql(`SELECT string_agg(DISTINCT g.state, ',') FROM import_member_grants g JOIN import_authors a ON a.id = g.author_id WHERE a.claimed_user_id = '${CFG.sam.user_id}'`) === 'applied');
    await ctx.close();
}

// ── Phase C: imported reactions (sam's view), every size + theme ──
for (const theme of THEMES) for (const sz of SIZES) {
    flush();
    const tag = tagOf(sz, theme);
    const { p, ctx } = await page(sz, theme, 'sam', 'chat');
    await p.waitForFunction(() => !!window.__chat, null, { timeout: 30000 });
    await p.waitForTimeout(1500);
    const pills = await p.locator('button').filter({ hasText: /^(🎉|👍|:party_parrot:)\s*\d+$/ }).allTextContents();
    const by = Object.fromEntries(pills.map(s => { const m = s.trim().match(/^(.*?)\s*(\d+)$/); return [m[1].trim(), Number(m[2])]; }));
    check(`${tag} reactions: 🎉 2, 👍 7 (2 named + 5 unnamed); the other server's :party_parrot: left out`, by['🎉'] === 2 && by['👍'] === 7 && by[':party_parrot:'] === undefined, JSON.stringify(by));
    await p.locator('button').filter({ hasText: /^🎉\s*2$/ }).first().hover();
    await p.waitForTimeout(800);
    const tip = await p.evaluate(() => [...document.querySelectorAll('div')].filter(d => d.style.zIndex === '9999' && d.style.pointerEvents === 'none').map(d => d.textContent).join(' '));
    check(`${tag} reactions: claimed reactors show as their accounts (sam, alex), never the raw id`, /sam/.test(tip) && /alex/.test(tip) && !/\d{15,}/.test(tip), tip);
    await shot(p, tag, '02-imported-reactions-tooltip');
    check(`${tag} chat: no page errors`, p.__errs.length === 0, p.__errs.join(' | '));
    await ctx.close();
}

// ── Phase D: Roles tab (importer): the import bar + Review ──
for (const theme of THEMES) for (const sz of SIZES) {
    flush();
    const tag = tagOf(sz, theme);
    const { p, ctx } = await page(sz, theme, 'importer', 'roles');
    await p.waitForSelector('[data-import-grants-bar]');
    const bar = (await p.locator('[data-import-grants-bar]').textContent()) ?? '';
    check(`${tag} roles: the import bar counts waiting / given / bans`, /waiting for \d+/.test(bar) && /given to 2/.test(bar) && /1 ban/.test(bar), bar);
    await shot(p, tag, '03-roles-import-bar');
    await p.locator('[data-import-grants-bar] button', { hasText: 'Review' }).click();
    await p.waitForSelector('[data-import-grants-list]');
    const rows = await p.locator('[data-import-grants-list] li').allTextContents();
    check(`${tag} roles review: sam's grants listed as Given; unlinked people unnamed`, rows.some(r => r.includes('@sam') && r.includes('Given')) && rows.some(r => /not claimed/.test(r)), rows.length + ' rows');
    await fits(p, '.mcard', `${tag} roles review`);
    await shot(p, tag, '04-roles-import-review');
    await ctx.close();
}

// ── Phase E: Settings > Profile > Discord (sam) ──
for (const theme of THEMES) for (const sz of SIZES) {
    flush();
    const tag = tagOf(sz, theme);
    const { p, ctx } = await page(sz, theme, 'sam', 'settings');
    await p.waitForSelector('[data-claim-row]', { timeout: 30000 });
    const row = (await p.locator('[data-claim-row]').first().textContent()) ?? '';
    check(`${tag} settings: the claim row says messages + roles, shows as you`, /1 message · 2 roles/.test(row) && /Shows as you/.test(row), row.replace(/\s+/g, ' ').slice(0, 140));
    await shot(p, tag, '05-settings-discord');
    await ctx.close();
}

// ── Phase F (once): unclaim takes back only what the import gave ──
{
    const aid = psql(`SELECT id FROM import_authors WHERE claimed_user_id = '${CFG.sam.user_id}' LIMIT 1`);
    const r = await fetch(`${CFG.api}/servers/${CFG.server_id}/imports/authors/${aid}/claim`, { method: 'DELETE', headers: { authorization: `Bearer ${CFG.sam.token}` } });
    check('unclaim: 200', r.status === 200, String(r.status));
    check('unclaim: sam\'s import roles are gone', psql(`SELECT count(*) FROM member_roles WHERE user_id = '${CFG.sam.user_id}'`) === '0');
    check('unclaim: the #mod-chat override and the nickname are gone', psql(`SELECT count(*) FROM channel_overrides WHERE target_id = '${CFG.sam.user_id}'`) === '0' && psql(`SELECT coalesce(nickname,'') FROM server_members WHERE user_id = '${CFG.sam.user_id}'`) === '');
    check('unclaim: alex keeps HIS Farmhand (positive control: only sam\'s grants moved)', psql(`SELECT count(*) FROM member_roles WHERE user_id = '${CFG.alex.user_id}'`) === '1');
}

check('no request left 127.0.0.1 except fonts (zero Cipherline hosts)', !blocked.some(h => /cipherline/.test(h)), [...new Set(blocked)].join(','));
await browser.close();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
