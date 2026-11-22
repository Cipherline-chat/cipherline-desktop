// ROLE ICONS + gradient role colours against an ISOLATED local API: member list, chat author names, profile role
// pills and Server Settings > Roles (icon picker upload / remove, gradient control), screenshots + checks in Dark,
// Light and High contrast at 1366x768, 1000x720, 1920x1080 and 1280x800@1.5.
//   SETUP=<json from role-icons-setup.mjs> OUT=<dir> node harness/role-icons-shots.mjs
//   env: BASE (default http://127.0.0.1:5371/harness/role-icons.html), REDIS (the ISOLATED stack's redis container,
//        throttle counters reset between passes), PG / PGDB / PGUSER (isolated DB, read-only checks), PW_CHROMIUM_EXE
// Every request a page makes to anything but 127.0.0.1 is BLOCKED and counted (must be zero).
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const sharp = createRequire(path.resolve(here, '../../api/package.json'))('sharp');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5371/harness/role-icons.html';
const OUT = process.env.OUT ?? '/tmp/role-icons-shots';
const SETUP = readFileSync(process.env.SETUP, 'utf8');
const CFG = JSON.parse(SETUP);
const REDIS = process.env.REDIS ?? 'cl-ricon-redis';
if (!/^cl-ricon-/.test(REDIS)) throw new Error('only the isolated redis may be flushed');
const PG = process.env.PG ?? 'cl-ricon-pg'; const PGDB = process.env.PGDB ?? 'ricon'; const PGUSER = process.env.PGUSER ?? 'ricon';
const psql = (sql) => execFileSync('docker', ['exec', PG, 'psql', '-U', PGUSER, '-d', PGDB, '-Atqc', sql], { encoding: 'utf8' }).trim();
const flush = () => execFileSync('docker', ['exec', REDIS, 'redis-cli', 'FLUSHALL']);
mkdirSync(OUT, { recursive: true });
const SIZES = [
    { w: 1366, h: 768, dsf: 1, all: true }, { w: 1000, h: 720, dsf: 1, all: true },
    { w: 1920, h: 1080, dsf: 1, all: false }, { w: 1280, h: 800, dsf: 1.5, all: false },
];
let failures = 0; let checks = 0;
const check = (name, ok, extra = '') => { checks++; if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const blocked = [];
const hash = encodeURIComponent(Buffer.from(SETUP).toString('base64'));
const sizeTag = (sz) => `${sz.w}x${sz.h}${sz.dsf !== 1 ? `@${sz.dsf}` : ''}`;

async function context(sz, theme) {
    const ctx = await browser.newContext({ viewport: { width: sz.w, height: sz.h }, deviceScaleFactor: sz.dsf, reducedMotion: 'reduce', colorScheme: theme.startsWith('hc-') ? (theme === 'hc-light' ? 'light' : 'dark') : theme });
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === '127.0.0.1') return route.continue();
        blocked.push(u.hostname); return route.abort();
    });
    return ctx;
}
async function app(ctx, { as = 'jules', view = 'server', theme = 'dark' } = {}) {
    const p = await ctx.newPage();
    p.setDefaultTimeout(20000);
    p.__errs = []; p.on('pageerror', (e) => p.__errs.push(e.message));
    await p.goto(`${BASE}?theme=${theme}&as=${as}&view=${view}#${hash}`, { timeout: 150000 });
    await p.waitForFunction(() => window.__booted === true, null, { timeout: 150000 });
    return p;
}
const shot = async (p, name) => { await p.mouse.move(2, 2); await p.waitForTimeout(250); await p.screenshot({ path: `${OUT}/${name}.png` }); };
const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

/** The member-list row for a username (ServerContextPanel). */
const rowInfo = (p, name) => p.evaluate((n) => {
    const panel = document.querySelector('#panel');
    const span = [...panel.querySelectorAll('span.truncate')].find((s) => s.textContent === n);
    if (!span) return null;
    const line = span.parentElement;
    const icon = line.querySelector('[data-role-icon]');
    const img = icon?.querySelector('img');
    return {
        gradient: span.classList.contains('cl-role-gradient'),
        fill: getComputedStyle(span).webkitTextFillColor,
        color: getComputedStyle(span).color,
        icon: icon?.getAttribute('data-role-icon') ?? null,
        iconText: icon?.textContent ?? '',
        iconLabel: icon?.getAttribute('aria-label') ?? null,
        imgW: img ? img.naturalWidth : 0,
        iconBox: icon ? icon.getBoundingClientRect().width : 0,
        nameRight: span.getBoundingClientRect().right, panelRight: panel.getBoundingClientRect().right,
    };
}, name);

async function serverPass(sz, theme) {
    flush();
    const ctx = await context(sz, theme);
    const p = await app(ctx, { as: 'jules', view: 'server', theme });
    await p.waitForFunction(() => [...document.querySelectorAll('#panel span.truncate')].some((s) => s.textContent === 'riley'), null, { timeout: 30000 });
    await p.waitForFunction(() => !!document.querySelector('#panel [data-role-icon="image"] img'), null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(600);
    const tag = `${theme}-${sizeTag(sz)}`;
    const hc = theme.startsWith('hc-');
    const riley = await rowInfo(p, 'riley'); const ari = await rowInfo(p, 'ari'); const jules = await rowInfo(p, 'jules'); const maya = await rowInfo(p, 'maya');
    check(`[${tag}] member list: riley shows the Moderators IMAGE icon, decrypted (128px source)`, riley?.icon === 'image' && riley.imgW === 128, JSON.stringify(riley));
    check(`[${tag}] member list: ari shows the Artists emoji (highest icon role, not VIP's)`, ari?.icon === 'emoji' && ari.iconText === '🎨', JSON.stringify(ari));
    check(`[${tag}] member list: icon is labelled with the role name`, riley?.iconLabel === 'Moderators role icon');
    check(`[${tag}] member list: plain members have no icon`, jules?.icon === null && maya?.icon === null);
    check(`[${tag}] member list: gradient names ${hc ? 'fall back to SOLID on high contrast' : 'use the gradient class'}`,
        hc ? (riley && !riley.gradient && ari && !ari.gradient) : (riley?.gradient && ari?.gradient && riley.fill === 'rgba(0, 0, 0, 0)'), JSON.stringify({ riley, ari }));
    check(`[${tag}] member list: name + icon stay inside the panel`, riley && riley.nameRight + riley.iconBox <= riley.panelRight + 1);
    const chat = await p.evaluate(() => {
        const root = document.querySelector('#chat');
        const names = [...root.querySelectorAll('span.font-semibold')].filter((s) => ['maya', 'riley', 'ari', 'sam', 'jules'].includes(s.textContent?.trim() ?? ''));
        return {
            icons: root.querySelectorAll('[data-role-icon]').length,
            names: names.map((s) => ({ n: s.textContent.trim(), gradient: s.classList.contains('cl-role-gradient'), color: getComputedStyle(s).color })),
        };
    });
    check(`[${tag}] chat: NO role icons next to author names (owner 2026-11-22)`, chat.icons === 0, `icons=${chat.icons}`);
    const g = (n) => chat.names.find((x) => x.n === n);
    check(`[${tag}] chat: author names ${hc ? 'solid on high contrast' : 'carry the gradient (riley, ari, sam) and jules stays plain'}`,
        hc ? chat.names.every((x) => !x.gradient) && chat.names.length >= 5
           : g('riley')?.gradient && g('ari')?.gradient && g('sam')?.gradient && g('jules') && !g('jules').gradient, JSON.stringify(chat.names));
    check(`[${tag}] no sideways scroll`, await noSideScroll(p));
    await shot(p, `server-${tag}`);
    if (sz.all) {
        await p.evaluate(() => window.__openProfile('ari'));
        await p.waitForSelector('[data-testid="profile-roles"] .pcd-role', { timeout: 20000 });
        await p.waitForTimeout(500);
        const pills = await p.evaluate(() => [...document.querySelectorAll('[data-testid="profile-roles"] .pcd-role')].map((li) => ({
            text: li.textContent.trim(), icon: li.querySelector('[data-role-icon]')?.textContent ?? null,
            dot: getComputedStyle(li.querySelector('i')).backgroundImage,
        })));
        check(`[${tag}] profile: role pills carry their icons (Artists 🎨, VIP 💎)`, pills.some((x) => x.text.includes('Artists') && x.icon === '🎨') && pills.some((x) => x.text.includes('VIP') && x.icon === '💎'), JSON.stringify(pills));
        check(`[${tag}] profile: the gradient role's dot is a gradient`, pills.some((x) => x.text.includes('Artists') && x.dot.includes('linear-gradient')));
        await shot(p, `profile-${tag}`);
    }
    check(`[${tag}] no page errors`, p.__errs.length === 0, p.__errs.join(' | '));
    await ctx.close();
}

async function rolesPass(sz, theme) {
    flush();
    const ctx = await context(sz, theme);
    const p = await app(ctx, { as: 'maya', view: 'roles', theme });
    await p.waitForSelector('[data-testid="role-icon-picker"]', { timeout: 30000 });
    await p.waitForFunction(() => !!document.querySelector('[data-testid="role-icon-preview"] [data-role-icon="image"] img'), null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(500);
    const tag = `${theme}-${sizeTag(sz)}`;
    const ed = await p.evaluate(() => ({
        hero: document.querySelector('[data-testid="role-hero-name"]')?.textContent,
        heroGradient: document.querySelector('[data-testid="role-hero-name"]')?.classList.contains('cl-role-gradient'),
        preview: document.querySelector('[data-testid="role-icon-preview"] [data-role-icon]')?.getAttribute('data-role-icon'),
        gradientToggle: !!document.querySelector('[data-testid="role-gradient"]'),
    }));
    check(`[${tag}] roles editor: Moderators hero, gradient + image icon preview`, ed.hero === '@Moderators' && ed.preview === 'image' && ed.gradientToggle && (theme.startsWith('hc-') ? !ed.heroGradient : ed.heroGradient), JSON.stringify(ed));
    check(`[${tag}] roles editor: no sideways scroll`, await noSideScroll(p));
    await shot(p, `roles-${tag}`);
    await p.locator('[data-testid="role-gradient"]').scrollIntoViewIfNeeded();
    await shot(p, `roles-icon-picker-${tag}`);
    check(`[${tag}] roles: no page errors`, p.__errs.length === 0, p.__errs.join(' | '));
    await ctx.close();
}

/** The full icon flow through the UI on Artists: upload an image, then remove it, then a too-big file. */
async function interactivePass() {
    flush();
    const sz = SIZES[0]; const theme = 'dark';
    const ctx = await context(sz, theme);
    const p = await app(ctx, { as: 'maya', view: 'roles', theme });
    await p.waitForSelector('[data-testid="role-icon-picker"]', { timeout: 30000 });
    // Pick Artists in the role dropdown.
    await p.getByRole('combobox', { name: /Select role to edit/ }).click().catch(async () => { await p.locator('.selt').first().click(); });
    await p.getByRole('option', { name: /Artists/ }).click();
    await p.waitForFunction(() => document.querySelector('[data-testid="role-hero-name"]')?.textContent === '@Artists');
    check('[ui] Artists starts with its emoji icon', await p.evaluate(() => document.querySelector('[data-testid="role-icon-preview"] [data-role-icon]')?.textContent) === '🎨');
    // Keyboard: the picker's buttons are reachable with Tab and named.
    const names = await p.evaluate(() => [...document.querySelectorAll('[data-testid="role-icon-picker"] button')].map((b) => b.textContent.trim()));
    check('[ui] icon picker buttons: Upload image / Choose emoji / Remove', names.includes('Upload image') && names.includes('Choose emoji') && names.includes('Remove'), JSON.stringify(names));
    await p.locator('[data-testid="role-icon-picker"] button', { hasText: 'Upload image' }).focus();
    const focused = await p.evaluate(() => document.activeElement?.textContent?.trim());
    check('[ui] Upload image is keyboard-focusable', focused === 'Upload image', focused);
    // Upload a real image through the UI.
    const palette = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 245, g: 166, b: 35, alpha: 1 } } })
        .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><circle cx="150" cy="100" r="70" fill="#ec4899"/></svg>') }]).png().toBuffer();
    await p.setInputFiles('[data-testid="role-icon-file"]', { name: 'palette.png', mimeType: 'image/png', buffer: palette });
    await p.waitForFunction(() => !!document.querySelector('[data-testid="role-icon-preview"] [data-role-icon="image"] img'), null, { timeout: 30000 });
    const row = psql(`SELECT coalesce(icon_emoji,'-') || '|' || coalesce(icon_attachment_id::text,'-') FROM roles WHERE role_id = '${CFG.roles.artists}'`);
    check('[ui] upload stored an IMAGE icon and dropped the emoji', row.startsWith('-|') && row.split('|')[1].length === 36, row);
    await shot(p, 'ui-upload-done-dark-1366x768');
    // Remove.
    await p.locator('[data-testid="role-icon-picker"] button', { hasText: 'Remove' }).click();
    await p.waitForFunction(() => document.querySelector('[data-testid="role-icon-preview"]')?.textContent?.includes('None'));
    await p.waitForTimeout(400);
    check('[ui] Remove cleared the icon in the DB', psql(`SELECT coalesce(icon_emoji,'') || coalesce(icon_attachment_id::text,'') FROM roles WHERE role_id = '${CFG.roles.artists}'`) === '');
    // Error state: an over-size file is refused client-side with a readable reason.
    await p.setInputFiles('[data-testid="role-icon-file"]', { name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 10) });
    const err = await p.locator('[data-testid="role-icon-error"]').textContent();
    check('[ui] over-size upload shows an inline error', /over 5 MB/.test(err ?? ''), err);
    await shot(p, 'ui-error-dark-1366x768');
    // Put the emoji back for later passes (through the API, as the picker would).
    await fetch(`${CFG.api}/servers/${CFG.server_id}/roles/${CFG.roles.artists}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.maya.token}` }, body: JSON.stringify({ icon_emoji: '🎨' }) });
    check('[ui] no page errors', p.__errs.length === 0, p.__errs.join(' | '));
    await ctx.close();
}

/** Live fan-out: a member's socket hears the role change (the event every client re-fetches roles on). */
async function wsPass() {
    flush();
    const wsUrl = CFG.api.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(CFG.jules.token)}`;
    const ws = new WebSocket(wsUrl);
    const got = [];
    ws.onmessage = (m) => { try { got.push(JSON.parse(String(m.data))); } catch { /* */ } };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; setTimeout(() => rej(new Error('ws timeout')), 10000); });
    await new Promise((r) => setTimeout(r, 500));
    await fetch(`${CFG.api}/servers/${CFG.server_id}/roles/${CFG.roles.vip}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.maya.token}` }, body: JSON.stringify({ icon_emoji: '👑' }) });
    await fetch(`${CFG.api}/servers/${CFG.server_id}/roles/${CFG.roles.vip}/icon`, { method: 'DELETE', headers: { authorization: `Bearer ${CFG.maya.token}` } });
    await new Promise((r) => setTimeout(r, 1500));
    ws.close();
    const evs = got.filter((e) => e.event === 'server:permissions_changed' && e.data?.server_id === CFG.server_id);
    check('[ws] a plain member is told about both icon edits (server:permissions_changed)', evs.length >= 2, `events=${got.map((e) => e.event).join(',')}`);
    await fetch(`${CFG.api}/servers/${CFG.server_id}/roles/${CFG.roles.vip}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.maya.token}` }, body: JSON.stringify({ icon_emoji: '💎' }) });
}

await wsPass();
await interactivePass();
for (const sz of SIZES) {
    for (const theme of ['dark', 'light']) {
        await serverPass(sz, theme);
        if (sz.all) await rolesPass(sz, theme);
    }
}
await serverPass(SIZES[0], 'hc-dark');
await rolesPass(SIZES[0], 'hc-dark');
const cl = blocked.filter((h) => /cipherline/i.test(h));
check('no request reached a Cipherline host (everything off-loopback was blocked)', cl.length === 0, `blocked hosts: ${[...new Set(blocked)].join(',') || 'none'}`);
await browser.close();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
