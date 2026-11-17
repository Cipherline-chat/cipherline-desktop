// Server Settings → Overview banner preview in real Chromium: screenshots + a shape check.
//   npx vite --config harness/server-banner-preview.vite.config.ts      (serves :5361; PORT=... to move it)
//   LABEL=after OUT=<dir> node harness/server-banner-preview-shots.mjs
// Scenes, each at a windowed-dock (1280x800) and a fullscreen-dock (1920x1080) viewport:
//   existing  a server that already has a banner (1200x480 edge-labelled test card)
//   cropped   a 1920x1080 photo picked → the REAL ClImageCropper → Apply → the post-crop preview
// Prints the preview box's measured aspect ratio; with CHECK=1 exits non-zero unless it is 2.5:1.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const sharp = require(process.env.SHARP ?? '/home/antigravity/Cipherline/apps/api/node_modules/sharp');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5361/harness/server-banner-preview.html';
const OUT = `${process.env.OUT ?? '/tmp/server-banner-preview-shots'}/${process.env.LABEL ?? 'after'}`;
const CHECK = process.env.CHECK === '1';
mkdirSync(OUT, { recursive: true });
let failures = 0;

// A 16:9 photo-ish source with labelled edges, so the cropper has to cut it to 2.5:1.
const photo = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#11998e"/><stop offset="1" stop-color="#38ef7d"/></linearGradient></defs>
<rect width="1920" height="1080" fill="url(#g)"/>
<circle cx="960" cy="540" r="260" fill="#0b0f1e" opacity=".45"/>
<text x="960" y="560" font-family="sans-serif" font-size="90" font-weight="700" fill="#fff" text-anchor="middle">CENTRE</text>
<rect x="0" y="0" width="1920" height="1080" fill="none" stroke="#ff6b5e" stroke-width="20"/></svg>`)).png().toBuffer();

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const vp of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
        for (const scene of ['existing', 'cropped']) {
            const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
            const page = await ctx.newPage();
            page.on('pageerror', e => console.log('pageerror', e.message));
            await page.goto(`${BASE}?${scene === 'existing' ? 'banner=1' : ''}`);
            await page.waitForSelector('text=Server Name', { timeout: 60000 });
            await page.waitForTimeout(900);
            if (scene === 'cropped') {
                await page.locator('input[type=file]').first().setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: photo });
                await page.getByRole('button', { name: 'Apply' }).click({ timeout: 30000 });
                await page.waitForSelector('img[alt="Banner preview"]', { timeout: 30000 });
                await page.waitForTimeout(700);
            }
            // The old markup has no test id; the banner box is the first child under the "Banner" label either way.
            const box = await page.evaluate(() => {
                const label = Array.from(document.querySelectorAll('p')).find(p => p.textContent === 'Banner');
                const el = label?.nextElementSibling?.firstElementChild;
                const r = el?.getBoundingClientRect();
                const card = label?.closest('.dock-card')?.getBoundingClientRect();
                return r && card ? { w: r.width, h: r.height, card: { x: card.x, y: card.y, w: card.width, h: card.height } } : null;
            });
            const ratio = box ? box.w / box.h : NaN;
            const ok = Math.abs(ratio - 2.5) < 0.02;
            if (CHECK && !ok) failures++;
            console.log(`${ok ? 'OK  ' : 'DIFF'}  ${vp.width}x${vp.height} ${scene}: preview ${box?.w.toFixed(0)}x${box?.h.toFixed(0)} = ${ratio.toFixed(3)}:1 (crop is 2.500:1)`);
            const name = `${scene}--${vp.width}`;
            await page.screenshot({ path: `${OUT}/${name}.png` });
            if (box) await page.screenshot({ path: `${OUT}/${name}.card.png`, clip: { x: box.card.x - 8, y: box.card.y - 8, width: box.card.w + 16, height: box.card.h + 16 } });
            await ctx.close();
        }
    }
} finally {
    await browser.close();
}
process.exit(failures ? 1 : 0);
