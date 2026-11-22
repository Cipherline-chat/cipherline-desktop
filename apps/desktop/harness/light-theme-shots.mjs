// Light theme screenshots: every surface of harness/light-theme-main.tsx in
// Dark and Light, at the owner's window sizes (CLAUDE.md / feedback: desktop
// min 1000x720, laptop 1366x768, large 1920x1080, HiDPI 1280x800 @1.5) and at
// Interface size 125 % (emulated exactly as electron/ui-scale.ts does it:
// CSS viewport = window / factor, device pixel ratio x factor).
//
//   LT_PORT=5431 npx vite --config harness/light-theme.vite.config.ts      (another shell)
//   node harness/light-theme-shots.mjs --out=<dir> [--themes=dark,light] [--views=home,server,...]
//        [--sizes=min,laptop,large,hidpi] [--scales=100,125]
//
// Files: <out>/<view>-<theme>-<size>[-<scale>].png
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const BASE = `http://127.0.0.1:${process.env.LT_PORT ?? 5431}/harness/light-theme.html`;
const out = arg('out', '/tmp/light-theme-shots');
const THEMES = arg('themes', 'dark,light').split(',').filter(Boolean);
const ALL_SIZES = {
    min: { width: 1000, height: 720, dsf: 1 },
    laptop: { width: 1366, height: 768, dsf: 1 },
    large: { width: 1920, height: 1080, dsf: 1 },
    hidpi: { width: 1280, height: 800, dsf: 1.5 },
};
const SIZES = arg('sizes', 'min,laptop,large,hidpi').split(',').filter(Boolean);
const SCALES = arg('scales', '100').split(',').map(Number).filter(Boolean);
const settle = (page, ms) => page.waitForTimeout(ms);

/** view id -> { url, prep } */
const VIEWS = {
    home: { url: 'view=home' },
    // Keys in every colour state (light-theme polish)
    keys: { url: 'view=keys' },
    keys_before: { url: 'view=keys&keysold=1' },
    server: { url: 'view=server', prep: async (page) => { await page.evaluate(() => document.getElementById('msg-m1')?.scrollIntoView({ block: 'start' })); await settle(page, 600); } },
    // the bottom of the feed: invite card, image, system row
    feed: { url: 'view=server' },
    dm: { url: 'view=dm' },
    friends: { url: 'view=friends' },
    emoji: { url: 'view=dm', prep: async (page) => { await page.locator('button[title="Emoji"]').first().click().catch(() => {}); await settle(page, 800); } },
    gif: { url: 'view=dm', prep: async (page) => { await page.locator('button[title="GIF"]').first().click().catch(() => {}); await settle(page, 1200); } },
    appearance: { url: 'view=settings&tab=appearance' },
    accessibility: { url: 'view=settings&tab=accessibility' },
    set_voice: { url: 'view=settings&tab=voice' },
    set_privacy: { url: 'view=settings&tab=privacy' },
    set_advanced: { url: 'view=settings&tab=advanced' },
    set_profile: { url: 'view=settings&tab=profile' },
    modal: { url: 'view=modal' },
    // context menu on a message + a tooltip on the header + a toast
    menu: {
        url: 'view=menu',
        prep: async (page) => {
            await page.evaluate(() => window.__toast?.('success'));
            await settle(page, 500);
            const row = page.locator('[id="msg-m9"]').first();
            const box = await row.boundingBox().catch(() => null);
            if (box) await page.mouse.click(box.x + box.width * 0.45, box.y + 12, { button: 'right' });
            await settle(page, 700);
        },
    },
    tooltip: {
        url: 'view=server',
        prep: async (page) => {
            const btn = page.locator('[aria-label="Pinned messages"], button[title="Pinned messages"]').first();
            const box = await btn.boundingBox().catch(() => null);
            if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            else {
                const any = page.locator('.cl-hdr-actions button').first();
                const b2 = await any.boundingBox().catch(() => null);
                if (b2) await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
            }
            await settle(page, 900);
        },
    },
};
const views = arg('views', Object.keys(VIEWS).join(',')).split(',').filter(Boolean);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
const errors = [];
try {
    for (const sizeId of SIZES) {
        const s = ALL_SIZES[sizeId];
        for (const z of SCALES) {
            for (const theme of THEMES) {
                for (const v of views) {
                    const spec = VIEWS[v];
                    if (!spec) throw new Error(`unknown view ${v}`);
                    // A fresh context per shot: the page persists state (IndexedDB: e.g. Home's
                    // once-a-day greeting), so a second visit in one context would differ.
                    const ctx = await browser.newContext({
                        viewport: { width: Math.round(s.width * 100 / z), height: Math.round(s.height * 100 / z) },
                        deviceScaleFactor: s.dsf * z / 100,
                        reducedMotion: process.env.LT_MOTION === 'full' ? 'no-preference' : 'reduce',
                    });
                    const page = await ctx.newPage();
                    // A frozen clock, so "Today at 4:20 PM" is the same in every shot (pixel diffs).
                    await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
                    page.on('pageerror', (e) => errors.push(`${v}/${theme}/${sizeId}: ${e.message}`));
                    await page.goto(`${BASE}?theme=${theme}&${spec.url}`, { waitUntil: 'load' });
                    await page.waitForFunction(() => window.__booted === true, null, { timeout: 30000 });
                    await settle(page, 1800);
                    if (spec.prep) await spec.prep(page);
                    const name = `${v}-${theme}-${sizeId}${z !== 100 ? `-${z}` : ''}.png`;
                    await page.screenshot({ path: path.join(out, name) });
                    console.log('shot', name);
                    await ctx.close();
                }
            }
        }
    }
} finally {
    await browser.close();
}
if (errors.length) { console.log('page errors:\n' + [...new Set(errors)].join('\n')); }
