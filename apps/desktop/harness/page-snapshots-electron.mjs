// Page snapshots (2026-11-23) in the REAL dev Electron (main + preload + CSP
// + unfurler + snapshotter + clmedia://), two profiles = two devices, the
// renderer from this worktree's Vite, the API pinned to a loopback stub (the
// page refuses any other API). Pages: harness/page-snapshots-main.tsx.
//
//   1. SENDER: the composer builds previews of LIVE links through main
//      (Google Doc / Drive files public + private, BBC, NPR text, Stack
//      Overflow, example.com, Hacker News, CNN lite); pages with no picture
//      get a snapshot; the real send path re-encodes + encrypts + uploads.
//      Then one message is sent BEFORE its snapshot exists and the shipped
//      late-attach makes the embeds-only edit; a real text edit and a forged
//      "embeds_only" edit that changes the words are added.
//   2. RECEIVER (fresh profile): every request logged in main from before the
//      page loads; the edits applied by the real reader path; rows drawn in
//      both layouts x both themes x 1000x720 / 1366x768. No linked site may
//      be contacted.
//   3. SETTINGS: the Privacy pane's new note.
//
//   LE_PORT=5493 LE_CACHE=<dir> VITE_API_HOST=127.0.0.1:13193 npx vite --config harness/link-embeds.vite.config.ts &
//   STUB_PORT=13193 STUB_LOG=<file> node harness/sender-embeds-api-stub.mjs &
//   OUT=<dir> STUB_LOG=<file> LE_PORT=5493 STUB_PORT=13193 xvfb-run -a -s "-screen 0 2600x1700x24" node harness/page-snapshots-electron.mjs
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
const PORT = process.env.LE_PORT ?? '5493';
const STUB = process.env.STUB_PORT ?? '13193';
const SCALE = process.env.SCALE ?? '1';
const SIZES = (process.env.SIZES ?? '1000x720,1366x768').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const LAYOUTS = (process.env.LAYOUTS ?? 'compact,expanded').split(',');
const PHASES = (process.env.PHASES ?? 'sender,receiver,settings').split(',');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const PAGE = (qs) => `http://127.0.0.1:${PORT}/harness/page-snapshots.html?${qs}`;
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
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sender-')));
    await setSize(app, 1366, 768);
    await win.goto(PAGE('role=sender&theme=dark'));
    await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    const t0 = Date.now();
    await win.waitForFunction(() => document.querySelectorAll('.cl-cep-item').length >= 10 && !document.querySelector('.cl-cep-item[data-status="loading"], .cl-cep-item[data-snapshot="taking"]'), null, { timeout: 120000 }).catch(() => { results.senderPreviewTimeout = true; });
    results.senderPreviewsReadyMs = Date.now() - t0;
    await sleep(500);
    await win.screenshot({ path: path.join(OUT, `composer-previews-dark-1366x768@${SCALE}.png`) });
    results.composerItems = await win.evaluate(() => [...document.querySelectorAll('.cl-cep-item')].map((e) => ({ url: e.getAttribute('title'), status: e.getAttribute('data-status'), snapshot: e.getAttribute('data-snapshot'), text: e.textContent.trim().slice(0, 80), pic: !!e.querySelector('img') })));
    const sent = await win.evaluate(async () => window.__send());
    results.sendMs = sent.map((s) => s.ms);
    const pic = (i) => (i ? { w: i.width, h: i.height, inline: !!i.inline_b64, attachment: !!i.attachment_id, bytes: i.byte_size ?? (i.inline_b64 ? Math.round(i.inline_b64.length * 3 / 4) : undefined) } : undefined);
    results.sentEmbeds = sent.map((s) => (s.content.embeds ?? []).map((e) => ({ url: e.url, kind: e.kind, site: e.site, title: e.title, large: e.image_large, thumb: pic(e.thumb), icon: pic(e.author_icon) })));

    // The fast message: typed, then sent before its snapshot exists.
    await win.evaluate(() => window.__typeFast());
    await sleep(800);
    const tFast = Date.now();
    const fast = await win.evaluate(async () => window.__sendFast());
    results.fast = { late: fast.late, sentWithPicture: fast.sentWithPicture, outcome: fast.outcome, editAfterMs: fast.editAfterMs, totalMs: Date.now() - tFast, edit: fast.edits[0] ? { target: fast.edits[0].target_id, embeds_only: fast.edits[0].embeds_only, text: fast.edits[0].text, picture: pic(fast.edits[0].embeds?.[0]?.thumb) } : null };

    // A real text edit (m3) and a forged "embeds_only" edit that changes the words (m4): both must be marked.
    const m3 = sent[3].content;
    const m4 = sent[4].content;
    const edits = [
        ...(fast.edits[0] ? [fast.edits[0]] : []),
        { type: 'edit', target_id: 'm3', text: `${m3.text} (fixed a typo)`, embeds: m3.embeds },
        { type: 'edit', target_id: 'm4', text: `${m4.text} — changed words`, embeds: m4.embeds, embeds_only: true },
    ];
    await win.evaluate(async (p) => window.__publish(p), { messages: [...sent.map((s) => s.content), fast.content], edits });
    results.senderMainLog = mainLines.slice();
    results.senderConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 20);
    await app.close();
}

// ── request log in main ─────────────────────────────────────────────────────
const LINKED = /(^|\.)(google\.com|googleusercontent\.com|gstatic\.com|googleapis\.com|bbc\.com|bbc\.co\.uk|bbci\.co\.uk|npr\.org|stackoverflow\.com|sstatic\.net|example\.com|ycombinator\.com|cnn\.com|localtest\.me)$/i;
// The app's own UI fonts load from Google Fonts (index.html), not from a linked site.
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

const SHOTS = [
    ['google', '[data-row="0"]'],
    ['drive-zip-private', '[data-row="1"]'],
    ['news', '[data-row="2"]'],
    ['walls', '[data-row="3"]'],
    ['late-attach', '[data-row="5"]'],
];
async function closeUps(app, win, name) {
    for (const [w, h] of SIZES) {
        await setSize(app, w, h);
        await sleep(700);
        for (const [label, sel] of SHOTS) {
            const el = await win.$(sel);
            if (!el) { results[`missing_${label}_${name}`] = true; continue; }
            await el.scrollIntoViewIfNeeded();
            await sleep(250);
            await el.screenshot({ path: path.join(OUT, `${label}-${name}-${w}x${h}@${SCALE}.png`) });
        }
        await win.evaluate(() => { document.getElementById('feed').scrollTop = 0; });
        await sleep(250);
        await win.screenshot({ path: path.join(OUT, `receiver-${name}-${w}x${h}@${SCALE}.png`) });
    }
}

if (PHASES.includes('receiver')) {
    const { app, win, mainLines, consoleLog } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-receiver-')));
    await installRequestLog(app);
    await takeLog(app);
    const all = [];
    for (const layout of LAYOUTS) for (const theme of THEMES) {
        await win.goto(PAGE(`role=receiver&theme=${theme}&layout=${layout}`));
        await waitRows(win);
        await win.waitForFunction(() => document.querySelectorAll('.cl-se-frame').length >= 6, null, { timeout: 30000 }).catch(() => { results[`thumbTimeout_${layout}_${theme}`] = true; });
        await sleep(1500);
        await closeUps(app, win, `${layout}-${theme}`);
        all.push(...(await takeLog(app)));
    }
    results.receiverRows = await win.evaluate(() => [...document.querySelectorAll('[data-row]')].map((r) => ({
        row: r.getAttribute('data-row'), id: r.getAttribute('data-id'), edited: r.getAttribute('data-edited') === 'true', editedMark: !!r.querySelector('[data-edited-mark]'),
        embeds: [...r.querySelectorAll('[data-embed]')].filter((e) => !e.parentElement?.closest('[data-embed]')).map((e) => ({
            style: e.getAttribute('data-embed-style') ?? undefined, shape: e.getAttribute('data-embed-shape') ?? undefined,
            minimal: e.getAttribute('data-embed-minimal') === 'true' || undefined, icon: e.getAttribute('data-embed-icon') ?? undefined,
            title: (e.querySelector('.cl-se-title')?.textContent ?? '').slice(0, 60) || undefined,
            hero: (() => { const h = e.querySelector('.cl-se-hero, .cl-se-thumb'); if (!h) return undefined; const b = h.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}`; })(),
        })),
    })));
    results.receiverRequestCount = all.length;
    results.receiverHosts = [...new Set(all.map(hostOf))].sort();
    results.receiverLinkedSiteRequests = all.filter((l) => LINKED.test(hostOf(l)) && !UI_FONTS.test(hostOf(l)));
    results.receiverNodeRequests = all.filter((l) => l.startsWith('node-'));
    results.receiverSnapshotLines = mainLines.filter((l) => l.startsWith('[snapshot') || l.startsWith('[unfurl'));
    fs.writeFileSync(path.join(OUT, `receiver-requests-scale${SCALE}.log`), all.join('\n') + '\n');
    results.receiverConsoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 25);
    await app.close();
}

if (PHASES.includes('settings')) {
    const { app, win } = await launch(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-settings-')));
    for (const theme of THEMES) {
        await setSize(app, 1000, 720);
        await win.goto(PAGE(`role=settings&theme=${theme}`));
        await win.waitForFunction(() => !!document.querySelector('[data-setting-note="page-snapshots"]'), null, { timeout: 30000 });
        const row = await win.$('[data-setting-note="page-snapshots"]');
        await row.evaluate((e) => e.closest('.sd-row').scrollIntoView({ block: 'center' }));
        await sleep(400);
        const box = await row.evaluate((e) => { const r = e.closest('.sd-row').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
        await win.screenshot({ path: path.join(OUT, `settings-privacy-note-${theme}-1000x720@${SCALE}.png`), clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 60), width: Math.min(1000, box.width + 16), height: box.height + 120 } });
    }
    results.settingsNote = await win.evaluate(() => document.querySelector('[data-setting-note="page-snapshots"]').textContent.replace(/\s+/g, ' ').trim());
    await app.close();
}

for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
fs.writeFileSync(path.join(OUT, `results-scale${SCALE}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
