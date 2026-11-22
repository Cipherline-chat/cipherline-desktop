// Theme coverage audit (claude/theme-coverage-audit): every harness scene x every
// theme, automated. For each harness vite config it starts ONE vite server (JS
// API, private cache, its own port) with a plugin that injects
// harness/theme-param.ts before the page's entry, so any existing harness scene
// renders in ?theme=<id> with the app's theme stylesheets. Each page is
// screenshotted and checked in-page for:
//   contrast   text under 4.5:1 (3:1 for large text) against its real rendered background
//   island     a large opaque box whose lightness is the opposite of the theme's scheme
//              (a dark box in a light theme, a light box in a dark one) outside the
//              D4 dark islands (profile cards, celebrations, Firewall, call stage, tiles)
//   literal    a large box painted EXACTLY a Dark palette colour in a theme that is not Dark
//              (a hard-coded navy left in CSS / TSX)
//
//   node harness/theme-coverage-scan.mjs --out=<dir> [--themes=dark,light,...] [--only=<scene substr>]
//        [--size=1366x768] [--dsf=1] [--conc=3] [--json=<file>]
// Files: <out>/<scene>--<theme>.png and <out>/report.json.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, exe, arg } from './reaction-center-measure.mjs';

const require = createRequire(import.meta.url);
const vite = require('vite');
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ALL_THEMES = ['dark', 'light', 'custom-ocean', 'custom-rose', 'midnight', 'hc-dark', 'hc-light'];
const THEMES = arg('themes', ALL_THEMES.join(',')).split(',').filter(Boolean);
const OUT = arg('out', path.join(os.tmpdir(), 'theme-coverage'));
const ONLY = arg('only', '');
const [VW, VH] = arg('size', '1366x768').split('x').map(Number);
const DSF = Number(arg('dsf', '1'));
const CONC = Number(arg('conc', '3'));
const NOSHOT = arg('noshot', '') === '1';
fs.mkdirSync(OUT, { recursive: true });

const DIALOG = '[role="dialog"], [role="alertdialog"]';
const wait = (ms) => (page) => page.waitForTimeout(ms);
const click = (sel, ms = 900) => async (page) => { await page.locator(sel).first().click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(ms); };

/** [config, html, query, scene name, { scope?, prep? }] */
export const SCENES = [
    // ── The app shell with the real panes (harness/light-theme-main.tsx; it applies ?theme itself) ──
    ['light-theme', 'light-theme', 'view=home', 'home'],
    ['light-theme', 'light-theme', 'view=server', 'server-feed-top', { prep: async (p) => { await p.evaluate(() => document.getElementById('msg-m1')?.scrollIntoView({ block: 'start' })); await p.waitForTimeout(600); } }],
    ['light-theme', 'light-theme', 'view=server', 'server-feed-bottom'],
    ['light-theme', 'light-theme', 'view=dm', 'dm'],
    ['light-theme', 'light-theme', 'view=friends', 'friends'],
    ['light-theme', 'light-theme', 'view=dm', 'emoji-picker', { prep: click('button[title="Emoji"]') }],
    ['light-theme', 'light-theme', 'view=dm', 'gif-picker', { prep: click('button[title="GIF"]', 1500) }],
    ['light-theme', 'light-theme', 'view=menu', 'context-menu-toast', { prep: async (p) => {
        await p.evaluate(() => window.__toast?.('success')); await p.waitForTimeout(400);
        const box = await p.locator('[id="msg-m9"]').first().boundingBox().catch(() => null);
        if (box) await p.mouse.click(box.x + box.width * 0.45, box.y + 12, { button: 'right' });
        await p.waitForTimeout(700);
    } }],
    ['light-theme', 'light-theme', 'view=modal', 'category-dialog'],
    ['light-theme', 'light-theme', 'view=keys', 'keys-mascot'],
    ...['appearance', 'accessibility', 'profile', 'activityStyle', 'devices', 'voice', 'notifications', 'keybinds', 'activity', 'privacy', 'storage', 'billing', 'advanced', 'danger']
        .map((tab) => ['light-theme', 'light-theme', `view=settings&tab=${tab}`, `settings-${tab}`]),
    ['light-theme', 'light-theme', 'view=settings&tab=appearance&lib=1', 'settings-custom-themes', { prep: async (p) => { await p.evaluate(() => document.querySelector('.ct-section, [data-labels*="Custom"]')?.scrollIntoView({ block: 'center' })); await p.waitForTimeout(500); } }],
    ['light-theme', 'light-theme', 'view=auth', 'sign-in'],
    ['light-theme', 'light-theme', 'view=auth', 'sign-up', { prep: async (p) => { await p.locator('button', { hasText: /create.*account|sign up|new here/i }).last().click({ timeout: 4000 }).catch(() => {}); await p.waitForTimeout(1200); } }],
    ['light-theme', 'light-theme', 'view=offline', 'offline-screen'],
    // ── Everyday bits ──
    ['everyday', 'everyday', 'scene=loading', 'loading-screen'],
    ['everyday', 'everyday', 'scene=typing', 'typing-line'],
    ['everyday', 'everyday', 'scene=shortcuts', 'shortcuts-dialog', { prep: async (p) => { await p.keyboard.press('Shift+Slash'); await p.waitForTimeout(800); } }],
    ['everyday', 'everyday', 'scene=whatsnew', 'whats-new'],
    ['everyday', 'everyday', 'scene=backonline', 'back-online', { prep: async (p) => { await p.evaluate(() => { window.__online?.(false); }); await p.waitForTimeout(900); } }],
    // ── Window-sizes scenes (real components in a Dashboard-shaped frame) ──
    ['window-sizes', 'window-sizes', 'scene=member', 'member-list'],
    ['window-sizes', 'window-sizes', 'scene=channels', 'channel-list'],
    ['window-sizes', 'window-sizes', 'scene=composer', 'composer'],
    ['window-sizes', 'window-sizes', 'scene=composer&text=fmt', 'composer-formatted'],
    ['window-sizes', 'window-sizes', 'scene=wysiwyg', 'composer-wysiwyg'],
    ['window-sizes', 'window-sizes', 'scene=everyone', 'everyone-confirm', { scope: DIALOG }],
    ['window-sizes', 'window-sizes', 'scene=invite', 'invite-cards'],
    ['window-sizes', 'window-sizes', 'scene=sysrows', 'system-rows'],
    ['window-sizes', 'window-sizes', 'scene=giftcards', 'gift-cards'],
    ['window-sizes', 'window-sizes', 'scene=giftpick', 'gift-picker', { scope: DIALOG }],
    ['window-sizes', 'window-sizes', 'scene=incall', 'in-call-panel'],
    ['window-sizes', 'window-sizes', 'scene=incall&share=1', 'in-call-sharing'],
    ['window-sizes', 'window-sizes', 'scene=catdelete', 'category-delete', { scope: DIALOG }],
    // ── Formatting / long messages ──
    ['text-formatting', 'text-formatting', 'scene=feed', 'formatting-feed'],
    ['text-formatting', 'text-formatting', 'scene=code', 'code-blocks'],
    ['text-formatting', 'text-formatting', 'scene=composer&bar=1', 'formatting-bar'],
    ['long-message', 'long-message', 'scene=feed', 'long-message'],
    ['long-message', 'long-message', 'scene=feed&reader=l1', 'long-message-reader'],
    // ── Dialogs ──
    ...['addfriend', 'creategroup', 'addmembers', 'shared-links', 'shared-files', 'shared-media', 'closechat-dm', 'unsaved', 'crash', 'purge', 'danger', 'clconfirm-danger']
        .map((d) => ['dialogs-wave1', 'dialogs-wave1', `d=${d}`, `dlg-${d}`, { scope: DIALOG }]),
    ['dialogs-wave2', 'dialogs-wave2', 'd=ban', 'dlg-ban', { scope: DIALOG }],
    ...['stepup', 'restore', 'storage', 'changepw', 'totp', 'safety', 'devapprove', 'history', 'screenlock', 'picker', 'upgradeRequired']
        .map((d) => ['dialogs-wave3', 'dialogs-wave3', `d=${d}`, `dlg-${d}`, { scope: DIALOG }]),
    ...['report', 'topic', 'animated', 'totp'].map((d) => ['dialogs-restyle', 'dialogs-restyle', `d=${d}&v=new`, `dlg-${d === 'totp' ? 'totp-card' : d}`, { scope: d === 'totp' ? 'body' : DIALOG }]),
    ...['block', 'unfriend', 'delete-server', 'transfer'].map((d) => ['dialogs-restyle', 'dialogs-restyle', `d=${d}&v=new`, `dlg-${d}`, { scope: DIALOG }]),
    ...['create', 'join', 'preview', 'invite', 'import'].map((d) => ['server-dialogs', 'server-dialogs', `d=${d}`, `srv-${d}`, { scope: DIALOG }]),
    // ── Billing / gifts ──
    ['gifts', 'gifts', 'scene=cards', 'gift-card-states'],
    ['gifts', 'gifts', 'scene=section', 'gift-section'],
    ['trial-prompt', 'trial-prompt', 'scene=billing&who=founder', 'billing-pane'],
    ['trial-prompt', 'trial-prompt', 'scene=prompt&founder=open&days=2', 'trial-prompt', { scope: DIALOG }],
    ['checkout-layout', 'checkout-layout', '', 'checkout', { scope: DIALOG }],
    // ── Server settings / members ──
    ['server-banner-preview', 'server-banner-preview', 'banner=1', 'server-settings-overview'],
    ['member-groups', 'member-groups', '', 'member-groups'],
    ['emoji-bulk', 'emoji-bulk', '', 'emoji-bulk'],
    // ── Locked / blocked screens ──
    ['wallet-prompt', 'wallet-prompt', 'scene=generic', 'storage-locked'],
    ['wallet-prompt', 'wallet-prompt', 'scene=existing', 'wallet-locked'],
    ['kill-switch', 'kill-switch', 'scene=update', 'update-required'],
    ['kill-switch', 'kill-switch', 'scene=suspended', 'suspended'],
    // ── Misc surfaces ──
    ['status-dropdown', 'status-dropdown', '', 'status-dropdown'],
    ['home-pins', 'home-pins', '', 'home-pins'],
    ['home-calls', 'home-calls', '', 'home-calls'],
    ['new-message', 'new-message', '', 'new-message'],
    ['level-progress', 'level-progress', '', 'level-progress'],
    ['safety-verify', 'safety-verify', 'scene=hint', 'safety-hint'],
    ['reaction-center', 'reaction-center', 'scene=feed', 'image-attachment'],
    ['voice-gate', 'voice-gate', '', 'voice-gate'],
    ['share-notes', 'share-notes', '', 'share-notes'],
];

/** Dark's opaque palette (src/theme/themes.ts) and the navies most often hard-coded beside it. */
const DARK_LITERALS = ['#0B0F1E', '#131A30', '#1C2542', '#2A3558', '#0A1120', '#252F52', '#070B14', '#0F1528', '#0F1424', '#070A15', '#243056', '#161E38', '#101729', '#1E2848'];

/** The in-page checks (run in the browser). */
const CHECK = ({ scope, darkLiterals }) => {
    const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    const lits = new Set(darkLiterals.map((s) => s.toUpperCase()));
    const ISLAND = '.cl-island-dark, .pcd, .pfp, .ppo, .pcel, .lvu, .gb, .mo-root, .fw-root, .cl-console, .cl-tile-hover, .tp-pic, .tp-mini, .ctp, [class*="ctp-"], .ct-swatch, img, video, canvas, svg, picture, [aria-hidden="true"]';
    const scheme = document.documentElement.getAttribute('data-scheme') ?? 'dark';
    const themeId = document.documentElement.getAttribute('data-theme');
    const isCustom = document.documentElement.hasAttribute('data-custom-theme');
    const isDarkTheme = themeId === 'dark' && !isCustom;
    const roots = [...document.querySelectorAll(scope || 'body')];
    if (!roots.length) return { error: `scope ${scope} not found`, contrast: [], island: [], literal: [] };
    const desc = (el) => {
        const cls = (typeof el.className === 'string' ? el.className : el.className?.baseVal ?? '').trim().split(/\s+/).slice(0, 4).join('.');
        const t = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${t ? ` "${t}"` : ''}`;
    };
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return null;
        let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        if (op < 0.05) return null;
        return { r, cs, op };
    };
    const bgOf = (el) => {
        const layers = [];
        for (let e = el; e; e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/^linear-gradient\(rgb/.test(cs.backgroundImage)) return null;
            const c = parse(cs.backgroundColor);
            if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
            if (!e.parentElement) {
                // fall back to the root theme background
                const rc = parse(getComputedStyle(document.documentElement).backgroundColor);
                if (rc && rc.a >= 1) { layers.push(rc); break; }
                return null;
            }
        }
        if (!layers.length || layers[layers.length - 1].a < 1) return null;
        let acc = layers.pop();
        while (layers.length) acc = over(layers.pop(), acc);
        return acc;
    };
    const contrast = [], island = [], literal = [];
    const seen = new Set();
    for (const root of roots) {
        // (b) text contrast
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.textContent.trim();
            if (!text || text.length < 2) continue;
            const el = n.parentElement;
            if (!el || el.closest(ISLAND)) continue;
            if (el.closest('.sr-only, [disabled], [aria-disabled="true"], .cl-skel, [class*="skeleton"], [class*="placeholder"]')) continue;
            const v = visible(el); if (!v) continue;
            const fg = parse(v.cs.color); if (!fg) continue;
            const bg = bgOf(el); if (!bg) continue;
            const eff = over({ ...fg, a: fg.a * v.op }, bg);
            const k = ratio(eff, bg);
            const px = parseFloat(v.cs.fontSize); const bold = Number(v.cs.fontWeight) >= 700;
            const min = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;
            const key = `c|${desc(el)}|${v.cs.color}`;
            if (k < min && !seen.has(key)) { seen.add(key); contrast.push({ el: desc(el), text: text.slice(0, 40), ratio: Math.round(k * 100) / 100, fg: v.cs.color, bg: hex(bg), op: Math.round(v.op * 100) / 100 }); }
        }
        // (a)/(c) boxes
        for (const el of root.querySelectorAll('*')) {
            if (el.closest(ISLAND)) continue;
            const v = visible(el); if (!v) continue;
            const area = v.r.width * v.r.height;
            if (area < 2400 || v.r.width < 30 || v.r.height < 24) continue;
            const c = parse(v.cs.backgroundColor);
            if (!c || c.a < 0.85) continue;
            const L = lum(c);
            const h = hex(c);
            const key = `b|${desc(el)}|${h}`;
            if (seen.has(key)) continue;
            if (!isDarkTheme && lits.has(h)) { seen.add(key); literal.push({ el: desc(el), bg: h, w: Math.round(v.r.width), h: Math.round(v.r.height) }); continue; }
            // Accent / status fills (teal buttons, coral badges) are colour, not ground: skip saturated boxes.
            const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
            if (chroma < 60 && ((scheme === 'light' && L < 0.06) || (scheme === 'dark' && L > 0.45))) {
                seen.add(key); island.push({ el: desc(el), bg: h, w: Math.round(v.r.width), h: Math.round(v.r.height) });
            }
        }
    }
    return { scheme, themeId, isCustom, contrast, island, literal };
};

function injectThemeParam() {
    return {
        name: 'theme-param-inject',
        transformIndexHtml: {
            order: 'pre',
            handler(html, ctx) {
                if (/light-theme\.html$/.test(ctx.filename ?? ctx.path ?? '')) return html; // applies ?theme / ?use itself
                return html
                    .replace(/<script type="module"/, '<script type="module" src="/harness/theme-param.ts"></script>\n<script type="module"')
                    .replace(/<\/body>/, '<script type="module" src="/harness/theme-param-css.ts"></script>\n</body>');
            },
        },
    };
}

/** `virtual:whats-new` for configs without the real plugin (empty notes), so vite's dep scan works. */
function whatsNewStub() {
    return {
        name: 'whats-new-stub',
        resolveId(id) { return id === 'virtual:whats-new' ? '\0virtual:whats-new' : null; },
        load(id) { return id === '\0virtual:whats-new' ? 'export default { releases: {}, unreleased: null }' : null; },
    };
}

function urlFor(base, html, query, theme) {
    const q = new URLSearchParams(query);
    if (html === 'light-theme') {
        const m = /^custom-(.+)$/.exec(theme);
        if (m) q.set('use', m[1]); else q.set('theme', theme);
    } else q.set('theme', theme);
    return `${base}/harness/${html}.html?${q.toString()}`;
}

const report = fs.existsSync(path.join(OUT, 'report.json')) && ONLY ? JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8')) : {};
const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu', '--no-sandbox'] });
let port = Number(arg('port', '5470'));
const byConfig = new Map();
for (const s of SCENES) {
    if (ONLY && !ONLY.split(',').some((o) => s[3].includes(o))) continue;
    if (!byConfig.has(s[0])) byConfig.set(s[0], []);
    byConfig.get(s[0]).push(s);
}
try {
    for (const [cfg, scenes] of byConfig) {
        const p = port++;
        let server;
        try {
            server = await vite.createServer({
                configFile: path.join(HERE, `${cfg}.vite.config.ts`),
                cacheDir: path.join(os.tmpdir(), `vite-theme-cov-${cfg}`),
                server: { host: '127.0.0.1', port: p, strictPort: true, open: false, hmr: false },
                plugins: [injectThemeParam(), ...(fs.readFileSync(path.join(HERE, `${cfg}.vite.config.ts`), 'utf8').includes('whatsNewPlugin') ? [] : [whatsNewStub()])],
                logLevel: 'error',
            });
            await server.listen();
        } catch (e) { console.log(`!! ${cfg}: vite failed: ${e.message}`); continue; }
        const base = `http://127.0.0.1:${p}`;
        const jobs = [];
        for (const s of scenes) for (const theme of THEMES) jobs.push([s, theme]);
        const runJob = async ([[, html, query, name, opt = {}], theme]) => {
            const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, reducedMotion: 'reduce' });
            const page = await ctx.newPage();
            const errs = [];
            page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
            try {
                await page.goto(urlFor(base, html, query, theme), { waitUntil: 'load', timeout: 60000 });
                await page.waitForFunction(() => document.getElementById('root')?.childElementCount > 0, null, { timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(2200);
                if (opt.prep) await opt.prep(page);
                const res = await page.evaluate(CHECK, { scope: opt.scope ?? '', darkLiterals: DARK_LITERALS });
                if (!NOSHOT) await page.screenshot({ path: path.join(OUT, `${name}--${theme}.png`) });
                report[`${name}--${theme}`] = { ...res, errs };
                fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
                const n = (res.contrast?.length ?? 0) + (res.island?.length ?? 0) + (res.literal?.length ?? 0);
                console.log(`${n ? '!!' : 'ok'} ${name} / ${theme}: contrast ${res.contrast?.length ?? '?'}, island ${res.island?.length ?? '?'}, literal ${res.literal?.length ?? '?'}${res.error ? ' ' + res.error : ''}${errs.length ? ` (page errors: ${errs.length})` : ''}`);
            } catch (e) {
                report[`${name}--${theme}`] = { error: String(e.message).slice(0, 200), errs };
                console.log(`xx ${name} / ${theme}: ${String(e.message).slice(0, 120)}`);
            } finally { await ctx.close(); }
        };
        const queue = [...jobs];
        await Promise.all(Array.from({ length: CONC }, async () => { while (queue.length) await runJob(queue.shift()); }));
        await server.close();
        fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
    }
} finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
}
console.log(`\nreport: ${path.join(OUT, 'report.json')}`);
