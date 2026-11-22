// Theme sharing screenshots (claude/theme-share-embed). Reuses the light-theme
// harness (harness/light-theme-main.tsx: the REAL ChatPane / SettingsScreen /
// dialogs) with ?msgs=theme (theme links in the feed) and its fake
// "Send to a friend" provider, plus the website's /theme page from a built dist.
//
//   LT_PORT=5431 npx vite --config harness/light-theme.vite.config.ts            (another shell)
//   (website) npx vite preview --port 5491 --strictPort                             (another shell, after npm run build)
//   node harness/theme-share-shots.mjs --out=<dir> [--only=a,b] [--site=http://127.0.0.1:5491]
//
// App shots at the owner's sizes: 1000x720, 1366x768, 1920x1080, 1280x800 @1.5.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const BASE = `http://127.0.0.1:${process.env.LT_PORT ?? 5431}/harness/light-theme.html`;
const SITE = arg('site', 'http://127.0.0.1:5491');
const out = arg('out', '/tmp/theme-share-shots');
const only = arg('only', '').split(',').filter(Boolean);
const SIZES = {
    min: { width: 1000, height: 720, dsf: 1 },
    laptop: { width: 1366, height: 768, dsf: 1 },
    large: { width: 1920, height: 1080, dsf: 1 },
    hidpi: { width: 1280, height: 800, dsf: 1.5 },
    phone: { width: 390, height: 844, dsf: 2 },
    web: { width: 1366, height: 900, dsf: 1 },
};
const APP_SIZES = ['min', 'laptop', 'large', 'hidpi'];
const LABEL = { min: '1000x720', laptop: '1366x768', large: '1920x1080', hidpi: '1280x800@1.5', phone: '390', web: '1366' };
const settle = (page, ms) => page.waitForTimeout(ms);

async function openShare(page, tileId) {
    const tile = page.locator(`[data-custom-theme-tile="${tileId}"]`);
    await tile.scrollIntoViewIfNeeded();
    await tile.getByRole('button', { name: /^Share / }).click();
    await settle(page, 900);
}
async function openSend(page) {
    await openShare(page, 'p-ocean');
    await page.getByRole('button', { name: 'Send to a friend' }).click();
    await settle(page, 700);
    await page.getByRole('option', { name: /Mira/ }).first().click();
    await settle(page, 200);
    await page.locator('#cts-note').fill('this one is for you');
    await settle(page, 400);
}
/** Bring the n-th theme card into view (centred) in the chat feed. */
async function showCard(page, n) {
    const card = page.locator('[data-theme-embed]').nth(n);
    await card.waitFor({ timeout: 10000 });
    await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await settle(page, 600);
}

const SHOTS = [];
for (const size of APP_SIZES) {
    const L = LABEL[size];
    SHOTS.push(
        { name: `01-share-dialog-${L}`, size, url: 'view=settings&tab=appearance&lib=1&use=ocean', prep: (p) => openShare(p, 'p-ocean') },
        { name: `02-friend-picker-${L}`, size, url: 'view=settings&tab=appearance&lib=1&use=ocean', prep: openSend },
        { name: `03-dm-dark-ocean-${L}`, size, url: 'view=dm&theme=dark&msgs=theme', prep: (p) => showCard(p, 0) },
        { name: `04-dm-light-rose-${L}`, size, url: 'view=dm&theme=light&msgs=theme', prep: (p) => showCard(p, 1) },
        { name: `05-server-channel-${L}`, size, url: 'view=server&theme=dark&msgs=theme', prep: (p) => showCard(p, 1) },
        {
            name: `06-import-preview-from-embed-${L}`, size, url: 'view=dm&theme=dark&msgs=theme',
            prep: async (p) => { await showCard(p, 0); await p.locator('[data-theme-embed="ok"]').first().getByRole('button', { name: /Preview/ }).click(); await settle(p, 900); },
        },
    );
}
SHOTS.push(
    { name: '07-send-done-1366x768', size: 'laptop', url: 'view=settings&tab=appearance&lib=1&use=ocean', prep: async (p) => { await openSend(p); await p.getByRole('button', { name: /^Send$/ }).click(); await settle(p, 1200); } },
    { name: '08-dm-light-dusk-adjusted-and-unreadable-1366x768', size: 'laptop', url: 'view=dm&theme=light&msgs=theme', prep: (p) => showCard(p, 3) },
    { name: '12-server-hyperlinked-1366x768', size: 'laptop', url: 'view=server&theme=dark&msgs=theme', prep: (p) => showCard(p, 2) },
);
// Card states at the laptop and the minimum window size.
for (const size of ['laptop', 'min']) {
    const L = LABEL[size];
    SHOTS.push(
        { name: `09-server-light-${L}`, size, url: 'view=server&theme=light&msgs=theme', prep: (p) => showCard(p, 1) },
        { name: `10-dm-under-custom-mono-app-theme-${L}`, size, url: 'view=dm&use=mono&msgs=theme', prep: (p) => showCard(p, 1) },
        { name: `11-dm-saved-state-${L}`, size, url: 'view=dm&theme=dark&msgs=theme&lib=1', prep: (p) => showCard(p, 0) },
        // The app is using Ocean (a library theme): Ocean's card says "In use", Rose's says Saved / Use.
        { name: `13-dm-in-use-state-${L}`, size, url: 'view=dm&msgs=theme&lib=1&use=ocean', prep: (p) => showCard(p, 0) },
    );
}
// The website's /theme page (a built dist served by `vite preview`).
let OCEAN_CODE = ''; // computed in the harness page from the real encoder (below)
const WEB = [
    { name: 'web-01-theme-page-390', size: 'phone', web: () => `/theme#${OCEAN_CODE}`, full: true },
    { name: 'web-02-theme-page-1366', size: 'web', web: () => `/theme#${OCEAN_CODE}`, full: true },
    { name: 'web-03-theme-page-unreadable-390', size: 'phone', web: () => '/theme#clth1.eyJ2IjoxLCJuYW1l' },
];

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
const errors = [];
try {
    {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto(`${BASE}?view=home`, { waitUntil: 'load' });
        OCEAN_CODE = await page.evaluate(async () => {
            const [{ encodeShareCode }, { CUSTOM_THEME_PRESETS }] = await Promise.all([import('/src/theme/customTheme.ts'), import('/src/theme/customPresets.ts')]);
            return encodeShareCode(CUSTOM_THEME_PRESETS.find((p) => p.key === 'ocean').def);
        });
        await ctx.close();
    }
    for (const shot of [...SHOTS, ...WEB]) {
        if (only.length && !only.some((o) => shot.name.startsWith(o))) continue;
        const s = SIZES[shot.size];
        const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dsf, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => errors.push(`${shot.name}: ${e.message}`));
        if (shot.web) {
            // Prove the fragment never reaches the server: record every request the page makes.
            const requests = [];
            page.on('request', (r) => requests.push(r.url()));
            await page.goto(`${SITE}${shot.web()}`, { waitUntil: 'networkidle' });
            await settle(page, 1500);
            const leaked = requests.filter((u) => u.includes('clth1'));
            if (leaked.length) errors.push(`${shot.name}: theme code in a request: ${leaked.join(', ')}`);
        } else {
            await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
            await page.goto(`${BASE}?${shot.url}`, { waitUntil: 'load' });
            await page.waitForFunction(() => window.__booted === true, null, { timeout: 30000 });
            await settle(page, 1800);
            if (shot.prep) await shot.prep(page);
        }
        await page.screenshot({ path: path.join(out, `${shot.name}.png`), fullPage: !!shot.full });
        console.log('shot', shot.name);
        await ctx.close();
    }
} finally {
    await browser.close();
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
