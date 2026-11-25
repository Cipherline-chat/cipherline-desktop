// Link-embed FIXES (2026-11-23) in the REAL dev Electron (main + preload + CSP
// + unfurler + clmedia://), two profiles = two devices, renderer from this
// worktree's Vite, API pinned to a loopback stub (the harness refuses any
// other API). Pages: harness/embeds-fixes-main.tsx.
//
//   1. SENDER: the composer builds previews of LIVE links through main
//      (Tenor, amazon.com + a product page, Wikipedia, GitHub, BBC, NYT, two
//      Reddit posts, example.com, a Cloudflare wall, a missing Google Doc, an
//      http link, an unreachable host, YouTube / Medal / Twitch / X / TikTok);
//      the real send path re-encodes + encrypts + uploads pictures to the stub.
//   2. RECEIVER (fresh profile): every request logged in main (Chromium
//      webRequest + Node http/https) from before the page loads; rows drawn in
//      both layouts x both themes x 1000x720 / 1366x768; close-ups of the Tenor
//      GIF, the amazon cards and the no-picture cards. Only the Tenor GIF's
//      file (media.tenor.com, the sender's URL, auto-loaded like every GIF) may
//      be fetched; nothing else from a linked site.
//   3. LOCALTENOR: a bare Tenor link with no sender preview (older client):
//      the phase-2 local GIF path, its own request log.
//   4. OFF: "Show embeds" off: no embed, no linked-site request.
//
//   LE_PORT=5491 LE_CACHE=<dir> VITE_API_HOST=127.0.0.1:13191 npx vite --config harness/link-embeds.vite.config.ts &
//   STUB_PORT=13191 STUB_LOG=<file> node harness/sender-embeds-api-stub.mjs &
//   OUT=<dir> STUB_LOG=<file> LE_PORT=5491 STUB_PORT=13191 PHASES=sender,receiver,localtenor,off xvfb-run -a -s "-screen 0 2600x1700x24" node harness/embeds-fixes-electron.mjs
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
const PORT = process.env.LE_PORT ?? '5491';
const STUB = process.env.STUB_PORT ?? '13191';
const STUB_LOG = process.env.STUB_LOG;
const SCALE = process.env.SCALE ?? '1';
const SIZES = (process.env.SIZES ?? '1000x720,1366x768').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const LAYOUTS = (process.env.LAYOUTS ?? 'compact,expanded').split(',');
const PHASES = (process.env.PHASES ?? 'sender,receiver,localtenor,off').split(',');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const PAGE = (qs) => `http://127.0.0.1:${PORT}/harness/embeds-fixes.html?${qs}`;

async function launch(profile) {
    const app = await _electron.launch({
        executablePath: path.join(APP, 'node_modules/electron/dist/electron'),
        args: [APP, '--no-sandbox', `--user-data-dir=${profile}`, '--password-store=basic', `--force-device-scale-factor=${SCALE}`, '--autoplay-policy=no-user-gesture-required'],
        cwd: APP,
        env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${PORT}`, VITE_API_HOST: `127.0.0.1:${STUB}`, ELECTRON_ENABLE_LOGGING: '1' },
        timeout: 120000,
    });
    const mainLines = [];
    const onMain = (d) => { for (const l of String(d).split('\n')) if (/\[(unfurl|clmedia)\]/.test(l)) mainLines.push(l.replace(/^.*?\[(unfurl|clmedia)\]/, '[$1]').trim()); };
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
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'ef-sender-')));
    await setSize(app, 1366, 768);
    for (const theme of THEMES) {
        await win.goto(PAGE(`role=sender&theme=${theme}`));
        await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        const t0 = Date.now();
        await win.waitForFunction(() => document.querySelectorAll('.cl-cep-item').length >= 19 && !document.querySelector('.cl-cep-item[data-status="loading"]'), null, { timeout: 90000 }).catch(() => { results[`senderPreviewTimeout_${theme}`] = true; });
        results[`senderPreviewsReadyMs_${theme}`] = Date.now() - t0;
        await sleep(500);
        await win.screenshot({ path: path.join(OUT, `composer-previews-${theme}-1366x768@${SCALE}.png`) });
        if (theme === THEMES[0]) {
            // Composer chips before send, per link (status + text).
            results.composerItemsBeforeSend = await win.evaluate(() => document.querySelectorAll('.cl-cep-item').length);
        }
    }
    results.composerItems = await win.evaluate(() => [...document.querySelectorAll('.cl-cep-item')].map((e) => ({ status: e.getAttribute('data-status'), text: e.textContent.trim().slice(0, 80), pic: !!e.querySelector('img') })));
    const sent = await win.evaluate(async () => window.__send());
    results.sendMs = sent.map((s) => s.ms);
    const pic = (i) => (i ? { w: i.width, h: i.height, inline: !!i.inline_b64, attachment: !!i.attachment_id, bytes: i.byte_size ?? (i.inline_b64 ? Math.round(i.inline_b64.length * 3 / 4) : undefined) } : undefined);
    results.sentEmbeds = sent.map((s) => (s.content.embeds ?? []).map((e) => ({
        url: e.url, kind: e.kind, site: e.site, title: e.title, author: e.author, handle: e.author_handle, tag: e.tag, at: e.published_at,
        text: e.description?.slice(0, 80), player: e.player, nsfw: e.nsfw, score: e.score, comments: e.comments,
        media: e.media ? { host: new URL(e.media.url).host, mime: e.media.mime, w: e.media.width, h: e.media.height, dur: e.media.duration_s, loop: e.media.loop, no_audio: e.media.no_audio } : undefined,
        thumb: pic(e.thumb), icon: pic(e.author_icon), images: e.images?.map(pic),
    })));
    results.senderMainLog = mainLines.slice();
    results.senderConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 20);
    await app.close();
}

// ── request log in main ─────────────────────────────────────────────────────
const LINKED = /(^|\.)(tenor\.com|amazon\.com|media-amazon\.com|ssl-images-amazon\.com|wikipedia\.org|wikimedia\.org|github\.com|githubassets\.com|githubusercontent\.com|bbc\.com|bbc\.co\.uk|bbci\.co\.uk|nytimes\.com|nyt\.com|reddit\.com|redd\.it|redditmedia\.com|redditstatic\.com|example\.com|stackoverflow\.com|sstatic\.net|docs\.google\.com|neverssl\.com|invalid|youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com|medal\.tv|twitch\.tv|jtvnw\.net|x\.com|twitter\.com|twimg\.com|tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com)$/i;
// The one linked host a reader may contact without a click: the Tenor GIF's file (the
// sender's media URL; GIFs auto-load like images do). Logged and reported separately.
const GIF_MEDIA = /^media\d*\.tenor\.com$/i;
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
const stubLines = () => (STUB_LOG && fs.existsSync(STUB_LOG) ? fs.readFileSync(STUB_LOG, 'utf8').split('\n').filter(Boolean) : []);
const waitRows = (win) => win.waitForFunction(() => window.__ready === true && Array.isArray(window.__msgs) && document.querySelectorAll('[data-row]').length === window.__msgs.length, null, { timeout: 60000 });

async function shootFeed(app, win, name) {
    for (const [w, h] of SIZES) {
        await setSize(app, w, h);
        await sleep(700);
        const feed = await win.evaluate(() => { const f = document.getElementById('feed'); return { sh: f.scrollHeight, ch: f.clientHeight }; });
        const steps = Math.max(1, Math.ceil(feed.sh / Math.max(1, feed.ch - 60)));
        for (let k = 0; k < Math.min(steps, 12); k++) {
            await win.evaluate((k) => { const f = document.getElementById('feed'); f.scrollTop = k * (f.clientHeight - 60); }, k);
            await sleep(250);
            await win.screenshot({ path: path.join(OUT, `${name}-${w}x${h}@${SCALE}-${k + 1}.png`) });
        }
    }
}

const SHOTS = [
    ['tenor-gif', '[data-row="0"] [data-sender-embed="gif"]'],
    ['amazon', '[data-row="1"] .cl-embed-row'],
    ['nopicture', '[data-row="4"] .cl-embed-row'],
    ['reddit', '[data-row="3"] .cl-embed-row'],
];
async function closeUps(app, win, name) {
    for (const [w, h] of SIZES) {
        await setSize(app, w, h);
        await sleep(600);
        for (const [label, sel] of SHOTS) {
            const el = await win.$(sel);
            if (!el) { results[`missing_${label}_${name}`] = true; continue; }
            await el.scrollIntoViewIfNeeded();
            await sleep(250);
            await el.screenshot({ path: path.join(OUT, `${label}-${name}-${w}x${h}@${SCALE}.png`) });
        }
    }
}

if (['receiver', 'localtenor', 'off'].some((p) => PHASES.includes(p))) {
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'ef-receiver-')));
    await installRequestLog(app);
    await takeLog(app);

    if (PHASES.includes('receiver')) {
        const all = [];
        for (const layout of LAYOUTS) for (const theme of THEMES) {
            await win.goto(PAGE(`role=receiver&theme=${theme}&layout=${layout}`));
            await waitRows(win);
            await win.waitForFunction(() => document.querySelectorAll('.cl-se-frame, .cl-ve-frame.ready, .cl-pe-cell img').length >= 8 && document.querySelector('[data-sender-embed="gif"] video'), null, { timeout: 30000 }).catch(() => { results[`thumbTimeout_${layout}_${theme}`] = true; });
            await sleep(1500);
            await shootFeed(app, win, `receiver-${layout}-${theme}`);
            await closeUps(app, win, `${layout}-${theme}`);
            all.push(...(await takeLog(app)));
        }
        results.receiverRows = await win.evaluate(() => [...document.querySelectorAll('[data-row]')].map((r) => ({
            row: r.getAttribute('data-row'),
            embeds: [...r.querySelectorAll('[data-embed], [data-sender-embed]')].filter((e) => !e.parentElement?.closest('[data-embed]')).map((e) => {
                const v = e.querySelector('video');
                return {
                    kind: e.getAttribute('data-sender-embed') ?? e.getAttribute('data-embed'),
                    provider: e.getAttribute('data-provider') ?? undefined,
                    style: e.getAttribute('data-embed-style') ?? undefined,
                    shape: e.getAttribute('data-embed-shape') ?? undefined,
                    minimal: e.getAttribute('data-embed-minimal') === 'true' || undefined,
                    icon: e.getAttribute('data-embed-icon') ?? undefined,
                    title: (e.querySelector('.cl-se-title, .cl-ve-title, .cl-pe-title, .cl-pe-name')?.textContent ?? '').slice(0, 70) || undefined,
                    pictures: e.querySelectorAll('img').length,
                    gif: v ? { box: `${Math.round(v.getBoundingClientRect().width)}x${Math.round(v.getBoundingClientRect().height)}`, natural: `${v.videoWidth}x${v.videoHeight}`, aspect: v.style.aspectRatio, muted: v.muted, loop: v.loop, controls: v.hasAttribute('controls'), playing: !v.paused } : undefined,
                    playButton: !!e.querySelector('.cl-ve-play'),
                };
            }),
        })));
        results.receiverRequestCount = all.length;
        results.receiverHosts = [...new Set(all.map(hostOf))].sort();
        results.receiverGifMediaRequests = all.filter((l) => GIF_MEDIA.test(hostOf(l)));
        results.receiverLinkedSiteRequests = all.filter((l) => LINKED.test(hostOf(l)) && !GIF_MEDIA.test(hostOf(l)));
        results.receiverNodeRequests = all.filter((l) => l.startsWith('node-'));
        fs.writeFileSync(path.join(OUT, `receiver-requests-scale${SCALE}.log`), all.join('\n') + '\n');
    }

    if (PHASES.includes('localtenor')) {
        await takeLog(app);
        for (const layout of LAYOUTS) {
            await win.goto(PAGE(`role=receiver&theme=dark&layout=${layout}&extra=localtenor`));
            await waitRows(win);
            await win.waitForFunction(() => { const v = document.querySelector('[data-embed="gif-loop"] video'); return v && v.videoWidth > 0; }, null, { timeout: 30000 }).catch(() => { results[`localTenorTimeout_${layout}`] = true; });
            await setSize(app, 1366, 768);
            await sleep(1200);
            const el = await win.$('[data-row="0"]');
            if (el) await el.screenshot({ path: path.join(OUT, `tenor-local-no-preview-${layout}-dark-1366x768@${SCALE}.png`) });
            results[`localTenor_${layout}`] = await win.evaluate(() => {
                const v = document.querySelector('[data-embed="gif-loop"] video');
                if (!v) return null;
                const r = v.getBoundingClientRect();
                return { box: `${Math.round(r.width)}x${Math.round(r.height)}`, natural: `${v.videoWidth}x${v.videoHeight}`, aspect: v.style.aspectRatio || '(natural)', muted: v.muted, loop: v.loop, controls: v.hasAttribute('controls') };
            });
        }
        const log = await takeLog(app);
        results.localTenorHosts = [...new Set(log.map(hostOf))].sort();
        results.localTenorLinkedRequests = log.filter((l) => LINKED.test(hostOf(l)));
        fs.writeFileSync(path.join(OUT, `localtenor-requests.log`), log.join('\n') + '\n');
    }

    if (PHASES.includes('off')) {
        await takeLog(app);
        const all = [];
        const stubBefore = stubLines().length;
        for (const theme of THEMES) {
            await win.goto(PAGE(`role=receiver&theme=${theme}&layout=expanded&embeds=off`));
            await waitRows(win);
            await sleep(2500);
            await setSize(app, 1366, 768);
            await sleep(600);
            await win.evaluate(() => { document.getElementById('feed').scrollTop = 0; });
            await win.screenshot({ path: path.join(OUT, `embeds-off-${theme}-1366x768@${SCALE}.png`) });
            all.push(...(await takeLog(app)));
        }
        results.offEmbedNodes = await win.evaluate(() => document.querySelectorAll('[data-embed], [data-sender-embed], iframe, video, .cl-pe, .cl-ve, .cl-se').length);
        results.offLinksShown = await win.evaluate(() => document.querySelectorAll('.harness-link').length);
        results.offRequestCount = all.length;
        results.offHosts = [...new Set(all.map(hostOf))].sort();
        results.offLinkedSiteRequests = all.filter((l) => LINKED.test(hostOf(l)));
        results.offNodeRequests = all.filter((l) => l.startsWith('node-'));
        results.offThumbDownloads = stubLines().slice(stubBefore).filter((l) => /download|\/blob\//.test(l)).length;
        fs.writeFileSync(path.join(OUT, `embeds-off-requests.log`), all.join('\n') + '\n');
    }
    results.receiverConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 25);
    results.receiverMainLog = mainLines.slice(-40);
    await app.close();
}

fs.writeFileSync(path.join(OUT, `results-scale${SCALE}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
