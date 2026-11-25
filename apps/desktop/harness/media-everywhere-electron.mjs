// "Media everywhere" (2026-11-24, embeds-media-everywhere) in the REAL dev
// Electron (main + preload + CSP + unfurler + media probe + embed:media-copy +
// clmedia://), two profiles = two devices, the renderer from this worktree's
// Vite, the API pinned to a loopback stub. Pages: harness/media-everywhere-main.tsx.
//
//   1. SENDER: previews of LIVE links built through main (a real Discord CDN
//      GIF with signed params → copied; KLIPY page; Tenor; Giphy; an
//      extensionless image; a direct mp4; an animated WebP; an expired Discord
//      attachment; a 404 .gif). The real send path encrypts + uploads pictures
//      and the copy to the stub.
//   2. RECEIVER (fresh profile): every request logged in main from before the
//      page loads; rows drawn in Compact / Expanded x dark / light at 1366x768;
//      per link: what it rendered, whether its link text is visible, its box.
//
//   LE_PORT=5541 LE_CACHE=<dir> VITE_API_HOST=127.0.0.1:13241 npx vite --config harness/link-embeds.vite.config.ts &
//   STUB_PORT=13241 STUB_LOG=<file> node harness/sender-embeds-api-stub.mjs &
//   OUT=<dir> LE_PORT=5541 STUB_PORT=13241 xvfb-run -a -s "-screen 0 2000x1400x24" node harness/media-everywhere-electron.mjs
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
const PORT = process.env.LE_PORT ?? '5541';
const STUB = process.env.STUB_PORT ?? '13241';
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const LAYOUTS = (process.env.LAYOUTS ?? 'compact,expanded').split(',');
const PHASES = (process.env.PHASES ?? 'sender,receiver').split(',');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const PAGE = (qs) => `http://127.0.0.1:${PORT}/harness/media-everywhere.html?${qs}`;
const profiles = [];

async function launch(profile) {
    profiles.push(profile);
    const app = await _electron.launch({
        executablePath: path.join(APP, 'node_modules/electron/dist/electron'),
        args: [APP, '--no-sandbox', `--user-data-dir=${profile}`, '--password-store=basic', '--force-device-scale-factor=1'],
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

if (PHASES.includes('sender')) {
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'mev-sender-')));
    await setSize(app, 1366, 768);
    await win.goto(PAGE('role=sender&theme=dark'));
    await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    const t0 = Date.now();
    await win.waitForFunction(() => document.querySelectorAll('.cl-cep-item').length >= 9 && !document.querySelector('.cl-cep-item[data-status="loading"], .cl-cep-item[data-snapshot="taking"]'), null, { timeout: 150000 }).catch(() => { results.senderPreviewTimeout = true; });
    results.senderPreviewsReadyMs = Date.now() - t0;
    await sleep(500);
    await win.screenshot({ path: path.join(OUT, 'composer-previews-dark-1366x768.png') });
    results.chain = await win.evaluate(() => window.__chain);
    const sent = await win.evaluate(async () => window.__send());
    results.send = sent.map((s) => ({ ms: s.ms, late: s.late, outcome: s.outcome }));
    const brief = (e) => ({ url: e.url.slice(0, 70), kind: e.kind, site: e.site, title: e.title?.slice(0, 40), media: e.media ? { host: new URL(e.media.url).host, mime: e.media.mime, w: e.media.width, h: e.media.height, d: e.media.duration_s, loop: e.media.loop, animated: e.media.animated, copy: e.media.file ? e.media.file.byte_size : undefined } : undefined, thumb: e.thumb ? { w: e.thumb.width, h: e.thumb.height, designed: !!e.thumb.designed } : undefined });
    results.sentEmbeds = sent.map((s) => (s.content.embeds ?? []).map(brief));
    results.lateEdits = sent.filter((s) => s.edit).map((s) => (s.edit.embeds ?? []).map(brief));
    const legacy = await win.evaluate(async () => window.__legacy());
    await win.evaluate(async (p) => window.__publish(p), { messages: [...sent.map((s) => s.content), ...legacy.messages], edits: sent.filter((s) => s.edit).map((s) => s.edit) });
    results.senderMainLog = mainLines.slice(0, 40);
    results.senderConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 20);
    await app.close();
}

// Linked sites of the test links (the receiver must contact none of them except under the GIF rule).
const LINKED = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|klipy\.com|tenor\.com|giphy\.com|gravatar\.com|mozilla\.net|mathiasbynens\.be)$/i;
const GIF_MEDIA = /^(media\d*\.giphy\.com|i\.giphy\.com|media\d*\.tenor\.com)$/i;
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
const hostOf = (line) => { try { return new URL(line.split(' ').pop()).hostname; } catch { return ''; } };

if (PHASES.includes('receiver')) {
    const { app, win, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'mev-receiver-')));
    await installRequestLog(app);
    await takeLog(app);
    await setSize(app, 1366, 768);
    results.receiver = {};
    const perLink = {};
    const all = [];
    for (const layout of LAYOUTS) for (const theme of THEMES) {
        await win.goto(PAGE(`role=receiver&theme=${theme}&layout=${layout}`));
        await win.waitForFunction(() => window.__ready === true && Array.isArray(window.__msgs) && document.querySelectorAll('[data-row]').length === window.__msgs.length, null, { timeout: 60000 });
        await sleep(4000);
        const rows = await win.evaluate(() => [...document.querySelectorAll('[data-row]')].map((r) => {
            const link = r.querySelector('[data-link]');
            const text = r.querySelector('[data-text]');
            const tb = text?.getBoundingClientRect();
            const row = r.querySelector('.cl-embed-row');
            const rb = row?.getBoundingClientRect();
            const media = row?.querySelector('[data-embed-rendered="media"] img, [data-embed-rendered="media"] video, [data-embed-rendered="media"] canvas');
            const mb = media?.getBoundingClientRect();
            return {
                row: r.getAttribute('data-row'), link: link?.getAttribute('data-link')?.slice(0, 80), from: link?.getAttribute('data-from'), kind: link?.getAttribute('data-kind'),
                copyAttached: link?.getAttribute('data-copy-attached'),
                textVisible: !!tb && tb.height > 0 && getComputedStyle(text).display !== 'none' && !!text.closest('.cl-msg-col') && getComputedStyle(text.closest('.cl-bare-media-text') ?? text).display !== 'none',
                rendered: !!row?.querySelector('[data-embed-rendered="media"]'),
                fallbackCard: !!row?.querySelector('[data-embed-fallback]'),
                embed: row?.querySelector('[data-embed], [data-sender-embed]')?.getAttribute('data-embed') ?? row?.querySelector('[data-sender-embed]')?.getAttribute('data-sender-embed') ?? null,
                embedRowHeight: rb ? Math.round(rb.height) : 0,
                rowHeight: Math.round(r.getBoundingClientRect().height),
                mediaBox: mb ? `${Math.round(mb.width)}x${Math.round(mb.height)}` : null,
            };
        }));
        results.receiver[`${layout}-${theme}`] = rows;
        // Invariant check in the page: every row has visible text or a rendered picture, and is never an empty row.
        for (const r of rows) {
            const bad = !(r.textVisible || r.rendered) || (!r.textVisible && r.embedRowHeight < 20) || r.rowHeight < 30;
            perLink[`${layout}-${theme} row${r.row}`] = bad ? 'VIOLATION' : 'ok';
        }
        const n = rows.length;
        for (let i = 0; i < n; i++) {
            const el = await win.$(`[data-row="${i}"]`);
            await el.scrollIntoViewIfNeeded();
            await sleep(250);
            await el.screenshot({ path: path.join(OUT, `row${String(i).padStart(2, '0')}-${layout}-${theme}-1366x768.png`) });
        }
        await win.evaluate(() => { document.getElementById('feed').scrollTop = 0; });
        for (let page = 1; page <= 8; page++) {
            await sleep(300);
            await win.screenshot({ path: path.join(OUT, `receiver-${layout}-${theme}-1366x768-${page}.png`) });
            const more = await win.evaluate(() => { const f = document.getElementById('feed'); const b = f.scrollTop; f.scrollTop += f.clientHeight - 40; return f.scrollTop > b; });
            if (!more) break;
        }
        all.push(...(await takeLog(app)));
    }
    results.invariant = perLink;
    results.violations = Object.entries(perLink).filter(([, v]) => v !== 'ok').map(([k]) => k);
    results.receiverRequestCount = all.length;
    results.receiverHosts = [...new Set(all.map(hostOf))].sort();
    results.receiverLinkedSiteRequests = all.filter((l) => LINKED.test(hostOf(l)));
    results.receiverGifMediaRequests = all.filter((l) => GIF_MEDIA.test(hostOf(l))).length;
    fs.writeFileSync(path.join(OUT, 'receiver-requests.log'), all.map((l) => l.replace(/token=[^&\s]+/g, 'token=REDACTED')).join('\n') + '\n');
    results.receiverConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 25);
    await app.close();
}

for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
