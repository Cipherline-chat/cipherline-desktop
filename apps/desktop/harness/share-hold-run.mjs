// A screen-share republish, end to end, with two real clients on a real SFU.
//
// Needs a throwaway LiveKit, never the dev stack's and never prod. From apps/desktop:
//   S=/some/scratch; cat > $S/lk.yaml <<EOF
//   port: 17880
//   rtc: { tcp_port: 17881, udp_port: 17882, use_external_ip: false, node_ip: 127.0.0.1 }
//   keys: { hold-e2e-key: hold-e2e-secret-at-least-32-characters }
//   room: { auto_create: true }
//   EOF
//   docker run -d --name cl-share-hold-lk -p 127.0.0.1:17880:17880 -p 127.0.0.1:17881:17881 -p 127.0.0.1:17882:17882/udp \
//     -v $S/lk.yaml:/lk.yaml:ro livekit/livekit-server:v1.9.12 --config /lk.yaml
//   PORT=5497 npx vite --config harness/share-hold.vite.config.ts &
//   OUT=$S node harness/share-hold-run.mjs        (env: SHOT=<png>, SHOT_DOCKED=<png>, SHOT_FALLBACK=<png>, E2EE=0)
// A cold Vite re-optimises deps and reloads the page mid-run: if the first run dies with
// "reading 'watch'", run it again.
//   docker rm -f cl-share-hold-lk
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const { AccessToken } = await import(process.env.LK_SDK ?? '/home/antigravity/Cipherline/node_modules/livekit-server-sdk/dist/index.js');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5497/harness/share-hold.html';
const URL_ = process.env.LK_URL ?? 'ws://127.0.0.1:17880';
const OUT = process.env.OUT ?? '/tmp/share-hold';
const SHOT = process.env.SHOT;
const KEY = 'hold-e2e-key', SECRET = 'hold-e2e-secret-at-least-32-characters';
mkdirSync(OUT, { recursive: true });

const room = `hold-${randomBytes(4).toString('hex')}`;
const keyB64 = process.env.E2EE === '0' ? null : randomBytes(32).toString('base64');
const token = async identity => {
    const at = new AccessToken(KEY, SECRET, { identity, name: identity === 'pub' ? 'Dawson' : 'Viewer', ttl: '1h' });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
    return at.toJwt();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function client(viewport) {
    const browser = await chromium.launch({
        executablePath: exe,
        args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(240_000);
    page.on('pageerror', e => console.log('pageerror ' + e.message.slice(0, 300)));
    page.on('console', m => {
        if (m.type() === 'error' && !/Failed to load resource|ERR_|Network Error|AxiosError/.test(m.text())) console.log('console.error: ' + m.text().slice(0, 300));
    });
    await page.goto(BASE);
    return { browser, page };
}

const pub = await client({ width: 640, height: 360 });
const view = await client({ width: 1600, height: 900 });
const P = (fn, ...a) => pub.page.evaluate(([f, args]) => window.H[f](...args), [fn, a]);
const V = (fn, ...a) => view.page.evaluate(([f, args]) => window.H[f](...args), [fn, a]);
const until = async (cond, what, ms = 15_000) => {
    const t = Date.now();
    for (;;) {
        const s = await V('snap', 'pub');
        if (cond(s)) return s;
        if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)}`);
        await sleep(40);
    }
};
/** Fails on any sample in the recording where the viewer was not in place. */
const inPlace = rec => rec.filter(s => !(s.focused && s.fullscreen && s.watching));
const phases = rec => rec.map(s => s.phase).filter((p, i, a) => p !== a[i - 1]);

try {
    await P('joinPublisher', { url: URL_, token: await token('pub'), keyB64 });
    await V('joinViewer', { url: URL_, token: await token('view'), keyB64 });
    console.log(`room ${room}, E2EE ${keyB64 ? 'on' : 'off'}: ${await V('e2eeEnabled')}`);

    // ── Someone not watching: nothing is captured and their Watch gate stays ─
    await P('startShare', 1280, 720);
    await sleep(1200);
    const gateIn = () => view.page.evaluate(() => !!document.querySelector('#side .ss-gate-enter'));
    const gateBefore = await gateIn();
    await V('rawClear');
    const notWatching = P('republish', 1600, 900, 900);
    await until(x => x.phase === 'holding', 'a hold with no tile');
    const gateDuring = await gateIn();
    const held = await V('snap', 'pub');
    await notWatching;
    await until(x => x.phase === 'idle', 'the hold to end', 4000);
    const firstEv = (await V('events'))[0];
    check('not watching: no frame taken, none shown', firstEv?.phase === 'armed' && firstEv.tiles === 0 && firstEv.frame === false && !held.frame, JSON.stringify(firstEv));
    check('not watching: the Watch gate stays through the gap', gateBefore && gateDuring);
    await P('stopShare');
    await sleep(800);

    // ── Getting a viewer into the state the owner described ──────────────────
    const enter = async (w_ = 1280, h_ = 720) => {
        await P('startShare', w_, h_);
        for (let i = 0; i < 200; i++) {
            const ok = await view.page.evaluate(() => { try { return !!window.H.watch; } catch { return false; } });
            if (ok) break;
            await sleep(50);
        }
        await sleep(600);
        await V('watch', 'pub');
        await until(s => s.videoW === w_, 'first video');
        await V('focus', 'pub');
        await sleep(200);
        await V('fullscreen', true);
        await sleep(400);
        const s = await V('snap', 'pub');
        return s.focused && s.fullscreen && s.videoW === w_;
    };
    check('viewer is watching, focused and fullscreen at 1280x720', await enter());

    // Any sample with no picture at all, or no tile: what a blink looks like.
    const blinks = rec => rec.filter(x => !(x.frame || x.videoW > 64));
    const tell = rec => rec.map(x => `${x.t} ${x.phase} f${x.focused ? 1 : 0} s${x.fullscreen ? 1 : 0} w${x.watching ? 1 : 0} frame${x.frame ? 1 : 0} v${x.videoW} tiles${x.tiles} note${x.note ? 1 : 0}`).join('\n');

    // ── D. The viewer's H.265 decoder dies mid-stream (reports e3f763fe / ad0fca72, 2026-11-02) ──
    // Real: the SFU, the attribute round trip, roomHevcState + HevcPolicy on the publisher, the real
    // make-before-break swap, the viewer hold, RxDecoderLostWatch + withdrawH265Decode on the viewer.
    // Stand-ins: the D3D11 failure (the viewer's stats start saying NullVideoDecoder and its remote track
    // is switched off, which renders black), vp9 for "H.264". What the owner saw was a tile that stayed
    // blank until the share ended; ONE flag (`withRecovery`) is the positive control for that.
    const decoderScenario = async withRecovery => {
        const tag = withRecovery ? 'D' : 'D control (no recovery)';
        await V('resetHevc');
        await V('advertise', true);
        await P('reactToDecoders', true);
        await V('startDecoderMonitor', 'pub', withRecovery);
        await until(x => x.videoW > 64, 'a live picture before the failure');
        await sleep(1500);
        const before = await V('brightness');
        check(`${tag}: the picture is live before the failure`, before !== null && before > 20, `brightness ${before}`);
        await V('rawClear');
        await V('record', 'pub');
        await V('killDecoder');
        await sleep(400);
        const dead = await V('brightness');
        check(`${tag}: the failure blanks the tile (the scenario reproduces the report)`, dead !== null && dead < 8, `brightness ${dead}`);
        let back = null;
        const t0 = Date.now();
        const settle = withRecovery ? 12_000 : 6_000;
        while (Date.now() - t0 < settle) {
            const b = await V('brightness');
            const sn = await V('snap', 'pub');
            if (b !== null && b > 20 && sn.phase === 'idle') { back = Date.now() - t0; break; }
            await sleep(150);
        }
        await sleep(600);
        const rec = await V('stopRecord');
        const lost = await V('decoderLost');
        const swaps = await P('decodeSwaps');
        const attr = await V('viewerAttr');
        check(`${tag}: the dead decoder was noticed exactly once`, lost.length === 1 && lost[0].codec === 'h265', JSON.stringify(lost));
        if (withRecovery) {
            check(`${tag}: the viewer stopped advertising H.265 decode`, attr === '1:', `attr ${attr}`);
            check(`${tag}: the publisher saw it and swapped once`, swaps.length === 1 && swaps[0].attr === '1:', JSON.stringify(swaps));
            check(`${tag}: the picture came back`, back !== null, back === null ? 'still blank' : `${back} ms after the failure`);
            check(`${tag}: focus, fullscreen and watch held at every DOM change`, inPlace(rec).length === 0, `${rec.length} samples, ${inPlace(rec).length} out of place, phases ${phases(rec).join(' ')}`);
            const ends = (await V('events')).filter(e => e.phase === 'end').slice(-1)[0];
            check(`${tag}: the swap hold resumed`, ends?.end === 'resumed', `end ${ends?.end}`);
        } else {
            check(`${tag}: nothing changed on the wire`, attr === '1:h265' && swaps.length === 0, `attr ${attr}, swaps ${swaps.length}`);
            check(`${tag}: the tile stays blank (what the owner saw)`, back === null, back === null ? `blank for the full ${settle} ms` : `came back after ${back} ms`);
        }
        await V('stopDecoderMonitor');
        await P('reactToDecoders', false);
        await V('resetHevc');
        await V('advertise', true);
    };
    if (process.env.ONLY === 'decoder') {
        await decoderScenario(true);
        await decoderScenario(false);
        throw new Error('ONLY=decoder finished');
    }
    if (process.env.ONLY === 'blink') {
        for (const gap of [1500, 300]) {
            await V('record', 'pub');
            const r_ = P('republish', gap === 1500 ? 1600 : 1280, gap === 1500 ? 900 : 720, gap);
            await until(x => x.phase === 'holding', 'hold');
            await r_;
            await until(x => x.phase === 'idle' && x.videoW > 64, 'new stream');
            await sleep(1500);
            const rec = await V('stopRecord');
            console.log(`--- republish gap ${gap}\n${tell(rec)}`);
            check(`republish ${gap}: in place at every DOM change`, inPlace(rec).length === 0, `${rec.length} samples`);
            check(`republish ${gap}: never without a picture`, blinks(rec).length === 0, `${blinks(rec).length} blank`);
        }
        await V('record', 'pub');
        await P('swapCodec', 'vp9');
        await sleep(3000);
        const rec = await V('stopRecord');
        console.log(`--- codec swap\n${tell(rec)}`);
        check('swap: in place at every DOM change', inPlace(rec).length === 0, `${rec.length} samples`);
        check('swap: never without a picture', blinks(rec).length === 0, `${blinks(rec).length} blank`);
        throw new Error('ONLY=blink finished');
    }

    // ── Fill Entire Screen from the docked focused view ──────────────────────
    {
        await V('fullscreen', false);
        await sleep(500);
        let d = await V('snap', 'pub');
        check('fill from docked: starts focused, not fullscreen', d.focused && !d.fullscreen);
        const box = await view.page.locator('#call-focus-root > div').first().boundingBox();
        await view.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
        await view.page.getByText('Fill Entire Screen', { exact: true }).click();
        await sleep(800);
        d = await V('snap', 'pub');
        const filled = await view.page.evaluate(() => {
            const vs = [...document.querySelectorAll('video')].filter(v => { const r = v.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            const big = vs.reduce((m, v) => Math.max(m, v.getBoundingClientRect().width), 0);
            return { big, w: innerWidth, fill: !!document.querySelector('.cl-fs-fill') };
        });
        check('fill from docked: fullscreen, with that video filling it', d.fullscreen && filled.fill && filled.big >= filled.w - 1, JSON.stringify(filled));
        await view.page.keyboard.press('Escape');
        await sleep(500);
        d = await V('snap', 'pub');
        const after = await view.page.evaluate(() => !!document.querySelector('.cl-fs-fill'));
        check('fill from docked: Esc steps back one level', d.fullscreen && !after);
        await V('fullscreen', true);
        await sleep(300);
    }

    // ── A. Republish at a new resolution, a realistic 2.6 s gap ──────────────
    await V('rawClear');
    await V('record', 'pub');
    const rep = P('republish', 1920, 1080, 1500);
    let s = await until(x => x.phase === 'holding', 'the hold');
    const midHold = await V('snap', 'pub');
    await rep;
    s = await until(x => x.phase === 'idle' && x.videoW === 1920, 'the new stream');
    let rec = await V('stopRecord');
    writeFileSync(`${OUT}/republish.json`, JSON.stringify(rec, null, 1));
    check('A: focus, fullscreen and watch held at every 15 ms sample', inPlace(rec).length === 0, `${rec.length} samples, ${inPlace(rec).length} out of place`);
    check('A: resumed at the new resolution', s.videoW === 1920, `videoW ${s.videoW}`);
    check('A: walked armed -> holding -> resuming -> idle', /armed.*holding.*resuming.*idle/.test(phases(rec).join(' ')), phases(rec).join(' '));
    check('A: the last frame was up during the gap', rec.some(x => x.phase === 'holding' && x.frame), `midHold ${JSON.stringify(midHold)}`);
    check('A: the frame is gone after', !s.frame && !s.note);
    check('A: the picture never showed as a tiny frame while held', rec.filter(x => x.phase !== 'idle').every(x => x.frame || x.note));
    let raw = await V('raw');
    const iAttr = raw.findIndex(e => e.ev === 'attr' && /share_republish":"[^"]/.test(e.detail));
    const iGone = raw.findIndex(e => e.ev === 'unpublished');
    check('ordering: the flag arrived before the unpublish', iAttr >= 0 && iAttr < iGone, raw.slice(0, 4).map(e => `${e.t} ${e.ev}`).join(', '));
    check('A: no start or stop cue', (await V('cues')).length === 0, JSON.stringify(await V('cues')));

    // ── A again, for the picture: hold long enough to look at it ─────────────
    if (SHOT) {
        const p = P('republish', 1280, 720, 3800);
        await until(x => x.phase === 'holding' && x.frame, 'the hold for the screenshot');
        await sleep(700);
        await view.page.screenshot({ path: SHOT });
        console.log('pixel at the centre of the held frame', JSON.stringify(await V('canvasPixels')));
        await p;
        await until(x => x.phase === 'idle' && x.videoW === 1280, 'the stream after the screenshot');
    }

    // ── A, docked: the focused banner keeps its height through the hold ──────
    await V('fullscreen', false);
    await sleep(500);
    await V('rawClear');
    const bannerBefore = (await V('snap', 'pub')).bannerH;
    await V('record', 'pub');
    const dock = P('republish', 2560, 1080, 1200); // and a different shape
    await until(x => x.phase === 'holding', 'the docked hold');
    if (process.env.SHOT_DOCKED) {
        await sleep(450);
        await view.page.screenshot({ path: process.env.SHOT_DOCKED });
    }
    await dock;
    s = await until(x => x.phase === 'idle' && x.videoW === 2560, 'the docked stream');
    await sleep(500);
    rec = await V('stopRecord');
    writeFileSync(`${OUT}/docked.json`, JSON.stringify(rec, null, 1));
    const heldHeights = [...new Set(rec.filter(x => x.phase !== 'idle').map(x => x.bannerH))];
    check('docked: still focused throughout', rec.every(x => x.focused && x.watching));
    check('docked: banner height did not move during the hold', heldHeights.length === 1 && heldHeights[0] === bannerBefore, `before ${bannerBefore}, during ${heldHeights.join('/')}`);
    const after = (await V('snap', 'pub')).bannerH;
    check('docked: banner refit to the new shape after', after !== bannerBefore && after > 0, `after ${after}`);
    await V('fullscreen', true);
    await sleep(400);

    // ── A, a watcher who has not focused it: the tile keeps its place ────────
    await V('fullscreen', false);
    await sleep(300);
    await V('focus', null);
    await sleep(500);
    const sideTile = () => view.page.evaluate(() => {
        const el = document.querySelector('#side .cl-tile-hover');
        return el ? { el: !!el, h: Math.round(el.getBoundingClientRect().height) } : null;
    });
    const sideBefore = await sideTile();
    const sidePub = P('republish', 1600, 900, 900);
    await until(x => x.phase === 'holding', 'the sidebar hold');
    await sleep(300);
    const sideDuring = await sideTile();
    const sideFrame = (await V('snap', 'pub')).frame;
    await sidePub;
    await until(x => x.phase === 'idle' && x.videoW === 1600, 'the sidebar stream');
    check('sidebar: the tile stays, at its height, with the frame', !!sideBefore && !!sideDuring && sideFrame && Math.abs(sideBefore.h - sideDuring.h) <= 2, `${sideBefore?.h} -> ${sideDuring?.h}`);
    await V('focus', 'pub');
    await sleep(200);

    // ── A, no frame to show: a tile that mounts mid-hold gets the fallback ───
    {
        await V('fullscreen', false);
        await sleep(400);
        const noFrame = P('republish', 1280, 720, 2600);
        await until(x => x.phase === 'holding', 'the hold for the fallback');
        await V('fullscreen', true); // this overlay tile did not exist when the frame was taken
        await sleep(650);
        const shown = await view.page.evaluate(() => {
            const stage = document.querySelector('#call-fullscreen-root');
            return { frame: !!stage?.querySelector('[data-share-hold-frame]'), note: !!stage?.querySelector('[data-share-hold-note]') };
        });
        check('fallback: a tile with no frame shows the note, no picture', !shown.frame && shown.note, JSON.stringify(shown));
        if (process.env.SHOT_FALLBACK) await view.page.screenshot({ path: process.env.SHOT_FALLBACK });
        await noFrame;
        await until(x => x.phase === 'idle' && x.videoW === 1280, 'the stream after the fallback');
        check('fallback: still focused and fullscreen after', (await V('snap', 'pub')).fullscreen && (await V('snap', 'pub')).focused);
    }

    // ── A. Tapping through resolutions ───────────────────────────────────────
    await V('rawClear');
    await V('record', 'pub');
    const r1 = P('republish', 1920, 1080, 700);
    await until(x => x.phase === 'holding', 'hold 1');
    await r1;
    await P('republish', 1280, 720, 600); // straight away: the new track has barely landed
    await P('republish', 1600, 900, 500);
    s = await until(x => x.phase === 'idle' && x.videoW === 1600, 'the last stream');
    await sleep(500);
    rec = await V('stopRecord');
    writeFileSync(`${OUT}/rapid.json`, JSON.stringify(rec, null, 1));
    check('rapid: in place through three changes', inPlace(rec).length === 0, `${rec.length} samples`);
    check('rapid: ended on the last resolution', s.videoW === 1600, `videoW ${s.videoW}`);
    check('rapid: no cue', (await V('cues')).length === 0);
    const idleGaps = phases(rec);
    console.log('rapid phases:', idleGaps.join(' '));

    // ── A slow first frame: the publish returns well before the SFU has any media ─
    for (const lag of [200, 600, 1200]) {
        await V('rawClear');
        await V('record', 'pub');
        const slow = P('republish', 1280, 720, 900, lag);
        await until(x => x.phase === 'holding', 'the hold');
        await slow;
        s = await until(x => x.phase === 'idle' && x.videoW === 1280, 'the new stream');
        await sleep(300);
        rec = await V('stopRecord');
        const evs = (await V('events')).filter(e => e.phase === 'end').slice(-1)[0];
        check(`slow first media ${lag} ms: in place throughout`, inPlace(rec).length === 0, `${rec.length} samples, ${inPlace(rec).length} out of place, phases ${phases(rec).join(' ')}, end ${evs?.end}`);
        await P('republish', 1600, 900, 300);
        await until(x => x.phase === 'idle' && x.videoW === 1600, 'back to the other size');
        await V('focus', 'pub').catch(() => {});
        await V('fullscreen', true).catch(() => {});
        await sleep(300);
        await P('republish', 1280, 720, 300);
        await until(x => x.phase === 'idle' && x.videoW === 1280, 'back to 1280');
        await V('focus', 'pub').catch(() => {});
        await V('fullscreen', true).catch(() => {});
        await sleep(300);
    }

    // ── The clear overtaking the new track (real viewer reports: end=cancelled) ──
    {
        await V('rawClear');
        await V('record', 'pub');
        const r_ = P('republishClearRace', 1600, 900, 600, 'published');
        await until(x => x.phase === 'holding', 'the hold');
        await r_;
        s = await until(x => x.phase === 'idle' && x.videoW === 1600, 'the new stream');
        await sleep(300);
        const rec_ = await V('stopRecord');
        const ev_ = (await V('events')).filter(e => e.phase === 'end').slice(-1)[0];
        check('clear race: resumed, not cancelled', ev_?.end === 'resumed', `end ${ev_?.end}`);
        check('clear race: in place at every DOM change', inPlace(rec_).length === 0, `${rec_.length} samples, ${inPlace(rec_).length} out of place`);
        // The flag from that run clears on its timer. Wait it out so the next run starts clean.
        await sleep(3200);
        // Positive control: clear at once, which is what shipped, and the viewer must lose its place.
        await V('record', 'pub');
        const c_ = P('republishClearRace', 1280, 720, 600, 'old-immediate-clear');
        await until(x => x.phase === 'holding', 'the control hold');
        await c_;
        await until(x => x.videoW === 1280 || !x.focused, 'the control to settle');
        await sleep(600);
        const recC = await V('stopRecord');
        const evC = (await V('events')).filter(e => e.phase === 'end').slice(-1)[0];
        check('clear race control: the old immediate clear does cancel the hold', evC?.end === 'cancelled', `end ${evC?.end}`);
        console.log(`control out of place: ${inPlace(recC).length} of ${recC.length}`);
        await V('watch', 'pub').catch(() => {});
        await until(x => x.videoW === 1280, 'the control stream');
        await V('focus', 'pub').catch(() => {});
        await V('fullscreen', true).catch(() => {});
        await sleep(400);
    }

    // ── D. A viewer's dead H.265 decoder, with the fix and without (positive control) ──
    await decoderScenario(true);
    await decoderScenario(false);
    // The control left its tile dead on purpose: a fresh publish is what a streamer stopping and starting would give.
    await P('republish', 1280, 720, 600);
    await until(x => x.phase === 'idle' && x.videoW === 1280, 'the stream after the decoder scenarios');
    await V('focus', 'pub').catch(() => {});
    await V('fullscreen', true).catch(() => {});
    await sleep(400);

    // ── B. A real stop ───────────────────────────────────────────────────────
    await V('rawClear');
    await V('record', 'pub');
    await P('stopShare');
    await until(x => !x.focused, 'focus to clear');
    await sleep(1600);
    rec = await V('stopRecord');
    writeFileSync(`${OUT}/stop.json`, JSON.stringify(rec, null, 1));
    raw = await V('raw');
    const tGone = raw.find(e => e.ev === 'unpublished')?.t;
    const tUnfocused = rec.find(x => !x.focused)?.t;
    const tNoVideo = rec.find(x => x.videoW === 0)?.t;
    check('B: never armed, never held, no frame', rec.every(x => x.phase === 'idle' && !x.frame && !x.note), phases(rec).join(' '));
    check('B: focus closed within a sample of the unpublish', tGone !== undefined && tUnfocused - tGone < 120, `unpublish at ${tGone}, focus gone at ${tUnfocused}, video gone at ${tNoVideo}`);
    check('B: left fullscreen on the normal 1.2 s grace', !(await V('snap', 'pub')).fullscreen);
    await sleep(300);
    check('B: stop cue played', (await V('cues')).some(c => c.cue === 'screenshare_off'), JSON.stringify(await V('cues')));
    const lastEvents = await V('events');
    console.log('share_hold events so far:', JSON.stringify(lastEvents.slice(-3)));
    check('B: logged as phase=gone', lastEvents[lastEvents.length - 1]?.phase === 'gone');

    // ── Hold timeout: the publisher hangs mid-republish ──────────────────────
    check('re-enter', await enter());
    await V('rawClear');
    await V('record', 'pub');
    await P('hang');
    await until(x => x.phase === 'holding', 'the hold');
    const tHeld = Date.now();
    await until(x => x.phase === 'idle', 'the timeout', 9000);
    const heldFor = Date.now() - tHeld;
    await until(x => !x.focused, 'focus to clear after the timeout', 500);
    await sleep(1500);
    rec = await V('stopRecord');
    check('timeout: closed at about 6 s', heldFor > 5500 && heldFor < 6600, `${heldFor} ms`);
    check('timeout: frame dropped, left fullscreen', (await V('snap', 'pub')).frame === false && (await V('snap', 'pub')).fullscreen === false);
    check('timeout: stop cue at the end', (await V('cues')).some(c => c.cue === 'screenshare_off'), JSON.stringify(await V('cues')));

    // ── A failed republish clears at once ────────────────────────────────────
    await sleep(500);
    check('re-enter', await enter());
    await V('rawClear');
    await P('failRepublish', 600);
    const tFail = Date.now();
    await until(x => x.phase === 'idle' && !x.focused, 'the cancel', 1500);
    check('failed republish: closed on the clear, not the timeout', Date.now() - tFail < 800, `${Date.now() - tFail} ms after the failure`);

    // ── The publisher leaves mid-republish ───────────────────────────────────
    await sleep(500);
    check('re-enter', await enter());
    await P('hang');
    await until(x => x.phase === 'holding', 'the hold');
    await sleep(300);
    await P('leave');
    const tLeft = Date.now();
    await until(x => x.phase === 'idle' && !x.focused, 'the leave', 3000);
    check('leave: closed at once', Date.now() - tLeft < 1500, `${Date.now() - tLeft} ms`);
    console.log('all share_hold events:', JSON.stringify(await V('events')));
} catch (e) {
    check('run completed', false, e.message.slice(0, 400));
} finally {
    await pub.browser.close().catch(() => {});
    await view.browser.close().catch(() => {});
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
