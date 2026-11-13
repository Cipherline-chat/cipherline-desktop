// Animated server art in real Chromium: the cropper on an animated GIF (every frame cropped by the real
// worker), the server rail / header (first frame, plays on hover, freezes when the app is not in front).
//
//   npx vite --config harness/animated-art.vite.config.ts      (serves :5321)
//   node harness/animated-art-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=... SHARP=<path to sharp>)
//
// Fixtures (animated GIF / WebP / PNG) are generated here with sharp and served to the page by route
// interception, so nothing is committed. Exits non-zero when any check fails.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const sharp = require(process.env.SHARP ?? '/home/antigravity/Cipherline/apps/api/node_modules/sharp');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5321/harness/animated-art.html';
const OUT = process.env.OUT ?? '/tmp/animated-art-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

// ── fixtures ────────────────────────────────────────────────────────────────
async function gif(w, h, frames, delay, paint) {
    const raw = Buffer.alloc(w * h * 4 * frames);
    for (let f = 0; f < frames; f++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = ((f * h + y) * w + x) * 4;
        const [r, g, b] = paint(x, y, f, w, h, frames);
        raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
    return sharp(raw, { raw: { width: w, height: h * frames, channels: 4, pageHeight: h } }).gif({ delay: Array(frames).fill(delay) }).toBuffer();
}
// Three colour zones (red | green | blue), a white disc sweeping across, a frame bar along the bottom.
const photo = (x, y, f, w, h, n) => {
    const zone = x < w / 3 ? [200 + (y % 40) / 2, 40, 50] : x < 2 * w / 3 ? [40, 170 + (y % 40) / 2, 80] : [50, 70, 210 + (y % 40) / 2];
    const cx = ((f + 0.5) / n) * w, cy = h * 0.42, r = h * 0.17;
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return [250, 250, 250];
    if (y > h - 14 && x < ((f + 1) / n) * w) return [10, 10, 20];
    return zone;
};
const wedge = (hue) => (x, y, f, w, h, n) => {
    const dx = x - w / 2, dy = y - h / 2, a = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI), d = Math.hypot(dx, dy);
    if (d > w * 0.46) return [18, 24, 48];
    const t = (a * 360 + (f / n) * 360 + hue) % 360 < 120 ? 1 : 0;
    return t ? [255, 190, 60] : [40, 190, 170];
};
const art = {
    '/art/photo.gif': await gif(480, 270, 24, 50, photo),
    '/art/icon.gif': await gif(256, 256, 20, 60, wedge(0)),
    '/art/banner.gif': await gif(600, 240, 18, 70, photo),
};
art['/art/icon.webp'] = await sharp(await gif(256, 256, 20, 60, wedge(150)), { animated: true }).webp({ quality: 80 }).toBuffer();
art['/art/static.png'] = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#6C7BFF' } }).png().toBuffer();
const mimeOf = (p) => p.endsWith('.gif') ? 'image/gif' : p.endsWith('.webp') ? 'image/webp' : 'image/png';
for (const [p, b] of Object.entries(art)) writeFileSync(`${OUT}/fixture-${p.split('/').pop()}`, b);

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
async function newPage(viewport) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });
    await page.route((url) => url.pathname.startsWith('/art/'), (route) => {
        const p = new URL(route.request().url()).pathname;
        route.fulfill({ status: 200, contentType: mimeOf(p), body: art[p] });
    });
    // headless has no window focus: emulate it so useAppInFront sees an in-front window
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return { ctx, page };
}

/** Four PNG buffers of `clip`, `gap` ms apart. */
async function frames(page, clip, n = 4, gap = 140) {
    const out = [];
    for (let i = 0; i < n; i++) { out.push(await page.screenshot({ clip })); await sleep(gap); }
    return out;
}
const distinct = (bufs) => new Set(bufs.map(b => b.toString('base64'))).size;

async function strip(bufs, path, w) {
    const imgs = await Promise.all(bufs.map(b => sharp(b).resize({ width: w }).png().toBuffer()));
    const meta = await sharp(imgs[0]).metadata();
    await sharp({ create: { width: (w + 8) * imgs.length, height: meta.height, channels: 3, background: '#0B0F1E' } })
        .composite(imgs.map((input, i) => ({ input, left: i * (w + 8), top: 0 }))).png().toFile(path);
}

try {
    // ── 1. cropping an animated GIF (icon, then banner) ──────────────────────────────────────────
    for (const kind of ['icon', 'banner']) {
        const { ctx, page } = await newPage({ width: 1180, height: 820 });
        await page.goto(`${BASE}?scene=crop&kind=${kind}&src=/art/photo.gif`);
        await page.waitForSelector('.clcrop-img');
        await sleep(700);
        check(`[${kind}] the cropper previews the animated GIF as a plain <img> (it plays)`, await page.locator('.clcrop-img').evaluate(i => i.src.startsWith('blob:') && i.naturalWidth === 480));
        check(`[${kind}] the cropper says every frame is cropped`, (await page.evaluate(() => document.body.textContent)).includes('every frame is cropped'));
        await page.screenshot({ path: `${OUT}/${kind}-1-cropper-default.png` });

        if (kind === 'icon') {
            // zoom into the LEFT (red) third, with the disc sweeping through it
            const box = await page.locator('.clcrop-stage').boundingBox();
            await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
            for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -240); await sleep(60); }
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
            await sleep(300);
        }
        await page.screenshot({ path: `${OUT}/${kind}-2-cropper-adjusted.png` });

        const t0 = Date.now();
        await page.getByRole('button', { name: /Apply/ }).click();
        await page.waitForFunction(() => window.__result, null, { timeout: 120000 });
        const ms = Date.now() - t0;
        const res = await page.evaluate(() => window.__result);
        console.log(`      [${kind}] crop+encode ${ms} ms -> ${JSON.stringify({ ...res, durations: res.durations.length + ' frames' })}`);
        check(`[${kind}] stored as animated WebP`, res.type === 'image/webp');
        check(`[${kind}] frame count preserved (24)`, res.frames === 24, `${res.frames}`);
        const total = res.durations.reduce((a, b) => a + b, 0);
        check(`[${kind}] playback length preserved (24 x 50 ms = 1200 ms)`, Math.abs(total - 1200) <= 60, `${total} ms`);
        const wantW = kind === 'icon' ? 320 : 800, wantH = kind === 'icon' ? 320 : 320;
        check(`[${kind}] cropped to ${wantW}x${wantH}`, res.width === wantW && res.height === wantH, `${res.width}x${res.height}`);
        check(`[${kind}] well under the caps (4 MiB)`, res.bytes < 4 * 1024 * 1024, `${(res.bytes / 1024).toFixed(0)} KB`);

        // the crop was APPLIED: probe the first frame's centre pixel
        const px = await page.evaluate(async () => {
            const blob = window.__resultBlob;
            const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
            await dec.completed;
            const { image } = await dec.decode({ frameIndex: 0 });
            const c = document.createElement('canvas'); c.width = image.displayWidth; c.height = image.displayHeight;
            const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
            const at = (fx, fy) => [...ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data.slice(0, 3)];
            return { centre: at(0.5, 0.8), left: at(0.1, 0.8), right: at(0.9, 0.8) };
        });
        console.log(`      [${kind}] first-frame probe ${JSON.stringify(px)}`);
        if (kind === 'icon') {
            // The cropper showed red | green (boundary ~40% from the left, no blue); the stored frame must be exactly that.
            check('[icon] zoomed + panned: the stored frame is the framed region (red left, green right, NO blue)', px.left[0] > px.left[1] + 60 && px.right[1] > px.right[0] + 60 && px.right[2] < 120 && px.centre[2] < 120, JSON.stringify(px));
        } else {
            check('[banner] default framing keeps all three zones (red | green | blue left to right)', px.left[0] > px.left[1] && px.centre[1] > px.centre[0] && px.right[2] > px.right[0], JSON.stringify(px));
        }
        await sleep(400);
        await page.screenshot({ path: `${OUT}/${kind}-3-result.png` });
        await ctx.close();
    }

    // ── 2. server rail + header ──────────────────────────────────────────────────────────────────
    {
        const { ctx, page } = await newPage({ width: 700, height: 470 });
        await page.goto(`${BASE}?scene=server`);
        await page.waitForSelector('[data-testid="masthead"] img');
        await sleep(1200); // first-frame extraction
        const t1 = page.locator('[data-testid="tile-s1"]'), t2 = page.locator('[data-testid="tile-s2"]'), t3 = page.locator('[data-testid="tile-s3"]');
        const clipOf = async (loc, pad = 0) => { const b = await loc.boundingBox(); return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad }; };
        const srcs = await page.evaluate(() => ({
            full: Object.fromEntries(Object.entries(window.__art).map(([k, v]) => [k, v.url])),
            tile1: document.querySelector('[data-testid="tile-s1"] img').src,
            tile2: document.querySelector('[data-testid="tile-s2"] img').src,
            tile3: document.querySelector('[data-testid="tile-s3"] img').src,
            banner: document.querySelector('[data-testid="masthead"] img').src,
        }));
        check('rail: an animated GIF icon shows a first-frame STILL (not the GIF)', srcs.tile1 !== srcs.full['icon-gif'], srcs.tile1.slice(0, 40));
        check('rail: an animated WebP icon (what the cropper produces) shows a still too', srcs.tile2 !== srcs.full['icon-webp']);
        check('rail: a static icon is untouched', srcs.tile3 === srcs.full['icon-png']);
        check('header: the open server\'s animated banner plays (full file)', srcs.banner === srcs.full['banner-gif']);

        await page.mouse.move(650, 440);
        const rest = await frames(page, await clipOf(t1, 4));
        check('rail icon at rest does not move (identical frames over 0.4 s)', distinct(rest) === 1, `${distinct(rest)} distinct`);
        await page.screenshot({ path: `${OUT}/server-1-rest.png` });

        await t1.hover();
        await sleep(150);
        check('rail icon hovered: swaps to the animated file', await page.evaluate(() => document.querySelector('[data-testid="tile-s1"] img').src) === srcs.full['icon-gif']);
        const hov = await frames(page, await clipOf(t1, 4), 6, 90);
        check('rail icon hovered: it animates (>= 3 distinct frames in 0.5 s)', distinct(hov) >= 3, `${distinct(hov)} distinct`);
        await strip(hov, `${OUT}/server-2-hover-strip-icon.png`, 140);
        await page.screenshot({ path: `${OUT}/server-3-hover.png` });

        await page.mouse.move(650, 440);
        await sleep(200);
        check('rail icon after the pointer leaves: back to the still', (await page.evaluate(() => document.querySelector('[data-testid="tile-s1"] img').src)) === srcs.tile1);

        const mast = await clipOf(page.locator('[data-testid="masthead"]'));
        const bf = await frames(page, mast, 6, 110);
        check('open server banner animates while Cipherline is in front', distinct(bf) >= 3, `${distinct(bf)} distinct`);
        await strip(bf, `${OUT}/server-4-banner-strip.png`, 250);

        // app not in front -> always-on animation freezes on its first frame
        await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await sleep(500);
        const frozenSrc = await page.evaluate(() => document.querySelector('[data-testid="masthead"] img').src);
        check('banner freezes on its first frame when the app is not in front', frozenSrc !== srcs.full['banner-gif']);
        const fz = await frames(page, mast, 4, 110);
        check('  ... and really stands still', distinct(fz) === 1, `${distinct(fz)} distinct`);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await sleep(400);
        check('banner plays again when the app is back in front', (await page.evaluate(() => document.querySelector('[data-testid="masthead"] img').src)) === srcs.full['banner-gif']);
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
