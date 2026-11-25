// "Size follows the media" + direction C + click-to-enlarge (2026-11-24,
// embeds-media-sizing) in the REAL dev Electron (main + preload + CSP +
// clmedia://), the renderer from this worktree's Vite, the API pinned to a
// loopback stub. Pages: harness/media-sizing-main.tsx.
//
//   1. BUILD: the messages a sender's app sends for the test media, with real
//      pictures (frames of the real videos, the real YouTube thumbnails, real
//      photos; FIXTURES=<dir> of JPEGs) through the real thumbnail uploader.
//   2. RECEIVER (fresh profile, every Chromium + Node request logged in main):
//      Compact / Expanded x dark / light x 1000x720 / 1366x768, idle and
//      playing (the live TikTok and YouTube players, the vertical and square
//      video files through clmedia://). Every media embed is MEASURED: the
//      media box has the media's own aspect (no letterbox: also the playing
//      <video>'s own size vs its box), the card is as wide as the media (no
//      side gutters), nothing leaves the chat column, TikTok's frame is at
//      least 252 px wide; light mode has no outlines.
//   3. CLICK TO ENLARGE: a page card's picture and a post's picture open the
//      app's image viewer (click, and Enter on the focused picture) with NO
//      request at all (request log), Open original present.
//
//   LE_PORT=5531 LE_CACHE=<dir> VITE_API_HOST=127.0.0.1:13231 npx vite --config harness/link-embeds.vite.config.ts &
//   STUB_PORT=13231 STUB_LOG=<file> node harness/sender-embeds-api-stub.mjs &
//   OUT=<dir> FIXTURES=<dir> LE_PORT=5531 STUB_PORT=13231 xvfb-run -a -s "-screen 0 2600x1700x24" node harness/media-sizing-electron.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { _electron } = require('/home/antigravity/Cipherline/node_modules/playwright-core');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const OUT = process.env.OUT;
const FIX = process.env.FIXTURES;
const PORT = process.env.LE_PORT ?? '5531';
const STUB = process.env.STUB_PORT ?? '13231';
const SIZES = (process.env.SIZES ?? '1000x720,1366x768').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const LAYOUTS = (process.env.LAYOUTS ?? 'compact,expanded').split(',');
const PLAY = (process.env.PLAY ?? 'tiktok,short,file-vertical,file-square,youtube').split(',').filter(Boolean);
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = (qs) => `http://127.0.0.1:${PORT}/harness/media-sizing.html?${qs}`;
const results = { problems: [], measures: {}, playing: {}, viewer: {} };
const problem = (s) => { results.problems.push(s); console.log('PROBLEM', s); };

async function launch(name) {
    const profile = path.join(OUT, `profile-${name}`);
    fs.mkdirSync(profile, { recursive: true });
    const app = await _electron.launch({
        executablePath: path.join(APP, 'node_modules/electron/dist/electron'),
        args: [APP, '--no-sandbox', `--user-data-dir=${profile}`, '--password-store=basic', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'],
        cwd: APP,
        env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${PORT}`, VITE_API_HOST: `127.0.0.1:${STUB}` },
        timeout: 120000,
    });
    let win = null;
    for (let i = 0; i < 240 && !win; i++) {
        win = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${PORT}`)) ?? null;
        if (!win) {
            try {
                const id = execFileSync('xdotool', ['search', '--name', 'Encryption at rest disabled'], { encoding: 'utf8' }).trim().split('\n')[0];
                if (id) { execFileSync('xdotool', ['windowfocus', '--sync', id]); execFileSync('xdotool', ['key', '--window', id, 'Return']); }
            } catch { /* not up yet */ }
            await sleep(500);
        }
    }
    if (!win) throw new Error('no main window');
    const consoleLog = [];
    win.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
    await sleep(2500);
    return { app, win, consoleLog };
}
const setSize = (app, w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('127.0.0.1')) ?? BrowserWindow.getAllWindows()[0];
    if (bw.isMaximized()) bw.unmaximize();
    bw.setContentSize(w, h);
    return bw.getContentSize();
}, [w, h]);

// ── 1. build ────────────────────────────────────────────────────────────────
{
    const { app, win } = await launch('build');
    await win.goto(PAGE('role=build&theme=dark'));
    await win.waitForFunction(() => window.__ready === true && typeof window.__build === 'function', null, { timeout: 60000 });
    const fixtures = {};
    for (const f of fs.readdirSync(FIX).filter((f) => f.endsWith('.jpg'))) {
        const buf = fs.readFileSync(path.join(FIX, f));
        // JPEG SOF0/SOF2 size
        let w = 0, h = 0;
        for (let i = 2; i < buf.length - 9;) {
            if (buf[i] !== 0xff) { i++; continue; }
            const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
            if (m >= 0xc0 && m <= 0xc2) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
            i += 2 + len;
        }
        fixtures[f.replace(/\.jpg$/, '')] = { b64: buf.toString('base64'), w, h };
    }
    results.fixtures = Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, `${v.w}x${v.h}`]));
    results.built = await win.evaluate((fx) => window.__build(fx), fixtures);
    await app.close();
}

// ── request log in main ─────────────────────────────────────────────────────
async function installRequestLog(app) {
    await app.evaluate(({ session }) => {
        globalThis.__reqLog = [];
        session.defaultSession.webRequest.onBeforeRequest((d, cb) => { globalThis.__reqLog.push(`chromium ${d.method} ${d.url.slice(0, 160)}`); cb({}); });
        const req = process.mainModule.require;
        for (const name of ['https', 'http']) {
            const mod = req(name);
            const orig = mod.request;
            mod.request = function (url) {
                try {
                    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : `${url?.protocol ?? ''}//${url?.hostname ?? url?.host ?? ''}${url?.path ?? ''}`;
                    globalThis.__reqLog.push(`node-${name} ${String(u).slice(0, 160)}`);
                } catch { /* logging only */ }
                return orig.apply(this, arguments);
            };
        }
    });
}
const takeLog = (app) => app.evaluate(() => { const l = globalThis.__reqLog.slice(); globalThis.__reqLog.length = 0; return l; });

// Everything measured in the page, per embed.
const MEASURE = () => {
    const out = [];
    const near = (a, b, tol) => Math.abs(a - b) / b <= tol;
    for (const l of document.querySelectorAll('[data-link]')) {
        const row = l.closest('[data-row]');
        const key = row.dataset.key;
        const col = row.querySelector('[data-col]').getBoundingClientRect();
        const first = l.firstElementChild;
        const card = first?.matches('[data-embed]') ? first : first?.querySelector('[data-embed]');
        const r = { key, problems: [] };
        out.push(r);
        if (!card) { r.problems.push('no embed drawn'); continue; }
        const cr = card.getBoundingClientRect();
        r.embed = card.dataset.embed; r.cls = card.className.replace(/\bmt-2\b/, '').trim();
        r.card = `${Math.round(cr.width)}x${Math.round(cr.height)}`;
        const outer = (first.getBoundingClientRect());
        if (cr.right > col.right + 0.5 || cr.left < col.left - 0.5 || outer.right > col.right + 0.5) r.problems.push(`overflows the column (${Math.round(cr.right)} > ${Math.round(col.right)})`);
        const mb = card.matches('[data-media-box]') ? card : card.querySelector('[data-media-box]');
        let box = null;
        if (mb) {
            const m = mb.getBoundingClientRect();
            box = m;
            r.media = `${Math.round(m.width * 10) / 10}x${Math.round(m.height * 10) / 10}`;
            const declared = Number(mb.dataset.mediaAspect || card.dataset.mediaAspect);
            r.aspect = Math.round((m.width / m.height) * 1000) / 1000;
            if (declared && !near(m.width / m.height, declared, 0.02)) r.problems.push(`box ${r.aspect} != media ${declared}`);
            if (card.classList.contains('cl-ve--reel') && Math.abs(cr.width - m.width) > 1) r.problems.push(`side gutter: card ${cr.width} vs media ${m.width}`);
            if (card.dataset.embed === 'post' && card.dataset.hug && card.dataset.layout === 'expanded' && cr.width > 281) {
                // the card's CONTENT box (minus padding and the dark theme's hairline) must equal the media
                const cs = getComputedStyle(card);
                const inner = cr.width - ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((a, k) => a + parseFloat(cs[k]), 0);
                if (Math.abs(inner - m.width) > 1) r.problems.push(`post card content ${inner} vs its media ${m.width}`);
            }
            if (m.right > col.right + 0.5) r.problems.push('media overflows the column');
            // the media must be wholly inside its card (a card narrower than its media clips it)
            if (m.right > cr.right + 0.5 || m.left < cr.left - 0.5) r.problems.push(`media ${Math.round(m.width)} wide clipped by its card ${Math.round(cr.width)}`);
            if (card.dataset.embed === 'post' && m.right > cr.right - 6) r.problems.push(`media ${Math.round(m.width)} reaches past the card's padding (${Math.round(cr.width)})`);
        }
        // what is really drawn inside the box: no letterbox
        const v = card.querySelector('video');
        if (v && v.videoWidth && v.videoHeight) {
            const vb = v.getBoundingClientRect();
            r.video = `${v.videoWidth}x${v.videoHeight}`;
            if (!near(v.videoWidth / v.videoHeight, vb.width / vb.height, 0.02)) r.problems.push(`letterboxed video: ${v.videoWidth}x${v.videoHeight} in ${Math.round(vb.width)}x${Math.round(vb.height)}`);
        }
        const f = card.querySelector('iframe');
        if (f) { const fb = f.getBoundingClientRect(); r.frame = `${Math.round(fb.width)}x${Math.round(fb.height)}`; if (r.embed === 'tiktok' && fb.width < 251.5) r.problems.push(`TikTok frame only ${fb.width}px`); }
        const img = card.querySelector('img[data-media-box], img.cl-ve-frame.ready:not([data-designed]), .cl-pe-video img, .cl-pe-cell img, .cl-gif img');
        if (img && img.naturalWidth && r.embed !== 'youtube') {
            const ib = img.getBoundingClientRect();
            r.picture = `${img.naturalWidth}x${img.naturalHeight}`;
            if (!near(img.naturalWidth / img.naturalHeight, ib.width / ib.height, 0.03)) r.problems.push(`picture ${img.naturalWidth}x${img.naturalHeight} cropped/letterboxed in ${Math.round(ib.width)}x${Math.round(ib.height)}`);
        }
        if (!mb && !v && !img) r.note = 'nothing measurable yet';
    }
    // light: no outlines inside the embed rows
    let lines = 0;
    const lined = [];
    let ringed = 0;
    if (document.documentElement.dataset.scheme === 'light') {
        for (const el of document.querySelectorAll('.cl-embed-row *')) {
            // The play button's ring and the spinner sit ON the picture, not the page, and keep
            // theirs by the owner's light-mode rule (link-embeds.css); counted apart.
            if (el.matches('.cl-ve-play, .cl-ve-spin')) { ringed++; continue; }
            const s = getComputedStyle(el);
            for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
                const w = parseFloat(s[`border${side}Width`]);
                const c = s[`border${side}Color`];
                if (w > 0 && s[`border${side}Style`] !== 'none' && !/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') { lines++; lined.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`); break; }
            }
        }
    }
    return { embeds: out, lightLines: lines, lightLined: lined.slice(0, 10), playRingsOnPictures: ringed };
};

async function loadImages(win) {
    // Image links on hosts that do not auto-load: press "Load image" (the user's click).
    await win.evaluate(() => { for (const b of document.querySelectorAll('.img-link-wrap button')) if (/Load image/.test(b.textContent)) b.click(); });
    await win.waitForFunction(() => [...document.querySelectorAll('.img-link-wrap img')].every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll('.img-link-wrap img').length >= 3, null, { timeout: 30000 }).catch(() => problem('image links did not load'));
    await sleep(1200);
}

const { app, win, consoleLog } = await launch('receiver');
await installRequestLog(app);
await takeLog(app);
const allReq = [];
for (const layout of LAYOUTS) for (const theme of THEMES) for (const [W, H] of SIZES) {
    const tag = `${layout}-${theme}-${W}x${H}`;
    await setSize(app, W, H);
    await win.goto(PAGE(`role=receiver&theme=${theme}&layout=${layout}`));
    await win.waitForFunction(() => window.__ready === true && Array.isArray(window.__msgs) && document.querySelectorAll('[data-row]').length === window.__msgs.length && window.__msgs.length > 0, null, { timeout: 60000 });
    await sleep(2500);
    await loadImages(win);
    // GIF loop: its file streams through clmedia (the app's GIF rule); give it a moment.
    await sleep(1500);
    const m = await win.evaluate(MEASURE);
    results.measures[tag] = m;
    for (const e of m.embeds) for (const p of e.problems) problem(`${tag} ${e.key}: ${p}`);
    if (m.lightLines) problem(`${tag}: ${m.lightLines} outlined elements in light mode: ${m.lightLined.join(", ")}`);
    // idle: every row, then full pages
    const n = await win.evaluate(() => document.querySelectorAll('[data-row]').length);
    for (let i = 0; i < n; i++) {
        const el = await win.$(`[data-row="${i}"]`);
        const key = await el.getAttribute('data-key');
        await el.scrollIntoViewIfNeeded();
        await sleep(150);
        await el.screenshot({ path: path.join(SHOTS, `idle-${tag}-${String(i).padStart(2, '0')}-${key}.png`) });
    }
    await win.evaluate(() => { document.getElementById('feed').scrollTop = 0; });
    for (let page = 1; page <= 14; page++) {
        await sleep(250);
        await win.screenshot({ path: path.join(SHOTS, `page-${tag}-${page}.png`) });
        const more = await win.evaluate(() => { const f = document.getElementById('feed'); const b = f.scrollTop; f.scrollTop += f.clientHeight - 60; return f.scrollTop > b; });
        if (!more) break;
    }
    // playing, one at a time (the chat's one-player rule)
    results.playing[tag] = {};
    for (const key of PLAY) {
        const row = await win.$(`[data-row][data-key="${key}"]`);
        if (!row) continue;
        await row.scrollIntoViewIfNeeded();
        const btn = await row.$('.cl-ve-play');
        if (!btn) { problem(`${tag} ${key}: no play button`); continue; }
        await btn.click();
        const live = key === 'tiktok' || key === 'short' || key === 'youtube';
        await win.waitForFunction((k) => { const r = document.querySelector(`[data-row][data-key="${k}"]`); const v = r?.querySelector('video'); return !!r?.querySelector('iframe') || (v && v.videoWidth > 0 && v.currentTime > 0.3); }, key, { timeout: 25000 }).catch(() => problem(`${tag} ${key}: did not start playing`));
        await sleep(live ? 7000 : 1200);
        await row.scrollIntoViewIfNeeded();
        await sleep(200);
        const pm = (await win.evaluate(MEASURE)).embeds.find((e) => e.key === key);
        results.playing[tag][key] = pm;
        for (const p of pm?.problems ?? []) problem(`${tag} playing ${key}: ${p}`);
        // hover the player so the provider / native controls show in the shot
        const box = await row.$('.cl-ve-player');
        if (box) { const b = await box.boundingBox(); await win.mouse.move(b.x + b.width / 2, b.y + b.height - 40); await sleep(900); }
        await row.screenshot({ path: path.join(SHOTS, `playing-${tag}-${key}.png`) });
        await win.mouse.move(5, 5);
    }
    allReq.push(...(await takeLog(app)));

    // click to enlarge (once per layout x theme, at the larger size)
    if (W === SIZES[SIZES.length - 1][0]) {
        await win.goto(PAGE(`role=receiver&theme=${theme}&layout=${layout}`));
        await win.waitForFunction(() => window.__ready === true && document.querySelectorAll('[data-row]').length > 0, null, { timeout: 60000 });
        await sleep(3000);
        const v = {};
        for (const [key, sel, how] of [['page', '[data-picture-open]', 'click'], ['page', '[data-picture-open]', 'enter'], ['x-picture', '.cl-pe-cell', 'click']]) {
            const row = await win.$(`[data-row][data-key="${key}"]`);
            await row.scrollIntoViewIfNeeded();
            await sleep(300);
            const pic = await row.$(sel);
            if (!pic) { problem(`${tag} ${key}: no openable picture`); continue; }
            await takeLog(app);
            if (how === 'click') await pic.click(); else { await pic.focus(); await win.keyboard.press('Enter'); }
            await sleep(900);
            const state = await win.evaluate(() => {
                const img = [...document.body.querySelectorAll('img')].find((i) => i.style.maxWidth === '90vw');
                return { open: !!img, src: img ? img.getAttribute('src').slice(0, 12) : null, natural: img ? `${img.naturalWidth}x${img.naturalHeight}` : null, openOriginal: !!document.querySelector('[aria-label="Open original"]'), save: !!document.querySelector('[aria-label="Save image"]') };
            });
            const reqs = (await takeLog(app)).filter((l) => !/ (blob|data|devtools|chrome-extension):/.test(l));
            v[`${key}-${how}`] = { ...state, requests: reqs };
            if (!state.open) problem(`${tag} ${key} ${how}: the viewer did not open`);
            if (reqs.length) problem(`${tag} ${key} ${how}: ${reqs.length} request(s) while opening the viewer: ${reqs.join(' ; ')}`);
            await win.screenshot({ path: path.join(SHOTS, `viewer-${layout}-${theme}-${W}x${H}-${key}-${how}.png`) });
            await win.keyboard.press('Escape');
            await sleep(600);
        }
        results.viewer[`${layout}-${theme}`] = v;
    }
}
const hostOf = (line) => { try { return new URL(line.split(' ').pop()).hostname; } catch { return ''; } };
results.receiverRequestCount = allReq.length;
results.receiverHosts = [...new Set(allReq.map(hostOf))].sort();
fs.writeFileSync(path.join(OUT, 'receiver-requests.log'), allReq.map((l) => l.replace(/token=[^&\s]+/g, 'token=REDACTED')).join('\n') + '\n');
results.consoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 30);
await app.close();
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`problems: ${results.problems.length}`);
console.log(JSON.stringify(results.problems, null, 1));
