// "Always a thumbnail" (2026-11-24, embeds-always-thumb) in the REAL dev
// Electron (main + preload + CSP + unfurler + clmedia:// + snapshotter), two
// profiles = two devices, the renderer from this worktree's Vite, the API
// pinned to a loopback stub. Pages: harness/always-thumb-main.tsx.
//
//   1. SENDER: the composer builds previews of LIVE links through main and
//      runs the picture chain for real (Medal in five URL shapes incl. two
//      clips whose real thumbnail is a black first frame, a direct .mp4, an X
//      video, a Twitch clip, a TikTok, a Giphy loop, a page with nothing, a
//      bot wall); the real send path re-encodes + encrypts + uploads. One
//      black-thumbnail clip is sent BEFORE its frame is grabbed and the
//      shipped late attach makes the embeds-only edit. Two legacy messages
//      (what staging .277 sent; an app with no previews) are added.
//   2. RECEIVER (fresh profile): every request logged in main from before the
//      page loads; rows drawn in Compact / Expanded x dark / light at
//      1366x768. Every embed must show a picture; no linked site may be
//      contacted before play (GIF loops auto-load from their media host by
//      the app's GIF rule; listed separately).
//
//   LE_PORT=5497 LE_CACHE=<dir> VITE_API_HOST=127.0.0.1:13197 npx vite --config harness/link-embeds.vite.config.ts &
//   STUB_PORT=13197 STUB_LOG=<file> node harness/sender-embeds-api-stub.mjs &
//   OUT=<dir> LE_PORT=5497 STUB_PORT=13197 xvfb-run -a -s "-screen 0 2600x1700x24" node harness/always-thumb-electron.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { _electron } = require('/home/antigravity/Cipherline/node_modules/playwright-core');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const OUT = process.env.OUT;
const PORT = process.env.LE_PORT ?? '5497';
const STUB = process.env.STUB_PORT ?? '13197';
const SCALE = process.env.SCALE ?? '1';
const SIZES = (process.env.SIZES ?? '1366x768').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const LAYOUTS = (process.env.LAYOUTS ?? 'compact,expanded').split(',');
const PHASES = (process.env.PHASES ?? 'sender,receiver').split(',');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const PAGE = (qs) => `http://127.0.0.1:${PORT}/harness/always-thumb.html?${qs}`;
const profiles = [];

async function launch(profile) {
    profiles.push(profile);
    const app = await _electron.launch({
        executablePath: path.join(APP, 'node_modules/electron/dist/electron'),
        args: [APP, '--no-sandbox', `--user-data-dir=${profile}`, '--password-store=basic', `--force-device-scale-factor=${SCALE}`],
        cwd: APP,
        env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${PORT}`, VITE_API_HOST: `127.0.0.1:${STUB}`, ELECTRON_ENABLE_LOGGING: '1' },
        timeout: 120000,
    });
    const mainLines = [];
    const onMain = (d) => { for (const l of String(d).split('\n')) if (/\[(unfurl|snapshot|snapshot-proxy|clmedia)\]/.test(l)) mainLines.push(l.replace(/^.*?\[(unfurl|snapshot-proxy|snapshot|clmedia)\]/, '[$1]').trim()); };
    app.process().stdout.on('data', onMain);
    app.process().stderr.on('data', onMain);
    const answerKeyringDialog = () => {
        try {
            const id = execFileSync('xdotool', ['search', '--name', 'Encryption at rest disabled'], { encoding: 'utf8' }).trim().split('\n')[0];
            if (id) { execFileSync('xdotool', ['windowfocus', '--sync', id]); execFileSync('xdotool', ['key', '--window', id, 'Return']); }
        } catch { /* not up yet */ }
    };
    let win = null;
    for (let i = 0; i < 240 && !win; i++) {
        win = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${PORT}`)) ?? null;
        if (!win) { answerKeyringDialog(); await sleep(500); }
    }
    if (!win) throw new Error('no main window');
    const consoleLog = [];
    win.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
    await sleep(3000);
    return { app, win, mainLines, consoleLog };
}
const setSize = (app, w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('127.0.0.1')) ?? BrowserWindow.getAllWindows()[0];
    if (bw.isMaximized()) bw.unmaximize();
    bw.setContentSize(w, h);
    return bw.getContentSize();
}, [w, h]);

// ── 1. sender ───────────────────────────────────────────────────────────────
if (PHASES.includes('sender')) {
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'at-sender-')));
    await setSize(app, 1366, 768);
    await win.goto(PAGE('role=sender&theme=dark'));
    await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    const t0 = Date.now();
    await win.waitForFunction(() => document.querySelectorAll('.cl-cep-item').length >= 12 && !document.querySelector('.cl-cep-item[data-status="loading"], .cl-cep-item[data-snapshot="taking"]'), null, { timeout: 150000 }).catch(() => { results.senderPreviewTimeout = true; });
    results.senderPreviewsReadyMs = Date.now() - t0;
    await sleep(500);
    await win.screenshot({ path: path.join(OUT, `composer-previews-dark-1366x768@${SCALE}.png`) });
    results.chain = await win.evaluate(() => window.__chain);
    const sent = await win.evaluate(async () => window.__send());
    results.sendMs = sent.map((s) => s.ms);
    const pic = (i) => (i ? { w: i.width, h: i.height, designed: !!i.designed, inline: !!i.inline_b64, attachment: !!i.attachment_id, bytes: i.byte_size ?? (i.inline_b64 ? Math.round(i.inline_b64.length * 3 / 4) : undefined) } : undefined);
    results.sentEmbeds = sent.map((s) => (s.content.embeds ?? []).map((e) => ({ url: e.url, kind: e.kind, site: e.site, title: e.title?.slice(0, 50), media: e.media ? { host: new URL(e.media.url).host, w: e.media.width, h: e.media.height, d: e.media.duration_s, loop: e.media.loop } : undefined, thumb: pic(e.thumb), icon: pic(e.author_icon), images: e.images?.length })));

    await win.evaluate(() => window.__typeFast());
    await sleep(800);
    const tFast = Date.now();
    const fast = await win.evaluate(async () => window.__sendFast());
    results.fast = { late: fast.late, sentPicture: pic(fast.sentPicture), outcome: fast.outcome, editAfterMs: fast.editAfterMs, totalMs: Date.now() - tFast, edit: fast.edits[0] ? { target: fast.edits[0].target_id, embeds_only: fast.edits[0].embeds_only, picture: pic(fast.edits[0].embeds?.[0]?.thumb), media: fast.edits[0].embeds?.[0]?.media } : null };
    const legacy = await win.evaluate(async () => window.__legacy());
    results.legacyThumb = legacy.legacyThumb;

    await win.evaluate(async (p) => window.__publish(p), { messages: [...sent.map((s) => s.content), fast.content, ...legacy.messages], edits: fast.edits.slice(0, 1) });
    results.senderMainLog = mainLines.slice();
    // Bytes each frame grab really streamed (clmedia "grab … sent=N" lines, per token).
    const grabs = {};
    for (const l of mainLines) { const m = /^\[clmedia\] (\w{8}) grab (\w+) sent=(\d+)/.exec(l); if (m) grabs[m[1]] = (grabs[m[1]] ?? 0) + Number(m[3]); }
    results.frameGrabBytes = grabs;
    results.senderConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 20);
    await app.close();
}

// ── request log in main ─────────────────────────────────────────────────────
const LINKED = /(^|\.)(medal\.tv|mozilla\.net|x\.com|twitter\.com|twimg\.com|twitch\.tv|jtvnw\.net|tiktok\.com|tiktokcdn(-us|-eu)?\.com|giphy\.com|example\.com|stackoverflow\.com|sstatic\.net)$/i;
const GIF_MEDIA = /^(media\d*\.giphy\.com|i\.giphy\.com)$/i;
const UI_FONTS = /^(fonts\.googleapis\.com|fonts\.gstatic\.com)$/i;
async function installRequestLog(app) {
    await app.evaluate(({ session }) => {
        globalThis.__reqLog = [];
        session.defaultSession.webRequest.onBeforeRequest((d, cb) => { globalThis.__reqLog.push(`chromium ${d.method} ${d.url.slice(0, 160)}`); cb({}); });
        const req = process.mainModule.require;
        for (const name of ['https', 'http']) {
            const mod = req(name);
            const orig = mod.request;
            mod.request = function (url, opts, cb) {
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
const hostOf = (line) => { try { return new URL(line.split(' ').pop()).hostname; } catch { return ''; } };
const waitRows = (win) => win.waitForFunction(() => window.__ready === true && Array.isArray(window.__msgs) && document.querySelectorAll('[data-row]').length === window.__msgs.length, null, { timeout: 60000 });

async function shots(app, win, name) {
    for (const [w, h] of SIZES) {
        await setSize(app, w, h);
        await sleep(700);
        const n = await win.evaluate(() => document.querySelectorAll('[data-row]').length);
        for (let i = 0; i < n; i++) {
            const el = await win.$(`[data-row="${i}"]`);
            await el.scrollIntoViewIfNeeded();
            await sleep(200);
            await el.screenshot({ path: path.join(OUT, `row${String(i).padStart(2, '0')}-${name}-${w}x${h}@${SCALE}.png`) });
        }
        // Full pages, top to bottom.
        await win.evaluate(() => { document.getElementById('feed').scrollTop = 0; });
        for (let page = 1; page <= 12; page++) {
            await sleep(300);
            await win.screenshot({ path: path.join(OUT, `receiver-${name}-${w}x${h}@${SCALE}-${page}.png`) });
            const more = await win.evaluate(() => { const f = document.getElementById('feed'); const before = f.scrollTop; f.scrollTop += f.clientHeight - 40; return f.scrollTop > before; });
            if (!more) break;
        }
    }
}

if (PHASES.includes('receiver')) {
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'at-receiver-')));
    await installRequestLog(app);
    await takeLog(app);
    const all = [];
    results.receiver = {};
    for (const layout of LAYOUTS) for (const theme of THEMES) {
        await win.goto(PAGE(`role=receiver&theme=${theme}&layout=${layout}`));
        await waitRows(win);
        await sleep(2500);
        results.receiver[`${layout}-${theme}`] = await win.evaluate(() => [...document.querySelectorAll('[data-link]')].map((l) => {
            const e = l.querySelector('[data-embed]');
            const img = e?.querySelector('.cl-pe-video img, .cl-pe-cell img') ?? e?.querySelector('img.cl-ve-frame.ready, .cl-se-hero img, .cl-se-thumb img, .cl-se-amb img, img[data-gif-poster], video, img');
            const b = img?.getBoundingClientRect();
            return {
                row: l.closest('[data-row]')?.getAttribute('data-row'), link: l.getAttribute('data-link'), from: l.getAttribute('data-from'), sentThumb: l.getAttribute('data-sent-thumb'),
                embed: e?.getAttribute('data-embed') ?? null, picture: e?.getAttribute('data-picture') ?? (e?.querySelector('.cl-pe-video img, .cl-pe-cell img') ? 'real' : null),
                shown: !!img && b.width > 20 && b.height > 20, size: b ? `${Math.round(b.width)}x${Math.round(b.height)}` : null,
                edited: l.closest('[data-row]')?.getAttribute('data-edited') === 'true',
            };
        }));
        await shots(app, win, `${layout}-${theme}`);
        all.push(...(await takeLog(app)));
    }
    results.receiverRequestCount = all.length;
    results.receiverHosts = [...new Set(all.map(hostOf))].sort();
    results.receiverLinkedSiteRequests = all.filter((l) => LINKED.test(hostOf(l)));
    results.receiverGifMediaRequests = all.filter((l) => GIF_MEDIA.test(hostOf(l))).length;
    results.receiverNodeRequests = all.filter((l) => l.startsWith('node-'));
    results.receiverMainLines = mainLines.filter((l) => !l.startsWith('[clmedia]')).slice(0, 20);
    fs.writeFileSync(path.join(OUT, `receiver-requests-scale${SCALE}.log`), all.map((l) => l.replace(/token=[^&\s]+/g, 'token=REDACTED')).join('\n') + '\n');
    results.receiverConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 25);
    await app.close();
}

for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
fs.writeFileSync(path.join(OUT, `results-scale${SCALE}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
