// Link embeds phase 4 (Twitch, X, TikTok, Reddit + "Show embeds") in the REAL
// dev Electron (main + preload + CSP + unfurler + clmedia://), two profiles =
// two devices, renderer from this worktree's Vite, API pinned to a loopback stub.
//
//   1. SENDER: the composer builds previews of LIVE provider links through main;
//      the real send path re-encodes + encrypts + uploads pictures to the stub.
//   2. RECEIVER (fresh profile): every request logged in main (Chromium
//      webRequest + Node http/https) from before the page loads; rows drawn at
//      each size / theme / layout; the log is checked for the linked sites.
//   3. EMBEDS OFF: Settings → Privacy → "Show embeds" off: links only, zero
//      linked-site requests AND zero preview-thumbnail downloads (stub log).
//   4. PLAY on purpose: Twitch clip, Twitch VOD, TikTok (the provider's frame),
//      X video, X GIF; what each contacts; whether it actually plays. Then
//      "Show embeds" off mid-playback: the player must disappear.
//
//   LE_PORT=5481 LE_CACHE=<dir> npx vite --config harness/link-embeds.vite.config.ts &   (VITE_API_HOST=127.0.0.1:<stub>)
//   STUB_PORT=13181 STUB_LOG=<file> node harness/sender-embeds-api-stub.mjs &
//   OUT=<dir> STUB_LOG=<file> PHASES=sender,receiver,off,settings,play xvfb-run -a -s "-screen 0 2600x1700x24" node harness/provider-embeds-electron.mjs
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
const PORT = process.env.LE_PORT ?? '5481';
const STUB = process.env.STUB_PORT ?? '13181';
const STUB_LOG = process.env.STUB_LOG;
const SCALE = process.env.SCALE ?? '1';
const SIZES = (process.env.SIZES ?? '1000x720,1366x768').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const LAYOUTS = (process.env.LAYOUTS ?? 'compact,expanded').split(',');
const PHASES = (process.env.PHASES ?? 'sender,receiver,off,settings,play').split(',');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const PAGE = (qs) => `http://127.0.0.1:${PORT}/harness/provider-embeds.html?${qs}`;

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
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'pe-sender-')));
    await setSize(app, 1366, 768);
    for (const theme of THEMES) {
        await win.goto(PAGE(`role=sender&theme=${theme}`));
        await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        const t0 = Date.now();
        await win.waitForFunction(() => document.querySelectorAll('.cl-cep-item').length >= 8 && !document.querySelector('.cl-cep-item[data-status="loading"]'), null, { timeout: 60000 }).catch(() => { results[`senderPreviewTimeout_${theme}`] = true; });
        results[`senderPreviewsReadyMs_${theme}`] = Date.now() - t0;
        await sleep(500);
        await win.screenshot({ path: path.join(OUT, `composer-previews-${theme}-1366x768@${SCALE}.png`) });
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
const LINKED = /(^|\.)(twitch\.tv|jtvnw\.net|twitchcdn\.net|ttvnw\.net|x\.com|twitter\.com|twimg\.com|tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokv\.com|ttwstatic\.com|byteoversea\.com|ibytedtos\.com|reddit\.com|redd\.it|redditmedia\.com|redditstatic\.com|imgur\.com|tenor\.com|example\.com)$/i;
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
        for (let k = 0; k < Math.min(steps, 6); k++) {
            await win.evaluate((k) => { const f = document.getElementById('feed'); f.scrollTop = k * (f.clientHeight - 60); }, k);
            await sleep(250);
            await win.screenshot({ path: path.join(OUT, `${name}-${w}x${h}@${SCALE}-${k + 1}.png`) });
        }
    }
}

if (['receiver', 'off', 'settings', 'play'].some((p) => PHASES.includes(p))) {
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'pe-receiver-')));
    await installRequestLog(app);
    await takeLog(app);

    if (PHASES.includes('receiver')) {
        const all = [];
        for (const layout of LAYOUTS) for (const theme of THEMES) {
            await win.goto(PAGE(`role=receiver&theme=${theme}&layout=${layout}`));
            await waitRows(win);
            await win.waitForFunction(() => document.querySelectorAll('.cl-ve-frame.ready, .cl-pe-cell img, .cl-pe-avatar img').length >= 6, null, { timeout: 30000 }).catch(() => { results[`thumbTimeout_${layout}_${theme}`] = true; });
            await sleep(800);
            await shootFeed(app, win, `receiver-${layout}-${theme}`);
            all.push(...(await takeLog(app)));
        }
        results.receiverRows = await win.evaluate(() => [...document.querySelectorAll('[data-row]')].map((r) => ({
            row: r.getAttribute('data-row'),
            cards: [...r.querySelectorAll('[data-embed]')].map((e) => `${e.getAttribute('data-embed')}${e.getAttribute('data-provider') ? `:${e.getAttribute('data-provider')}` : ''}`),
            titles: [...r.querySelectorAll('.cl-ve-title, .cl-pe-title, .cl-pe-name')].map((t) => t.textContent.slice(0, 60)),
            forgedShown: r.textContent.includes('FORGED'),
        })));
        results.receiverRequestCount = all.length;
        results.receiverHosts = [...new Set(all.map(hostOf))].sort();
        results.receiverLinkedSiteRequests = all.filter((l) => LINKED.test(hostOf(l)));
        results.receiverNodeRequests = all.filter((l) => l.startsWith('node-'));
        fs.writeFileSync(path.join(OUT, `receiver-requests-scale${SCALE}.log`), all.join('\n') + '\n');
    }

    if (PHASES.includes('off')) {
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
        results.offEmbedNodes = await win.evaluate(() => document.querySelectorAll('[data-embed], .cl-cep-item, iframe, video, .cl-pe, .cl-ve, .cl-se').length);
        results.offLinksShown = await win.evaluate(() => document.querySelectorAll('.harness-link').length);
        results.offRequestCount = all.length;
        results.offHosts = [...new Set(all.map(hostOf))].sort();
        results.offLinkedSiteRequests = all.filter((l) => LINKED.test(hostOf(l)));
        results.offNodeRequests = all.filter((l) => l.startsWith('node-'));
        results.offStubRequests = stubLines().slice(stubBefore).map((l) => l.split(' ').slice(1).join(' '));
        results.offThumbDownloads = results.offStubRequests.filter((l) => /download|\/blob\//.test(l)).length;
        fs.writeFileSync(path.join(OUT, `embeds-off-requests.log`), all.join('\n') + '\n');
    }

    if (PHASES.includes('settings')) {
        for (const theme of THEMES) for (const [w, h] of [[1000, 720]]) {
            await win.goto(PAGE(`role=settings&theme=${theme}`));
            await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
            await setSize(app, w, h);
            await sleep(1200);
            await win.evaluate(() => document.querySelector('[data-setting="show-embeds"]')?.scrollIntoView({ block: 'center' }));
            await sleep(400);
            await win.screenshot({ path: path.join(OUT, `settings-show-embeds-${theme}-${w}x${h}@${SCALE}.png`) });
        }
        results.settingsRow = await win.evaluate(() => document.querySelector('[data-setting="show-embeds"]')?.textContent?.trim() ?? null);
        await takeLog(app);
    }

    if (PHASES.includes('play')) {
        await win.goto(PAGE('role=receiver&theme=dark&layout=expanded'));
        await waitRows(win);
        await setSize(app, 1366, 768);
        await sleep(1500);
        await takeLog(app);
        const frameState = async (originPart) => app.evaluate(async ({ BrowserWindow }, originPart) => {
            const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('127.0.0.1'));
            const frames = bw.webContents.mainFrame.framesInSubtree.filter((f) => f.url.includes(originPart));
            const out = [];
            for (const f of frames) {
                try {
                    out.push({ url: f.url.slice(0, 140), state: await f.executeJavaScript(`(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused, w: v.videoWidth, h: v.videoHeight, muted: v.muted, err: v.error && v.error.code } : { noVideo: true, title: document.title.slice(0, 80), body: (document.body && document.body.innerText || '').slice(0, 160) }; })()`) });
                } catch (e) { out.push({ url: f.url.slice(0, 140), error: String(e).slice(0, 120) }); }
            }
            return out;
        }, originPart);
        const playFrame = async (sel, originPart, shot) => {
            await win.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), sel);
            await sleep(300);
            await win.click(`${sel} button.cl-ve-play`);
            await win.waitForSelector(`${sel} iframe`, { timeout: 10000 }).catch(() => {});
            const src = await win.evaluate((sel) => document.querySelector(`${sel} iframe`)?.getAttribute('src') ?? null, sel);
            await sleep(9000);
            const state = await frameState(originPart);
            await win.screenshot({ path: path.join(OUT, shot) });
            const log = await takeLog(app);
            return { src, state, hosts: [...new Set(log.map(hostOf))].sort().slice(0, 40) };
        };
        results.playTwitchClip = await playFrame('[data-row="0"] [data-embed="twitch"]', 'clips.twitch.tv', `play-twitch-clip-dark-1366x768@${SCALE}.png`);
        results.playTwitchVod = await playFrame('[data-row="0"] .cl-sevid:nth-of-type(2) [data-embed="twitch"]', 'player.twitch.tv', `play-twitch-vod-dark-1366x768@${SCALE}.png`);
        results.playTiktok = await playFrame('[data-embed="tiktok"]', 'tiktok.com', `play-tiktok-dark-1366x768@${SCALE}.png`);

        // X video: the sender's mp4 through main (clmedia), only now.
        const playPost = async (sel, shot) => {
            const before = mainLines.length;
            await win.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), sel);
            await sleep(300);
            await win.click(`${sel} button.cl-pe-play`);
            await win.waitForSelector(`${sel} video[src^="clmedia://"]`, { timeout: 20000 }).catch(() => {});
            const st = await win.evaluate(async (sel) => {
                const v = document.querySelector(`${sel} video`);
                if (!v) return { error: document.querySelector(`${sel} .cl-pe-note`)?.textContent ?? 'no video' };
                const t0 = Date.now();
                while (v.currentTime < 0.5 && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
                return { firstFrameMs: Date.now() - t0, playedTo: v.currentTime, w: v.videoWidth, h: v.videoHeight, muted: v.muted, loop: v.loop, err: v.error?.code ?? null };
            }, sel);
            await sleep(600);
            await win.screenshot({ path: path.join(OUT, shot) });
            const log = await takeLog(app);
            return { ...st, hosts: [...new Set(log.map(hostOf))].sort(), clmedia: mainLines.slice(before) };
        };
        results.playXVideo = await playPost('[data-row="2"] [data-embed="post"]', `play-x-video-dark-1366x768@${SCALE}.png`);
        results.playXGif = await playPost('[data-row="3"] [data-embed="post"][data-provider="x"]:has([data-post-media="gif"])', `play-x-gif-dark-1366x768@${SCALE}.png`);

        // Live toggle: a Twitch player playing, then "Show embeds" off.
        await win.evaluate(() => document.querySelector('[data-embed="twitch"]')?.scrollIntoView({ block: 'center' }));
        await win.click('[data-row="0"] [data-embed="twitch"] button.cl-ve-play').catch(() => {});
        await win.waitForSelector('[data-row="0"] iframe', { timeout: 10000 }).catch(() => {});
        const before = await win.evaluate(() => ({ iframes: document.querySelectorAll('iframe').length, embeds: document.querySelectorAll('[data-embed]').length }));
        await win.evaluate(() => window.__setShowEmbeds(false));
        await sleep(800);
        const after = await win.evaluate(() => ({ iframes: document.querySelectorAll('iframe').length, videos: document.querySelectorAll('video').length, embeds: document.querySelectorAll('[data-embed]').length }));
        await win.screenshot({ path: path.join(OUT, `live-toggle-off-dark-1366x768@${SCALE}.png`) });
        const framesLeft = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('127.0.0.1')).webContents.mainFrame.framesInSubtree.length);
        await win.evaluate(() => window.__setShowEmbeds(true));
        await sleep(800);
        const back = await win.evaluate(() => document.querySelectorAll('[data-embed]').length);
        results.liveToggle = { before, after, framesLeftInWindow: framesLeft, embedsBack: back };
    }
    results.receiverConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 25);
    results.receiverMainLog = mainLines.slice(-40);
    await app.close();
}

fs.writeFileSync(path.join(OUT, `results-scale${SCALE}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
