// Discord LINK MOVE (phase 3b) against an ISOLATED local API + MOCK Discord: the browser question page, keep / move,
// the browser binding, replay, cooldown, "unlink first", the moved-in Settings row, the moved-away notice (at sign-in
// and live from a REAL WebSocket event) and its OK. Screenshots + checks in Dark and Light at 1366x768, 1000x720,
// 1920x1080 and 1280x800@1.5.
//   SETUP=<json from discord-link-move-setup.mjs> OUT=<dir> node harness/discord-link-move-shots.mjs
//   env: BASE (default http://127.0.0.1:5364/harness/discord-claims.html), API (http://127.0.0.1:13106),
//        TLS (https://127.0.0.1:13444), MOCK (http://127.0.0.1:7998), REDIS (isolated redis container, cllm-*),
//        PG / PGDB (isolated DB, read-only checks), PW_CHROMIUM_EXE
// Every request a page makes to anything but 127.0.0.1 is BLOCKED and counted (must be zero to Cipherline hosts).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5364/harness/discord-claims.html';
const API = process.env.API ?? 'http://127.0.0.1:13106';
const TLS = process.env.TLS ?? 'https://127.0.0.1:13444';
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:7998';
for (const u of [BASE, API, TLS, MOCK]) if (new URL(u).hostname !== '127.0.0.1') throw new Error(`loopback only: ${u}`);
const OUT = process.env.OUT ?? '/tmp/discord-link-move-shots';
const SETUP = readFileSync(process.env.SETUP, 'utf8');
const CFG = JSON.parse(SETUP);
const REDIS = process.env.REDIS ?? 'cllm-redis';
if (!/^cllm-/.test(REDIS)) throw new Error('only the isolated redis may be flushed');
const PG = process.env.PG ?? 'cl-linkmove-pg'; const PGDB = process.env.PGDB ?? 'cllinkmove';
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
const flush = () => execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);
mkdirSync(OUT, { recursive: true });
const SIZES = [
    { w: 1366, h: 768, dsf: 1, all: true }, { w: 1000, h: 720, dsf: 1, all: true },
    { w: 1920, h: 1080, dsf: 1, all: false }, { w: 1280, h: 800, dsf: 1.5, all: false },
];
const THEMES = ['dark', 'light'];
const tagOf = (theme, sz) => `${theme}-${sz.w}x${sz.h}${sz.dsf !== 1 ? '@' + sz.dsf : ''}`;
let failures = 0; let checks = 0;
const check = (name, ok, extra = '') => { checks++; if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const blockedAll = [];
const hash = encodeURIComponent(Buffer.from(SETUP).toString('base64'));
const D = CFG.discord;
const holder = () => psql(`SELECT u.username FROM discord_links l JOIN users u USING (user_id) WHERE l.discord_id_hash = (SELECT discord_id_hash FROM discord_links WHERE user_id IN ('${CFG.alex.user_id}','${CFG.alexalt.user_id}') LIMIT 1)`);

async function context(sz, theme) {
    const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dsf, reducedMotion: 'reduce', colorScheme: theme, ignoreHTTPSErrors: true });
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === '127.0.0.1') return route.continue();
        blockedAll.push(u.hostname); return route.abort();
    });
    return ctx;
}
async function app(ctx, { as, view = 'chat', theme = 'dark' }) {
    const p = await ctx.newPage();
    p.setDefaultTimeout(20000);
    p.__errs = []; p.on('pageerror', (e) => p.__errs.push(e.message));
    await p.goto(`${BASE}?theme=${theme}&as=${as}&view=${view}#${hash}`, { timeout: 90000 });
    await p.waitForFunction(() => window.__booted === true, null, { timeout: 60000 });
    if (view !== 'settings') await p.waitForFunction(() => !!window.__chat, null, { timeout: 30000 });
    await p.waitForTimeout(700);
    return p;
}
const shot = async (p, tag, name) => { await p.mouse.move(2, 2); await p.waitForTimeout(250); await p.screenshot({ path: `${OUT}/${tag}-${name}.png` }); };
async function fits(p, sel, label) {
    const r = await p.evaluate((s) => {
        const el = document.querySelector(s); if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), vw: innerWidth, vh: innerHeight, hs: document.documentElement.scrollWidth > innerWidth + 1 };
    }, sel);
    check(`${label}: inside the window, no sideways scroll`, !!r && r.left >= 0 && r.right <= r.vw + 1 && !r.hs && (r.top >= 0), r ? JSON.stringify(r) : 'missing');
}
/** A one-time start URL for `user` (the same call the app makes), then the browser leg in `page`, ending on the callback page. */
async function prove(ctx, user, discordId, discordName, url = null) {
    await fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify({ id: discordId, username: discordName }) });
    if (!url) {
        const r = await fetch(`${API}/v1/discord/link`, { method: 'POST', headers: { authorization: `Bearer ${user.token}` } });
        url = (await r.json()).url;
    }
    const b = await ctx.newPage();
    b.__errs = []; b.on('pageerror', (e) => b.__errs.push(e.message));
    await b.goto(url);
    await b.locator('a', { hasText: 'Continue to Discord' }).click();
    await b.waitForSelector('#approve');
    const resp = b.waitForResponse((r) => r.url().includes('/v1/discord/oauth/callback'));
    await b.locator('#approve').click();
    const cb = await resp;
    await b.waitForLoadState();
    b.__status = cb.status();
    return b;
}
const pageText = (b) => b.evaluate(() => document.body.innerText);

// ── Phase 0: before — the wrong account holds the link and shows as Alex's author ──
for (const theme of THEMES) {
    flush();
    const sz = SIZES[0]; const tag = tagOf(theme, sz);
    const ctx = await context(sz, theme);
    const s = await app(ctx, { as: 'alexalt', view: 'settings', theme });
    await s.waitForSelector('[data-testid=discord-linked]');
    await s.waitForSelector('[data-claim-row]:has-text("Shows as you")');
    check(`${tag} before: alexalt is linked and holds Alex's imported messages`, true);
    await shot(s, tag, '00-before-settings-wrong-account');
    check(`${tag} before: no page errors`, s.__errs.length === 0, s.__errs.join(' | '));
    await ctx.close();
}
check('DB before: alexalt holds the link', holder() === 'alexalt', holder());

// ── Phase A: the question page at every size + theme, answered "Keep it where it is" (keyboard) ──
for (const theme of THEMES) for (const sz of SIZES) {
    flush();
    const tag = tagOf(theme, sz);
    const ctx = await context(sz, theme);
    const b = await prove(ctx, CFG.alex, D.alex, 'alex_92');
    const t = await pageText(b);
    check(`${tag} question: "linked to another Cipherline account. Move it to alex#…?"`, b.__status === 200 && t.includes('This Discord account is linked to another Cipherline account') && /Move it to alex#\d{4}\?/.test(t), t.slice(0, 200).replace(/\n/g, ' '));
    check(`${tag} question: the current holder is NOT named anywhere in the page`, !(await b.content()).includes('alexalt'));
    const btns = await b.locator('form button[type=submit]').allTextContents();
    check(`${tag} question: two real submit buttons (Move / Keep)`, btns.length === 2 && /Move to alex#/.test(btns[0]) && /Keep it where it is/.test(btns[1]), btns.join(' | '));
    await fits(b, 'section.card', `${tag} question card`);
    await shot(b, tag, '01-move-question');
    check(`${tag} DB: asking changed nothing`, holder() === 'alexalt', holder());
    // Keyboard: focus "Keep it where it is" and press Enter.
    await b.locator('form button[value=cancel]').focus();
    await Promise.all([b.waitForLoadState(), b.waitForResponse((r) => r.url().endsWith('/v1/discord/oauth/move')), b.keyboard.press('Enter')]);
    await b.waitForSelector('h1');
    check(`${tag} keep (Enter on the focused button): "Discord stays where it was", still alexalt`, (await pageText(b)).includes('Discord stays where it was') && holder() === 'alexalt');
    if (sz.all) await shot(b, tag, '02-kept');
    check(`${tag} question: no page errors`, b.__errs.length === 0, b.__errs.join(' | '));
    await ctx.close();
}

// ── Phase B (once): binding, forged token, the real move, live WS notice, replay, cooldown, unlink-first ──
const wsEvents = [];
{
    flush();
    const sz = SIZES[0]; const tag = 'dark-1366x768';
    const ctx = await context(sz, 'dark');
    // A question page, then its form posted from ANOTHER browser (no binding cookie): refused, not consumed.
    const q = await prove(ctx, CFG.alex, D.alex, 'alex_92');
    const token = await q.locator('input[name=token]').getAttribute('value');
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    const r1 = await other.request.post(`${TLS}/v1/discord/oauth/move`, { form: { token, decision: 'move' } });
    check('binding: the same form posted from another browser (no cookie) is refused (400)', r1.status() === 400 && (await r1.text()).includes("confirm"), String(r1.status()));
    const r2 = await other.request.post(`${TLS}/v1/discord/oauth/move`, { form: { token: 'A'.repeat(43), decision: 'move' } });
    check('a forged token is "expired" (410), never a move', r2.status() === 410, String(r2.status()));
    const r3 = await other.request.post(`${TLS}/v1/discord/oauth/move`, { form: { token, decision: 'move', user_id: CFG.alex.user_id } });
    check('an extra field (user_id) is rejected by validation (400)', r3.status() === 400, String(r3.status()));
    await other.close();
    check('DB: still alexalt after the refused posts', holder() === 'alexalt', holder());
    await q.close();

    // A REAL WebSocket for the account that will lose the link.
    const ws = new WebSocket(`${API.replace('http', 'ws')}/v1/ws?token=${CFG.alexalt.token}`);
    ws.addEventListener('message', (m) => { try { const j = JSON.parse(String(m.data)); if (String(j.event).startsWith('discord:')) wsEvents.push(j); } catch { /* */ } });
    await new Promise((res) => { ws.addEventListener('open', res); setTimeout(res, 4000); });
    // alexalt's app is open (no notice yet); alex's Settings starts the sign-in from the real button.
    const alt = await app(ctx, { as: 'alexalt', view: 'notice', theme: 'dark' });
    check('alexalt app before the move: no moved notice', (await alt.locator('[role=dialog]:has-text("Your Discord link was moved")').count()) === 0);
    const s = await app(ctx, { as: 'alex', view: 'settings', theme: 'dark' });
    await s.locator('[data-testid=discord-connect] button', { hasText: 'Link Discord' }).click();
    await s.waitForSelector('[data-testid=discord-connect]:has-text("Finish in your browser")');
    const opened = await s.evaluate(() => window.__opened.slice());
    check('alex: "Link Discord" opened OUR https start page only', opened.length === 1 && opened[0].startsWith(`${TLS}/v1/discord/oauth/start?state=`), opened.join(' '));
    await shot(s, tag, '03-settings-waiting');
    const b = await prove(ctx, CFG.alex, D.alex, 'alex_92', opened[0]);
    check('alex: the browser asks before moving', (await pageText(b)).includes('Move it to alex#'));
    const movedToken = await b.locator('input[name=token]').getAttribute('value');
    await Promise.all([b.waitForResponse((r) => r.url().endsWith('/v1/discord/oauth/move')), b.locator('form button[value=move]').click()]);
    await b.waitForSelector('h1:has-text("Discord moved to this account")');
    await shot(b, tag, '04-moved');
    check('DB: alex now holds the link, with moved_at set', holder() === 'alex' && psql(`SELECT moved_at IS NOT NULL FROM discord_links WHERE user_id = '${CFG.alex.user_id}'`) === 't');
    check('DB: Alex\'s imported author is claimed by alex now (claim_source kept: auto)', psql(`SELECT claim_source FROM import_authors WHERE id = '${CFG.imports[0].refs.alex}' AND claimed_user_id = '${CFG.alex.user_id}'`) === 'auto');
    check('DB: alexalt claims nothing any more', psql(`SELECT count(*) FROM import_authors WHERE claimed_user_id = '${CFG.alexalt.user_id}'`) === '0');
    check('DB: one move notice, for alexalt only', psql(`SELECT string_agg(user_id::text, ',') FROM discord_link_move_notices`) === CFG.alexalt.user_id);
    // The app (alex) noticed by itself.
    await s.waitForSelector('[data-testid=discord-linked]', { timeout: 20000 });
    await s.waitForSelector('[data-claim-row]:has-text("Shows as you")', { timeout: 20000 });
    check('alex app: Settings turned "linked" with the moved claims, without a reload', true);
    await shot(s, tag, '05-settings-moved-in-live');
    // The REAL WS event for alexalt, forwarded to its open app (the harness has no socket of its own).
    for (let i = 0; i < 20 && !wsEvents.some((e) => e.event === 'discord:link_changed'); i++) await new Promise((r) => setTimeout(r, 250));
    const ev = wsEvents.find((e) => e.event === 'discord:link_changed');
    check('WS: alexalt received discord:link_changed {moved_away: true}, nothing about alex', !!ev && JSON.stringify(ev.data) === '{"moved_away":true}' && !JSON.stringify(ev).includes(CFG.alex.user_id), JSON.stringify(ev));
    ws.close();
    await alt.evaluate(() => window.__discordLinkChanged());
    await alt.waitForSelector('[role=dialog]:has-text("Your Discord link was moved")', { timeout: 10000 });
    const nt = await alt.locator('[role=dialog]').innerText();
    check('alexalt app: the notice appeared live, without naming alex', nt.includes('another Cipherline account') && !/alex#|@alex\b/.test(nt) && !nt.includes(CFG.alex.user_id), nt.replace(/\n/g, ' ').slice(0, 200));
    await shot(alt, tag, '06-notice-live');
    // Chat as alex: the claimed rows now carry alex.
    const c = await app(ctx, { as: 'alex', view: 'chat', theme: 'dark' });
    const chat = await c.evaluate(() => window.__chat);
    check('history marks: Alex\'s 3 rows carry claimed_user_id = alex', chat.claimed.filter((u) => u === CFG.alex.user_id).length === 3 && !chat.claimed.includes(CFG.alexalt.user_id), JSON.stringify(chat.claimed));
    await shot(c, tag, '07-channel-after-move');
    // Replay of the move form (same token, from the same browser): expired.
    const replay = await b.request.post(`${TLS}/v1/discord/oauth/move`, { form: { token: movedToken, decision: 'move' } });
    check('replay of an old question token: 410, nothing changes', replay.status() === 410 && holder() === 'alex', String(replay.status()));
    // Cooldown: alexalt signs in to the same Discord account at once to take it back.
    const cool = await prove(ctx, CFG.alexalt, D.alex, 'alex_92');
    const ct = await pageText(cool);
    check('cooldown: alexalt cannot take it straight back (429, "about 24 hours"), still alex', cool.__status === 429 && ct.includes('moved recently') && ct.includes('about 24 hours') && holder() === 'alex', `${cool.__status} ${ct.slice(0, 160).replace(/\n/g, ' ')}`);
    await shot(cool, tag, '08-cooldown');
    // Unlink first: sam links his OWN Discord account, then signs in to Alex's.
    const own = await prove(ctx, CFG.sam, D.sam, 'samwise.k');
    check('sam links his own Discord account', (await pageText(own)).includes('Discord linked'));
    const busy = await prove(ctx, CFG.sam, D.alex, 'alex_92');
    const bt = await pageText(busy);
    check('sam (already linked elsewhere) is told to unlink first (409); nothing moves', busy.__status === 409 && bt.includes('already has a Discord account linked') && holder() === 'alex', `${busy.__status}`);
    await shot(busy, tag, '09-unlink-first');
    const errs = [...alt.__errs, ...s.__errs, ...c.__errs, ...b.__errs];
    check('phase B: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
}

// ── Phase C: the moved-away notice (at sign-in) + both Settings rows at every size + theme ──
for (const theme of THEMES) for (const sz of SIZES) {
    flush();
    const tag = tagOf(theme, sz);
    const ctx = await context(sz, theme);
    const a = await app(ctx, { as: 'alexalt', view: 'notice', theme });
    await a.waitForSelector('[role=dialog]:has-text("Your Discord link was moved")');
    await fits(a, '[role=dialog]', `${tag} moved notice`);
    check(`${tag} notice: OK has keyboard focus`, (await a.evaluate(() => document.activeElement?.textContent?.trim())) === 'OK');
    await shot(a, tag, '10-moved-notice');
    const s = await app(ctx, { as: 'alexalt', view: 'settings', theme });
    await s.waitForSelector('[data-testid=discord-moved-away]');
    check(`${tag} settings (alexalt): not linked + "moved to another Cipherline account"`, (await s.locator('[data-testid=discord-connect]').count()) === 1);
    await shot(s, tag, '11-settings-moved-away');
    if (sz.all) {
        const m = await app(ctx, { as: 'alex', view: 'settings', theme });
        await m.waitForSelector('[data-claim-row]:has-text("Shows as you")');
        await shot(m, tag, '12-settings-moved-in');
        check(`${tag} no page errors (alex settings)`, m.__errs.length === 0, m.__errs.join(' | '));
    }
    check(`${tag} no page errors`, [...a.__errs, ...s.__errs].length === 0, [...a.__errs, ...s.__errs].join(' | '));
    await ctx.close();
}

// ── Phase D (once): OK on the notice (keyboard), gone for good ──
{
    flush();
    const ctx = await context(SIZES[0], 'dark');
    const a = await app(ctx, { as: 'alexalt', view: 'notice', theme: 'dark' });
    await a.waitForSelector('[role=dialog]:has-text("Your Discord link was moved")');
    await a.keyboard.press('Enter');
    await a.waitForSelector('[role=dialog]', { state: 'detached', timeout: 10000 });
    check('OK (Enter): the notice closes and the server forgets it', psql(`SELECT count(*) FROM discord_link_move_notices`) === '0');
    const again = await app(ctx, { as: 'alexalt', view: 'notice', theme: 'dark' });
    await again.waitForTimeout(1500);
    check('after OK: a fresh sign-in shows no notice', (await again.locator('[role=dialog]').count()) === 0);
    await ctx.close();
}

const cipherline = blockedAll.filter((h) => /cipherline/i.test(h));
check('no request reached any Cipherline host (all non-loopback requests blocked + counted)', cipherline.length === 0, `blocked: ${[...new Set(blockedAll)].join(',') || 'none'}`);
const calls = await (await fetch(`${MOCK}/__calls`)).json();
const tokenCalls = calls.filter((c) => c.path === '/api/oauth2/token');
check('every token exchange sent the PKCE verifier and client auth', tokenCalls.length > 0 && tokenCalls.every((c) => c.form.includes('code_verifier') && c.auth === 'Basic'), String(tokenCalls.length));
check('every token was revoked after /users/@me', calls.filter((c) => c.path === '/api/oauth2/token/revoke').length === calls.filter((c) => c.path === '/api/v10/users/@me').length);
await browser.close();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
