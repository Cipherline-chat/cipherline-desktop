// Discord CLAIMS against an ISOLATED local API + MOCK Discord: the real link flow, claim, auto-map notice and the
// Settings row, screenshots + checks in Dark and Light at 1366x768, 1000x720, 1920x1080 and 1280x800@1.5.
//   SETUP=<json from discord-claims-setup.mjs> OUT=<dir> node harness/discord-claims-shots.mjs
//   env: BASE (default http://127.0.0.1:5363/harness/discord-claims.html), REDIS (the ISOLATED stack's redis, whose
//        throttle counters are reset between sizes), MOCK (http://127.0.0.1:7999), PG / PGDB (isolated DB, read-only
//        checks), PW_CHROMIUM_EXE
// Every request a page makes to anything but 127.0.0.1 is BLOCKED and counted (must be zero to Cipherline hosts).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5363/harness/discord-claims.html';
const OUT = process.env.OUT ?? '/tmp/discord-claims-shots';
const SETUP = readFileSync(process.env.SETUP, 'utf8');
const CFG = JSON.parse(SETUP);
const REDIS = process.env.REDIS ?? 'clclaims-redis';
if (!/^clclaims-/.test(REDIS)) throw new Error('only the isolated redis may be flushed');
const MOCK = process.env.MOCK ?? 'http://127.0.0.1:7999';
const PG = process.env.PG ?? 'cl-claims-pg'; const PGDB = process.env.PGDB ?? 'clclaims';
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', 'postgres', '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
mkdirSync(OUT, { recursive: true });
const SIZES = [
    { w: 1366, h: 768, dsf: 1, all: true }, { w: 1000, h: 720, dsf: 1, all: true },
    { w: 1920, h: 1080, dsf: 1, all: false }, { w: 1280, h: 800, dsf: 1.5, all: false },
];
const THEMES = ['dark', 'light'];
let failures = 0; let checks = 0;
const check = (name, ok, extra = '') => { checks++; if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const blockedAll = [];
const hash = encodeURIComponent(Buffer.from(SETUP).toString('base64'));
const setMockUser = (id, username) => fetch(`${MOCK}/__control`, { method: 'POST', body: JSON.stringify({ id, username }) });

async function context(sz, theme) {
    const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dsf, reducedMotion: 'reduce', colorScheme: theme, ignoreHTTPSErrors: true });
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === '127.0.0.1') return route.continue();
        blockedAll.push(u.hostname); return route.abort();
    });
    return ctx;
}
async function app(ctx, { as = 'sam', view = 'chat', theme = 'dark', channel = 'general' } = {}) {
    const p = await ctx.newPage();
    p.setDefaultTimeout(20000);
    p.__errs = []; p.on('pageerror', (e) => p.__errs.push(e.message));
    await p.goto(`${BASE}?theme=${theme}&as=${as}&view=${view}&channel=${channel}#${hash}`, { timeout: 90000 });
    await p.waitForFunction(() => window.__booted === true, null, { timeout: 60000 });
    if (view !== 'settings') await p.waitForFunction(() => !!window.__chat, null, { timeout: 30000 });
    await p.waitForTimeout(700);
    return p;
}
const shotOf = (tag) => async (p, name) => { await p.mouse.move(2, 2); await p.waitForTimeout(250); await p.screenshot({ path: `${OUT}/${tag}-${name}.png` }); };
const openCard = async (p, name) => {
    await p.locator('[data-imported-author-name]').filter({ hasText: new RegExp(`^${name}$`) }).first().click();
    await p.waitForSelector('[data-imported-author-card]');
};
async function fits(p, sel, label) {
    const r = await p.evaluate((s) => {
        const el = document.querySelector(s); if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, vw: innerWidth, vh: innerHeight, hs: document.documentElement.scrollWidth > innerWidth + 1 };
    }, sel);
    check(`${label}: inside the window, no sideways scroll`, !!r && r.top >= 0 && r.left >= 0 && r.right <= r.vw + 1 && r.bottom <= r.vh + 1 && !r.hs, r ? JSON.stringify(r) : 'missing');
}

// ── Phase A: sam is NOT linked ────────────────────────────────────────────
await setMockUser('900000000000000002', 'samwise.k');
let startUrl = null;
for (const theme of THEMES) for (const sz of SIZES) {
    execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);
    const tag = `${theme}-${sz.w}x${sz.h}${sz.dsf !== 1 ? '@' + sz.dsf : ''}`; const shot = shotOf(tag);
    const ctx = await context(sz, theme);
    const p = await app(ctx, { theme });
    const names = await p.locator('[data-imported-author-name]').allTextContents();
    check(`${tag} unlinked: imported authors render with their imported names`, names.includes('Sam') && names.includes('Riley Q'), names.join(','));
    check(`${tag} unlinked: Alex (auto-claimed by alex) renders as the real account, not a card`, !names.includes('Alex') && (await p.locator('.cl-msg-head').filter({ hasText: 'alex' }).count()) > 0);
    check(`${tag} unlinked: "Sam" collides with member sam -> "· @samwise.k" suffix`, (await p.locator('[data-imported-author-suffix]').filter({ hasText: '@samwise.k' }).count()) > 0);
    await openCard(p, 'Sam');
    await p.waitForSelector('[data-claim-slot]:has-text("Is this you?")');
    check(`${tag} card: "Claim with Discord" offered`, (await p.locator('[data-imported-author-card] button', { hasText: 'Claim with Discord' }).count()) === 1);
    await fits(p, '[data-imported-author-card]', `${tag} card`);
    await shot(p, '01-card-not-linked');
    if (sz.all) {
        await p.locator('[data-imported-author-card] button', { hasText: 'Claim with Discord' }).click();
        await p.waitForSelector('[data-claim-slot]:has-text("Finish in your browser")');
        const opened = await p.evaluate(() => window.__opened.slice());
        check(`${tag} sign-in opened OUR https start page only`, opened.length === 1 && /^https:\/\/127\.0\.0\.1:13443\/v1\/discord\/oauth\/start\?state=[A-Za-z0-9_-]{43}$/.test(opened[0]), opened.join(' '));
        startUrl = opened[0];
        await shot(p, '02-card-waiting');
        const s = await app(ctx, { theme, view: 'settings' });
        await s.waitForSelector('[data-testid=discord-connect]');
        await shot(s, '03-settings-not-linked');
        const i = await ctx.newPage();
        const r = await i.goto(startUrl);
        check(`${tag} interstitial names the Cipherline account`, r.status() === 200 && (await i.content()).includes('Link Discord to sam#'));
        await i.screenshot({ path: `${OUT}/${tag}-04-link-interstitial.png` });
    }
    check(`${tag} no page errors`, p.__errs.length === 0, p.__errs.join(' | '));
    await ctx.close();
}

// ── Phase B (once): the full browser flow, then the app notices by itself ──
{
    execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);
    const sz = SIZES[0]; const tag = 'dark-1366x768'; const shot = shotOf(tag);
    const ctx = await context(sz, 'dark');
    const p = await app(ctx, { theme: 'dark' });
    await openCard(p, 'Sam');
    await p.locator('[data-imported-author-card] button', { hasText: 'Claim with Discord' }).click();
    await p.waitForSelector('[data-claim-slot]:has-text("Finish in your browser")');
    const url = (await p.evaluate(() => window.__opened.slice()))[0];
    // The browser leg, in a separate tab of the same browser profile (cookie binding).
    const b = await ctx.newPage();
    await b.goto(url);
    await b.locator('a', { hasText: 'Continue to Discord' }).click();
    await b.waitForSelector('#approve');
    await b.screenshot({ path: `${OUT}/${tag}-05-mock-consent.png` });
    await b.locator('#approve').click();
    await b.waitForLoadState();
    const done = await b.content();
    check('browser flow: callback says "Discord linked"', done.includes('Discord linked'));
    await b.screenshot({ path: `${OUT}/${tag}-06-link-done.png` });
    const cbUrl = b.url();
    // Replay of the same callback (same cookie jar): refused, nothing changes.
    const replay = await b.goto(cbUrl);
    check('replayed callback is refused (single-use state)', replay.status() === 410 || replay.status() === 400, String(replay.status()));
    const n = psql(`SELECT count(*) FROM discord_links WHERE user_id = '${CFG.sam.user_id}'`);
    check('DB: sam has exactly one link (keyed hash)', n === '1', n);
    // The app notices the link by itself (poll) and offers the claim.
    await p.waitForSelector('[data-claim-slot]:has-text("These are yours")', { timeout: 20000 });
    check('app: the waiting card turned into "These are yours" without a reload', true);
    await shot(p, '07-card-linked-live');
    // A SECOND Cipherline account (importer) tries to link the SAME Discord account: refused.
    const tok = CFG.importer.token;
    const start = await p.evaluate(async ([api, t]) => (await (await fetch(api + '/discord/link', { method: 'POST', headers: { authorization: `Bearer ${t}` } })).json()).url, [CFG.api, tok]);
    const t2 = await ctx.newPage();
    await t2.goto(start);
    await t2.locator('a', { hasText: 'Continue to Discord' }).click();
    await t2.waitForSelector('#approve');
    await t2.locator('#approve').click();
    await t2.waitForLoadState();
    check('a second account linking the same Discord account sees "already linked"', (await t2.content()).includes('linked to another Cipherline account'));
    await t2.screenshot({ path: `${OUT}/${tag}-06b-link-taken.png` });
    check('DB: the importer has no link', psql(`SELECT count(*) FROM discord_links WHERE user_id = '${CFG.importer.user_id}'`) === '0');
    // A link generated for one account, opened in ANOTHER browser (no binding cookie): refused at the callback.
    const startForSam = await p.evaluate(async ([api, t]) => (await (await fetch(api + '/discord/link', { method: 'POST', headers: { authorization: `Bearer ${t}` } })).json()).url, [CFG.api, CFG.sam.token]);
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    const o = await other.newPage();
    await o.goto(startForSam);
    const consent = await o.locator('a', { hasText: 'Continue to Discord' }).getAttribute('href');
    await other.close();
    const victim = await browser.newContext({ ignoreHTTPSErrors: true });
    const v = await victim.newPage();
    await v.goto(consent); // straight to the provider, never loaded /start: no cookie
    await v.locator('#approve').click();
    await v.waitForLoadState();
    check('a consent URL handed to another browser is refused at the callback (no binding cookie)', (await v.content()).includes("didn't confirm"));
    await victim.close();
    await ctx.close();
}

// ── Phase C: sam linked, not yet claimed ───────────────────────────────────
for (const theme of THEMES) for (const sz of SIZES) {
    execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);
    const tag = `${theme}-${sz.w}x${sz.h}${sz.dsf !== 1 ? '@' + sz.dsf : ''}`; const shot = shotOf(tag);
    const ctx = await context(sz, theme);
    const p = await app(ctx, { theme });
    await openCard(p, 'Sam');
    await p.waitForSelector('[data-claim-slot]:has-text("These are yours")');
    if (sz.all) await shot(p, '07-card-linked');
    await p.locator('[data-imported-author-card] button', { hasText: 'Claim these messages' }).click();
    await p.waitForSelector('.mcard:has-text("Show these messages as you?")');
    const body = await p.locator('.mcard').innerText();
    check(`${tag} confirm: count, server, importer and date`, /3 messages/.test(body) && body.includes('Pixel Farm Co-op') && /@importer#\d{4}/.test(body), body.slice(0, 160).replace(/\n/g, ' '));
    await fits(p, '.mcard', `${tag} confirm dialog`);
    await shot(p, '08-confirm');
    await p.locator('[data-claim-review-toggle]').click();
    await p.waitForSelector('[data-claim-review]');
    const review = await p.locator('[data-claim-review]').innerText();
    check(`${tag} review: #general with 3 messages`, review.includes('#general') && review.includes('3 messages'), review.replace(/\n/g, ' '));
    await fits(p, '.mcard', `${tag} review`);
    if (sz.all || sz.w === 1920) await shot(p, '09-review');
    await p.locator('.mcard button', { hasText: 'Cancel' }).click();
    const s = await app(ctx, { theme, view: 'settings' });
    await s.waitForSelector('[data-claim-row]');
    check(`${tag} settings: "Ready to claim" row for Pixel Farm Co-op`, (await s.locator('[data-claim-row]').innerText()).includes('Ready to claim'));
    await shot(s, '10-settings-linked');
    check(`${tag} no page errors`, p.__errs.length === 0 && s.__errs.length === 0, [...p.__errs, ...s.__errs].join(' | '));
    await ctx.close();
}

// ── Phase D (once): claim through the dialog ───────────────────────────────
{
    execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);
    const ctx = await context(SIZES[0], 'dark');
    const p = await app(ctx, { theme: 'dark' });
    await openCard(p, 'Sam');
    await p.waitForSelector('[data-claim-slot]:has-text("These are yours")');
    await p.locator('[data-imported-author-card] button', { hasText: 'Claim these messages' }).click();
    await p.locator('.mcard button', { hasText: /^Claim 3 messages$/ }).click();
    await p.waitForSelector('.mcard', { state: 'detached' });
    const samRef = CFG.imports[0].refs.sam;
    check('DB: Sam\'s author claimed by sam (manual)', psql(`SELECT claim_source FROM import_authors WHERE id = '${samRef}' AND claimed_user_id = '${CFG.sam.user_id}'`) === 'manual');
    await p.evaluate(() => window.__reload());
    await p.waitForTimeout(800);
    const chat = await p.evaluate(() => window.__chat);
    check('history marks: Sam\'s 3 rows now carry claimed_user_id = sam', chat.claimed.filter((u) => u === CFG.sam.user_id).length === 3, JSON.stringify(chat.claimed));
    const names = await p.locator('[data-imported-author-name]').allTextContents();
    check('after claim: no imported "Sam" name remains; only Riley Q is unclaimed', !names.includes('Sam') && names.includes('Riley Q'), names.join(','));
    await ctx.close();
}

// ── Phase E: claimed + the auto-map notice for alex ────────────────────────
for (const theme of THEMES) for (const sz of SIZES) {
    execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);
    const tag = `${theme}-${sz.w}x${sz.h}${sz.dsf !== 1 ? '@' + sz.dsf : ''}`; const shot = shotOf(tag);
    const ctx = await context(sz, theme);
    const p = await app(ctx, { theme });
    if (sz.all) await shot(p, '11-claimed-channel');
    const s = await app(ctx, { theme, view: 'settings' });
    await s.waitForSelector('[data-claim-row]:has-text("Shows as you")');
    await shot(s, '12-settings-claimed');
    const a = await app(ctx, { as: 'alex', view: 'notice', theme, channel: 'announcements' });
    await a.waitForSelector('.mcard:has-text("Your Discord messages now show as you")');
    const t = await a.locator('.mcard').innerText();
    check(`${tag} auto notice (alex): count + server + importer, Report / Unclaim / OK`, /3 messages/.test(t) && t.includes('Pixel Farm Co-op') && /Report/.test(t) && /Unclaim/.test(t), t.slice(0, 140).replace(/\n/g, ' '));
    await fits(a, '.mcard', `${tag} auto notice`);
    await shot(a, '13-auto-notice');
    check(`${tag} no page errors`, [...p.__errs, ...s.__errs, ...a.__errs].length === 0, [...p.__errs, ...s.__errs, ...a.__errs].join(' | '));
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
