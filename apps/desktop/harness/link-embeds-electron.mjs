// Link embeds in the REAL dev Electron (main + preload + CSP + clmedia://),
// renderer from this worktree's Vite on its own port, API pinned to a loopback
// stub. Proves the click-to-play flows, Range streaming and the refusals, and
// takes the window-size screenshots.
//
//   LE_PORT=5463 npx vite --config harness/link-embeds.vite.config.ts &
//   STUB_PORT=13163 node harness/link-embeds-api-stub.mjs &
//   OUT=<dir> PROFILE=<dir> SCALE=1 SIZES=1000x720,1366x768,1920x1080 VERIFY=1 \
//     xvfb-run -a -s "-screen 0 2600x1700x24" node harness/link-embeds-electron.mjs
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
const PROFILE = process.env.PROFILE;
const PORT = process.env.LE_PORT ?? '5463';
const STUB = process.env.STUB_PORT ?? '13163';
const SCALE = process.env.SCALE ?? '1';
const SIZES = (process.env.SIZES ?? '1000x720,1366x768,1920x1080').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const LAYOUTS = (process.env.LAYOUTS ?? 'expanded,compact').split(',');
const VERIFY = process.env.VERIFY === '1';
fs.mkdirSync(OUT, { recursive: true });
const results = {};
const mainLog = [];
const consoleLog = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron'),
    args: [APP, '--no-sandbox', `--user-data-dir=${PROFILE}`, '--password-store=basic', `--force-device-scale-factor=${SCALE}`, '--autoplay-policy=no-user-gesture-required'],
    cwd: APP,
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${PORT}`, VITE_API_HOST: `127.0.0.1:${STUB}`, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 120000,
});
const mainRaw = fs.createWriteStream(path.join(OUT, `main-scale${SCALE}.log`));
const onMain = (d) => { mainRaw.write(d); for (const l of String(d).split('\n')) if (l.includes('[clmedia]')) mainLog.push(l.replace(/^.*\[clmedia\]/, '[clmedia]').trim()); };
app.process().stdout.on('data', onMain);
app.process().stderr.on('data', onMain);

// No system keyring under Xvfb: SecureStore puts up a modal "Encryption at
// rest disabled" dialog before the main window exists (see harness/fwh/launch.sh).
const answerKeyringDialog = () => {
    try {
        const id = execFileSync('xdotool', ['search', '--name', 'Encryption at rest disabled'], { encoding: 'utf8' }).trim().split('\n')[0];
        if (id) { execFileSync('xdotool', ['windowfocus', '--sync', id]); execFileSync('xdotool', ['key', '--window', id, 'Return']); results.keyringDialogAnswered = true; }
    } catch { /* not up yet */ }
};
let win = null;
for (let i = 0; i < 240 && !win; i++) {
    win = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${PORT}`)) ?? null;
    if (!win) { answerKeyringDialog(); await sleep(500); }
}
if (!win) { console.log('no main window', app.windows().map((w) => w.url())); await app.close(); process.exit(1); }
win.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text().slice(0, 300)}`));

const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('127.0.0.1')) ?? BrowserWindow.getAllWindows()[0];
    if (bw.isMaximized()) bw.unmaximize();
    bw.setContentSize(w, h);
    return bw.getContentSize();
}, [w, h]);
const gestureJs = (code) => app.evaluate(({ BrowserWindow }, code) => {
    const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/harness/')) ?? BrowserWindow.getAllWindows()[0];
    return bw.webContents.executeJavaScript(code, true);
}, code);

async function openHarness(theme, layout = 'expanded') {
    await win.goto(`http://127.0.0.1:${PORT}/harness/link-embeds.html?theme=${theme}&layout=${layout}`);
    await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    // Two YouTube facades with their thumbnails, the GIF and the image.
    await win.waitForFunction(() => document.querySelectorAll('img.cl-ve-frame.ready').length >= 2, null, { timeout: 45000 }).catch(() => { results.thumbTimeout = true; });
    await win.waitForFunction(() => [...document.querySelectorAll('.img-link-wrap img, .img-link-wrap canvas')].length >= 2, null, { timeout: 45000 }).catch(() => { results.imageTimeout = true; });
    await win.waitForFunction(() => !!document.querySelector('[data-embed="gif-loop"] video'), null, { timeout: 45000 }).catch(() => { results.loopTimeout = true; });
    await sleep(800);
}
const shot = async (name) => { await win.screenshot({ path: path.join(OUT, `${name}.png`) }); return name; };
const scrollTo = (sel) => win.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), sel);

// The first window loads the real app at "/" (sign-in, API stub); the harness page is the same origin.
await sleep(4000);

/** Round 3: light mode must have no border lines on any embed (port of the concept's check). */
const noOutlines = () => win.evaluate(() => [...document.querySelectorAll('.cl-embed-row *')].filter((e) => {
    const st = getComputedStyle(e);
    return ['Top', 'Right', 'Bottom', 'Left'].some((k) => parseFloat(st[`border${k}Width`]) > 0 && st[`border${k}Style`] !== 'none' && !/rgba\(.*, 0\)$/.test(st[`border${k}Color`]))
        && !e.matches('.cl-ve-play, .cl-ve-play *, .cl-ve-spin');
}).map((e) => `${e.tagName}.${String(e.className).slice(0, 60)}`).slice(0, 8));

for (const layout of LAYOUTS) {
    for (const theme of THEMES) {
        await openHarness(theme, layout);
        results[`ytTitle_${layout}_${theme}`] = await win.evaluate(() => document.querySelector('[data-embed="youtube"] .cl-ve-title')?.textContent ?? null);
        results[`layoutApplied_${layout}_${theme}`] = await win.evaluate(() => document.querySelector('[data-embed="youtube"]')?.getAttribute('data-layout'));
        // Light must find none; dark (which keeps its hairline) is the check's positive control.
        results[`${theme}Outlines_${layout}`] = await noOutlines();
        for (const [w, h] of SIZES) {
            await setSize(w, h);
            await sleep(700);
            await win.evaluate(() => { document.getElementById('feed').scrollTop = 0; });
            await shot(`${layout}-${theme}-${w}x${h}@${SCALE}`);
            await win.evaluate(() => { const f = document.getElementById('feed'); f.scrollTop = f.scrollHeight; });
            await sleep(300);
            await shot(`${layout}-${theme}-${w}x${h}@${SCALE}-bottom`);
        }
    }
}

if (process.env.FSPROBE === '1') {
    // Real OS fullscreen from a video's (and YouTube's) HTML fullscreen request,
    // and an exact return to the previous window state (windowed or maximized).
    const winState = () => app.evaluate(({ BrowserWindow, screen }) => {
        const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/harness/')) ?? BrowserWindow.getAllWindows()[0];
        return { bounds: bw.getBounds(), full: bw.isFullScreen(), max: bw.isMaximized(), display: screen.getDisplayMatching(bw.getBounds()).bounds };
    });
    const page = () => win.evaluate(() => ({ inner: [innerWidth, innerHeight], fsEl: document.fullscreenElement?.tagName ?? null, osFull: matchMedia('(display-mode: fullscreen)').matches }));
    const escKey = () => app.evaluate(({ BrowserWindow }) => {
        const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/harness/')) ?? BrowserWindow.getAllWindows()[0];
        bw.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        bw.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    });
    const R = (results.fs = {});
    await openHarness('dark');
    await setSize(1366, 768);
    await scrollTo('[data-embed="video"]');
    await win.click('[data-embed="video"] button.cl-ve-play');
    await win.waitForSelector('[data-embed="video"] video[src^="clmedia://media/"]', { timeout: 15000 });
    await sleep(1500);
    await app.evaluate(({ BrowserWindow }) => {
        const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/harness/'));
        globalThis.__fsEvents = [];
        for (const ev of ['enter-full-screen', 'leave-full-screen', 'enter-html-full-screen', 'leave-html-full-screen', 'resize', 'maximize', 'unmaximize']) {
            bw.on(ev, () => globalThis.__fsEvents.push(`${ev} full=${bw.isFullScreen()} max=${bw.isMaximized()} ${JSON.stringify(bw.getBounds())}`));
        }
    });
    const enterVideo = `(async () => { try { await document.querySelector('[data-embed="video"] video').requestFullscreen(); return 'ok'; } catch (e) { return 'err: ' + e.message; } })()`;
    for (const mode of ['windowed', 'maximized']) {
        if (mode === 'maximized') {
            await app.evaluate(({ BrowserWindow }) => { const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/harness/')); bw.maximize(); });
            await sleep(1200);
        }
        for (const exit of ['escape', 'api']) {
            const before = await winState();
            const req = await gestureJs(enterVideo);
            await sleep(1800);
            const during = { ...(await winState()), ...(await page()) };
            await shot(`fs-video-${mode}-${exit}-during`);
            try { execFileSync('import', ['-window', 'root', path.join(OUT, `fs-video-${mode}-${exit}-during-SCREEN.png`)]); } catch { /* optional */ }
            if (exit === 'escape') await escKey(); else await gestureJs('document.exitFullscreen().then(() => "ok", (e) => "err " + e.message)');
            await sleep(1800);
            const after = { ...(await winState()), ...(await page()) };
            R[`events_${mode}_${exit}`] = await app.evaluate(() => globalThis.__fsEvents.splice(0));
            R[`video_${mode}_${exit}`] = { req, before, during, after, restored: JSON.stringify(before.bounds) === JSON.stringify(after.bounds) && before.max === after.max && !after.full };
        }
    }
    // YouTube's own fullscreen (its iframe asks; same window handling).
    await app.evaluate(({ BrowserWindow }) => { const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/harness/')); if (bw.isMaximized()) bw.unmaximize(); });
    await sleep(1200);
    await setSize(1366, 768);
    await scrollTo('[data-embed="youtube"]');
    await win.click('[data-embed="youtube"] button.cl-ve-play');
    await win.waitForSelector('[data-embed="youtube"] iframe', { timeout: 10000 });
    await sleep(6000);
    const before = await winState();
    R.ytReq = await app.evaluate(async ({ BrowserWindow }) => {
        const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/harness/'));
        const f = bw.webContents.mainFrame.framesInSubtree.find((fr) => fr.url.includes('youtube-nocookie.com/embed/'));
        if (!f) return 'no frame';
        return await f.executeJavaScript(`(async () => { try { await (document.querySelector('#movie_player') || document.documentElement).requestFullscreen(); return 'ok'; } catch (e) { return 'err: ' + e.message; } })()`, true);
    });
    await sleep(1800);
    const during = { ...(await winState()), ...(await page()) };
    await shot('fs-youtube-windowed-during');
    try { execFileSync('import', ['-window', 'root', path.join(OUT, 'fs-youtube-windowed-during-SCREEN.png')]); } catch { /* optional */ }
    await escKey();
    await sleep(1800);
    const after = { ...(await winState()), ...(await page()) };
    R.youtube_windowed_escape = { before, during, after, restored: JSON.stringify(before.bounds) === JSON.stringify(after.bounds) && !after.full };
}

if (process.env.YTPROBE === '1') {
    // Is "This video is unavailable" ours or this box's? Same attributes, three srcs.
    await openHarness('dark');
    await setSize(1366, 768);
    const o = encodeURIComponent(`http://127.0.0.1:${PORT}`);
    const srcs = [
        `https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?origin=${o}`,
        `https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&origin=${o}&start=42`,
        `https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?autoplay=1&origin=${o}`,
    ];
    await win.evaluate((srcs) => {
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;display:flex;gap:8px;padding:8px;flex-wrap:wrap';
        for (const s of srcs) {
            const f = document.createElement('iframe');
            f.src = s; f.width = '440'; f.height = '248';
            f.referrerPolicy = 'strict-origin-when-cross-origin';
            f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
            f.allowFullscreen = true;
            box.appendChild(f);
        }
        document.body.appendChild(box);
    }, srcs);
    await sleep(15000);
    results.ytprobe = [];
    for (const f of win.frames().filter((fr) => fr.url().includes('youtube-nocookie.com/embed/'))) {
        results.ytprobe.push({ url: f.url().replace(/origin=[^&]*/, 'origin=…'), state: await f.evaluate(() => { const v = document.querySelector('video'); return { text: document.body.innerText.slice(0, 120), t: v?.currentTime ?? null, paused: v?.paused ?? null }; }).catch((e) => String(e).slice(0, 100)) });
    }
    await shot('ytprobe');
}

if (VERIFY) {
    await openHarness('dark', 'expanded');
    await setSize(1366, 768);
    await sleep(500);
    const R = (results.verify = {});

    const boxOf = (sel) => win.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }, sel);
    // 1. YouTube: keyboard (Enter on the focused facade) mounts the player.
    await scrollTo('[data-embed="youtube"]');
    R.ytBoxIdle = await boxOf('[data-embed="youtube"]');
    await win.focus('[data-embed="youtube"] button.cl-ve-play');
    await win.keyboard.press('Enter');
    await win.waitForSelector('[data-embed="youtube"] iframe', { timeout: 10000 });
    R.ytSrc = await win.getAttribute('[data-embed="youtube"] iframe', 'src');
    let ytState = null;
    for (let i = 0; i < 30; i++) {
        const f = win.frames().find((fr) => fr.url().includes('youtube-nocookie.com/embed/'));
        if (f) ytState = await f.evaluate(() => { const v = document.querySelector('video'); return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState } : { noVideo: document.body?.innerText?.slice(0, 160) }; }).catch((e) => ({ err: String(e).slice(0, 120) }));
        if (ytState && ytState.t > 0.5) break;
        await sleep(1000);
    }
    R.ytPlayback = ytState;
    R.ytBoxPlaying = await boxOf('[data-embed="youtube"]');
    await shot('verify-youtube-playing-dark-1366x768@' + SCALE);

    // 2. Direct mp4: click → clmedia stream plays; YouTube goes back to its facade.
    await scrollTo('[data-embed="video"]');
    const before = mainLog.length;
    await win.click('[data-embed="video"] button.cl-ve-play');
    await win.waitForSelector('[data-embed="video"] video[src^="clmedia://media/"]', { timeout: 15000 });
    R.directSrc = await win.getAttribute('[data-embed="video"] video', 'src');
    R.direct = await win.evaluate(async () => {
        const v = document.querySelector('[data-embed="video"] video');
        const t0 = Date.now();
        while (v.currentTime < 1 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
        const playedTo = v.currentTime;
        v.currentTime = Math.max(0, v.duration - 1.5);
        await new Promise((r) => { v.onseeked = r; setTimeout(r, 8000); });
        return { playedTo, duration: v.duration, afterSeek: v.currentTime, w: v.videoWidth, h: v.videoHeight, error: v.error?.code ?? null };
    });
    R.youtubeBackToFacade = await win.evaluate(() => !document.querySelector('[data-embed="youtube"] iframe') && !!document.querySelector('[data-embed="youtube"] button.cl-ve-play'));
    R.directLog = mainLog.slice(before);
    await shot('verify-mp4-playing-dark-1366x768@' + SCALE);

    // 3. Medal clip page: resolved on click, plays, seeks mid-file with a Range request.
    await scrollTo('[data-embed="clip"]');
    R.medalBoxIdle = await boxOf('[data-embed="clip"]');
    const beforeMedal = mainLog.length;
    const t0 = Date.now();
    await win.click('[data-embed="clip"] button.cl-ve-play');
    await win.waitForSelector('[data-embed="clip"] video[src^="clmedia://media/"], [data-embed="clip"] .cl-ve-error', { timeout: 20000 });
    R.medalError = await win.evaluate(() => document.querySelector('[data-embed="clip"] .cl-ve-error')?.textContent ?? null);
    if (!R.medalError) {
        R.medal = await win.evaluate(async () => {
            const v = document.querySelector('[data-embed="clip"] video');
            const t0 = Date.now();
            while (v.currentTime < 0.5 && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
            const firstFrameMs = Date.now() - t0;
            const playedTo = v.currentTime;
            const target = v.duration * 0.6;
            const s0 = Date.now();
            v.currentTime = target;
            await new Promise((r) => { v.onseeked = r; setTimeout(r, 15000); });
            const t1 = Date.now();
            while (v.readyState < 3 && Date.now() - t1 < 15000) await new Promise((r) => setTimeout(r, 100));
            return { firstFrameMs, playedTo, duration: v.duration, target, afterSeek: v.currentTime, seekMs: Date.now() - s0, ready: v.readyState, w: v.videoWidth, h: v.videoHeight, error: v.error?.code ?? null, paused: v.paused };
        });
        R.medalClickToPlayMs = Date.now() - t0;
        R.directPausedByMedal = await win.evaluate(() => document.querySelector('[data-embed="video"] video')?.paused ?? null);
    }
    R.medalLog = mainLog.slice(beforeMedal);
    R.medalBoxPlaying = await boxOf('[data-embed="clip"]');

    // 4b. GIF-like loop (Tenor): auto-loaded, muted loop, follows window focus; frozen tag on blur.
    await scrollTo('[data-embed="gif-loop"]');
    R.loop = await win.evaluate(async () => {
        const v = document.querySelector('[data-embed="gif-loop"] video');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const t0 = v.currentTime; await wait(1500);
        const advancing = v.currentTime !== t0 && !v.paused;
        const box = v.getBoundingClientRect();
        window.dispatchEvent(new Event('blur'));
        await wait(600);
        const pausedOnBlur = v.paused;
        const tag = !!document.querySelector('[data-embed="gif-loop"] .gif-frozen-tag');
        const linkGifTag = !!document.querySelector('.img-link-wrap .gif-frozen-tag');
        return { src: v.getAttribute('src').slice(0, 16), muted: v.muted, loop: v.loop, controls: v.hasAttribute('controls'), advancing, pausedOnBlur, tag, linkGifTag, size: `${Math.round(box.width)}x${Math.round(box.height)}` };
    });
    await shot('verify-gif-frozen-dark-1366x768@' + SCALE);
    R.loopResumed = await win.evaluate(async () => { window.dispatchEvent(new Event('focus')); await new Promise((r) => setTimeout(r, 800)); const v = document.querySelector('[data-embed="gif-loop"] video'); return { playing: !v.paused, tag: !!document.querySelector('.gif-frozen-tag') }; });
    await sleep(1500);
    await shot('verify-medal-playing-dark-1366x768@' + SCALE);

    // 4. Fullscreen and picture-in-picture from the inline player (user-gesture JS via main).
    R.fullscreen = await gestureJs(`(async () => { const v = document.querySelector('[data-embed="clip"] video') || document.querySelector('[data-embed="video"] video'); try { await v.requestFullscreen(); await new Promise(r => setTimeout(r, 800)); const ok = document.fullscreenElement === v; await document.exitFullscreen(); return ok ? 'ok' : 'not-fullscreen'; } catch (e) { return 'err: ' + e.message; } })()`);
    R.pip = await gestureJs(`(async () => { const v = document.querySelector('[data-embed="clip"] video') || document.querySelector('[data-embed="video"] video'); try { await v.requestPictureInPicture(); const ok = document.pictureInPictureElement === v; await document.exitPictureInPicture(); return ok ? 'ok' : 'not-pip'; } catch (e) { return 'err: ' + e.message; } })()`);

    // 5. Image → lightbox with Open original + Save; GIF animates (GifPlayer shows the <img>, not the frozen canvas).
    await scrollTo('.img-link-wrap');
    R.gif = await win.evaluate(() => { const w = [...document.querySelectorAll('.img-link-wrap')][0]; const img = w?.querySelector('img'); return img ? { src: img.src.slice(0, 5), shown: getComputedStyle(img).display !== 'none', w: img.naturalWidth } : null; });
    const imgs = await win.$$('.img-link-wrap img');
    await imgs[imgs.length - 1].click();
    await win.waitForSelector('button[aria-label="Open original"]', { timeout: 5000 });
    R.lightbox = await win.evaluate(() => ({ open: !!document.querySelector('button[aria-label="Open original"]'), save: !!document.querySelector('button[aria-label="Save image"]') }));
    await sleep(500);
    await shot('verify-lightbox-dark-1366x768@' + SCALE);
    await win.keyboard.press('Escape');
    await sleep(600);

    // 6. Refusals, in the real renderer + main.
    const beforeNeg = mainLog.length;
    R.unregistered = await win.evaluate(() => new Promise((res) => {
        const v = document.createElement('video');
        v.onerror = () => res(`error ${v.error?.code}`);
        v.oncanplay = () => res('PLAYED (bad)');
        v.src = `clmedia://media/${'a'.repeat(32)}`;
        setTimeout(() => res('timeout'), 8000);
    }));
    R.privateIp = await win.evaluate(async () => {
        const r = await window.electronAPI.registerMedia('https://127.0.0.1/clip.mp4', 'video');
        if (!r.ok) return 'register refused';
        return await new Promise((res) => {
            const v = document.createElement('video');
            v.onerror = () => res(`registered; stream error ${v.error?.code}`);
            v.oncanplay = () => res('PLAYED (bad)');
            v.src = r.src;
            setTimeout(() => res('timeout'), 8000);
        });
    });
    R.fetchClmedia = await win.evaluate(async () => { try { await fetch(`clmedia://media/${'a'.repeat(32)}`); return 'fetched (bad)'; } catch (e) { return `rejected: ${String(e).slice(0, 80)}`; } });
    R.cspDirectRemote = await win.evaluate(() => new Promise((res) => {
        const v = document.createElement('video');
        v.onerror = () => res(`error ${v.error?.code}`);
        v.oncanplay = () => res('PLAYED (bad: media-src open)');
        v.src = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
        setTimeout(() => res('timeout'), 8000);
    }));
    R.negLog = mainLog.slice(beforeNeg);
    R.cspConsole = consoleLog.filter((l) => /Content Security Policy|Refused to load/i.test(l)).slice(-5);

    // 7. A playing shot in light too.
    await openHarness('light', 'expanded');
    await setSize(1366, 768);
    await scrollTo('[data-embed="clip"]');
    await win.click('[data-embed="clip"] button.cl-ve-play');
    await win.waitForSelector('[data-embed="clip"] video[src^="clmedia://media/"]', { timeout: 20000 }).catch(() => {});
    await win.waitForFunction(() => (document.querySelector('[data-embed="clip"] video')?.currentTime ?? 0) > 1, null, { timeout: 30000 }).catch(() => {});
    await shot('verify-medal-playing-light-1366x768@' + SCALE);

    // 8. Compact: the clip card grows on play and collapses back.
    await openHarness('dark', 'compact');
    await setSize(1366, 768);
    await scrollTo('[data-embed="clip"]');
    R.compactIdle = await boxOf('[data-embed="clip"]');
    await win.click('[data-embed="clip"] button.cl-ve-play');
    await win.waitForSelector('[data-embed="clip"] video[src^="clmedia://media/"]', { timeout: 20000 }).catch(() => {});
    await sleep(2500);
    R.compactPlaying = await boxOf('[data-embed="clip"]');
    await shot('verify-compact-medal-playing-dark-1366x768@' + SCALE);
    await win.click('[data-embed="clip"] button[aria-label="Collapse player"]');
    await sleep(500);
    R.compactCollapsed = await boxOf('[data-embed="clip"]');
}

results.clmediaLog = mainLog;
results.consoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 30);
fs.writeFileSync(path.join(OUT, `results-scale${SCALE}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
await app.close();
