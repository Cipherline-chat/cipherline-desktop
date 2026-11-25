// Sender-built link embeds (phase 3) in the REAL dev Electron (main + preload +
// CSP + unfurler + clmedia://), two separate profiles = two devices, renderer
// from this worktree's Vite on its own port, API pinned to a loopback stub.
//
//   1. SENDER: the composer builds previews for a news article, a YouTube video,
//      a Medal clip (+ a square page, a no-image page, a wide repo page) through
//      main's unfurler; screenshots of the composer; the real send path
//      re-encodes + encrypts + uploads thumbnails to the stub.
//   2. RECEIVER (fresh profile): every request is logged in main (Chromium:
//      session.webRequest.onBeforeRequest; Node: http/https.request) from
//      before the page loads; the rows are drawn; screenshots at every size,
//      theme and layout; then the request log is checked for the linked sites.
//   3. RECEIVER, on purpose: press play on the Medal clip and the YouTube card,
//      and log what THAT contacts (by design: the media host / the player).
//
//   LE_PORT=5471 LE_CACHE=<dir> npx vite --config harness/link-embeds.vite.config.ts &
//   STUB_PORT=13171 STUB_LOG=<file> node harness/sender-embeds-api-stub.mjs &
//   OUT=<dir> SCALE=1 SIZES=1000x720,1366x768,1920x1080 PHASES=sender,receiver,play \
//     xvfb-run -a -s "-screen 0 2600x1700x24" node harness/sender-embeds-electron.mjs
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
const PORT = process.env.LE_PORT ?? '5471';
const STUB = process.env.STUB_PORT ?? '13171';
const SCALE = process.env.SCALE ?? '1';
const SIZES = (process.env.SIZES ?? '1000x720,1366x768,1920x1080').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const LAYOUTS = (process.env.LAYOUTS ?? 'compact,expanded').split(',');
const PHASES = (process.env.PHASES ?? 'sender,receiver,play').split(',');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

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
    await sleep(3000); // the real app at "/" (sign-in against the stub) settles first
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
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'se-sender-')));
    await setSize(app, 1366, 768);
    for (const theme of THEMES) {
        await win.goto(`http://127.0.0.1:${PORT}/harness/sender-embeds.html?role=sender&theme=${theme}`);
        await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
        const t0 = Date.now();
        await win.waitForFunction(() => document.querySelectorAll('.cl-cep-item').length >= 5 && !document.querySelector('.cl-cep-item[data-status="loading"]'), null, { timeout: 45000 }).catch(() => { results.senderPreviewTimeout = true; });
        results[`senderPreviewsReadyMs_${theme}`] = Date.now() - t0;
        await sleep(400);
        await win.screenshot({ path: path.join(OUT, `composer-previews-${theme}-1366x768@${SCALE}.png`) });
    }
    results.composerItems = await win.evaluate(() => [...document.querySelectorAll('.cl-cep-item')].map((e) => ({ status: e.getAttribute('data-status'), text: e.textContent.trim().slice(0, 90), pic: !!e.querySelector('img') })));
    // × on the Wikipedia preview: it must not be sent (re-added below for the shots, then the real send).
    const sent = await win.evaluate(async () => window.__send());
    results.sendMs = sent.map((s) => s.ms);
    results.sentEmbeds = sent.map((s) => (s.content.embeds ?? []).map((e) => ({ url: e.url, kind: e.kind, title: e.title, site: e.site, tag: e.tag, author: e.author, color: e.color, media: e.media ? { host: new URL(e.media.url).host, mime: e.media.mime, duration_s: e.media.duration_s } : undefined, player: e.player, thumb: e.thumb ? { mime: e.thumb.mime, w: e.thumb.width, h: e.thumb.height, inline: !!e.thumb.inline_b64, inlineBytes: e.thumb.inline_b64 ? Math.round(e.thumb.inline_b64.length * 3 / 4) : undefined, attachment: !!e.thumb.attachment_id, bytes: e.thumb.byte_size } : undefined })));
    results.senderMainLog = mainLines.slice();
    results.senderConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 20);
    await app.close();
}

// ── 2. receiver: request log from before the page loads ─────────────────────
const LINKED = /(^|\.)(arstechnica\.com|arstechnica\.net|youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com|medal\.tv|github\.com|githubassets\.com|githubusercontent\.com|wikipedia\.org|wikimedia\.org|bbc\.com|bbci\.co\.uk|example\.com|phish\.example)$/i;
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

if (PHASES.includes('receiver') || PHASES.includes('play')) {
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'se-receiver-')));
    await installRequestLog(app);
    await takeLog(app); // what the sign-in screen did before this point is not the embeds'
    const allReceiver = [];
    if (PHASES.includes('receiver')) {
        for (const layout of LAYOUTS) for (const theme of THEMES) {
            await win.goto(`http://127.0.0.1:${PORT}/harness/sender-embeds.html?role=receiver&theme=${theme}&layout=${layout}&own=${process.env.OWN ?? '0'}`);
            await win.waitForFunction(() => window.__ready === true && Array.isArray(window.__msgs), null, { timeout: 60000 });
            // every web-card / video thumbnail decrypted (attachment) or decoded (inline)
            await win.waitForFunction(() => document.querySelectorAll('.cl-se-frame, .cl-ve-frame.ready').length >= 5, null, { timeout: 30000 }).catch(() => { results[`thumbTimeout_${layout}_${theme}`] = true; });
            await sleep(700);
            for (const [w, h] of SIZES) {
                await setSize(app, w, h);
                await sleep(600);
                await win.evaluate(() => { document.getElementById('feed').scrollTop = 0; });
                await sleep(150);
                await win.screenshot({ path: path.join(OUT, `receiver-${layout}-${theme}-${w}x${h}@${SCALE}.png`) });
                await win.evaluate(() => { const f = document.getElementById('feed'); f.scrollTop = f.scrollHeight; });
                await sleep(250);
                await win.screenshot({ path: path.join(OUT, `receiver-${layout}-${theme}-${w}x${h}@${SCALE}-bottom.png`) });
            }
            allReceiver.push(...(await takeLog(app)));
        }
        results.receiverRows = await win.evaluate(() => [...document.querySelectorAll('[data-row]')].map((r) => ({
            row: r.getAttribute('data-row'),
            cards: [...r.querySelectorAll('[data-embed]')].map((e) => `${e.getAttribute('data-embed')}${e.getAttribute('data-embed-style') ? `:${e.getAttribute('data-embed-style')}` : ''}`),
            titles: [...r.querySelectorAll('.cl-se-title, .cl-ve-title')].map((t) => t.textContent.slice(0, 60)),
            forgedShown: r.textContent.includes('FORGED'),
        })));
        results.receiverRequestCount = allReceiver.length;
        results.receiverHosts = [...new Set(allReceiver.map(hostOf))].sort();
        results.receiverLinkedSiteRequests = allReceiver.filter((l) => LINKED.test(hostOf(l)));
        results.receiverNodeRequests = allReceiver.filter((l) => l.startsWith('node-'));
        results.receiverMainLog = mainLines.slice();
        fs.writeFileSync(path.join(OUT, `receiver-requests-scale${SCALE}.log`), allReceiver.join('\n') + '\n');
    }

    // ── own message: "Remove embed" shows on hover ────────────────────────────
    if (PHASES.includes('play')) {
        await win.goto(`http://127.0.0.1:${PORT}/harness/sender-embeds.html?role=receiver&theme=dark&layout=expanded&own=1`);
        await win.waitForFunction(() => window.__ready === true && Array.isArray(window.__msgs), null, { timeout: 60000 });
        await setSize(app, 1366, 768);
        await sleep(1200);
        await win.hover('[data-embed="web"]');
        await sleep(300);
        results.removeButtons = await win.evaluate(() => document.querySelectorAll('button[aria-label="Remove embed"]').length);
        await win.screenshot({ path: path.join(OUT, `receiver-own-remove-embed-dark-1366x768@${SCALE}.png`) });
    }

    // ── 3. play on purpose ───────────────────────────────────────────────────
    if (PHASES.includes('play')) {
        await win.goto(`http://127.0.0.1:${PORT}/harness/sender-embeds.html?role=receiver&theme=dark&layout=expanded`);
        await win.waitForFunction(() => window.__ready === true && Array.isArray(window.__msgs), null, { timeout: 60000 });
        await setSize(app, 1366, 768);
        await sleep(1500);
        await takeLog(app);
        const before = mainLines.length;
        await win.evaluate(() => document.querySelector('[data-embed="clip"]')?.scrollIntoView({ block: 'center' }));
        await win.click('[data-embed="clip"] button.cl-ve-play');
        await win.waitForSelector('[data-embed="clip"] video[src^="clmedia://media/"], [data-embed="clip"] .cl-ve-error', { timeout: 20000 }).catch(() => {});
        results.medalPlay = await win.evaluate(async () => {
            const v = document.querySelector('[data-embed="clip"] video');
            if (!v) return { error: document.querySelector('[data-embed="clip"] .cl-ve-error')?.textContent ?? 'no video' };
            const t0 = Date.now();
            while (v.currentTime < 0.5 && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
            return { firstFrameMs: Date.now() - t0, playedTo: v.currentTime, duration: v.duration, w: v.videoWidth, h: v.videoHeight, error: v.error?.code ?? null };
        });
        await sleep(800);
        await win.screenshot({ path: path.join(OUT, `receiver-medal-playing-dark-1366x768@${SCALE}.png`) });
        const medalLog = await takeLog(app);
        results.medalPlayHosts = [...new Set(medalLog.map(hostOf))].sort();
        results.medalPlayPageFetched = medalLog.some((l) => /\/\/(www\.)?medal\.tv\//.test(l));
        results.medalClmedia = mainLines.slice(before);

        await win.evaluate(() => document.querySelector('[data-embed="youtube"]')?.scrollIntoView({ block: 'center' }));
        await win.click('[data-embed="youtube"] button.cl-ve-play');
        await win.waitForSelector('[data-embed="youtube"] iframe', { timeout: 10000 }).catch(() => {});
        await sleep(6000);
        await win.screenshot({ path: path.join(OUT, `receiver-youtube-playing-dark-1366x768@${SCALE}.png`) });
        const ytLog = await takeLog(app);
        results.youtubePlayHosts = [...new Set(ytLog.map(hostOf))].sort();
        results.youtubeIframeSrc = await win.evaluate(() => document.querySelector('[data-embed="youtube"] iframe')?.getAttribute('src')?.replace(/origin=[^&]*/, 'origin=…') ?? null);
    }
    results.receiverConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 20);
    await app.close();
}

fs.writeFileSync(path.join(OUT, `results-scale${SCALE}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
