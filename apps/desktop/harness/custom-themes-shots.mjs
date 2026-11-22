// Custom themes screenshots (plan T5). Reuses the light-theme harness
// (harness/light-theme-main.tsx: the REAL HomePanel / ServerChannelList /
// ChatPane / SettingsScreen inside Dashboard's shell) with its custom-theme
// params (?use=<preset>, ?ct=<code>, ?lib=1), and drives the REAL editor,
// share and import dialogs.
//
//   LT_PORT=5431 npx vite --config harness/light-theme.vite.config.ts      (another shell)
//   node harness/custom-themes-shots.mjs --out=<dir> [--only=a,b]
//
// Sizes per the owner's matrix: laptop 1366x768, large 1920x1080, HiDPI
// 1280x800 @1.5, desktop min 1000x720 at Interface size 125 % (emulated as
// electron/ui-scale.ts does: CSS viewport = window / factor, DPR x factor).
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const BASE = `http://127.0.0.1:${process.env.LT_PORT ?? 5431}/harness/light-theme.html`;
const out = arg('out', '/tmp/custom-themes-shots');
const only = arg('only', '').split(',').filter(Boolean);
const SIZES = {
    laptop: { width: 1366, height: 768, dsf: 1, z: 100 },
    large: { width: 1920, height: 1080, dsf: 1, z: 100 },
    hidpi: { width: 1280, height: 800, dsf: 1.5, z: 100 },
    min125: { width: 1000, height: 720, dsf: 1, z: 125 },
};
const settle = (page, ms) => page.waitForTimeout(ms);

async function openEditorFor(page, tileId) {
    const tile = page.locator(`[data-custom-theme-tile="${tileId}"]`);
    await tile.scrollIntoViewIfNeeded();
    await tile.getByRole('button', { name: /^Edit / }).click();
    await settle(page, 900);
}
async function openCreate(page) {
    const b = page.locator('[data-create-theme]');
    await b.scrollIntoViewIfNeeded();
    await b.click();
    await settle(page, 900);
}
/** Type a hex into one knob's colour picker and close it. */
async function setKnob(page, knob, hex) {
    await page.locator(`.cte-row[data-knob="${knob}"] button`).first().click();
    await settle(page, 300);
    const input = page.getByLabel(/hex value$/).last();
    await input.fill(hex.replace('#', ''));
    await input.press('Enter');
    await settle(page, 200);
    await page.keyboard.press('Escape');
    await settle(page, 400);
}

const SETTINGS = 'view=settings&tab=appearance&lib=1';
const SHOTS = [
    // The editor with live preview, editing Ocean (the active theme) at the owner's sizes.
    { name: '01-editor-ocean-1366x768', size: 'laptop', url: `${SETTINGS}&use=ocean`, prep: (p) => openEditorFor(p, 'p-ocean') },
    { name: '02-editor-ocean-1920x1080', size: 'large', url: `${SETTINGS}&use=ocean`, prep: (p) => openEditorFor(p, 'p-ocean') },
    { name: '03-editor-rose-1280x800@1.5', size: 'hidpi', url: `${SETTINGS}&use=rose`, prep: (p) => openEditorFor(p, 'p-rose') },
    { name: '04-editor-new-1000x720-scale125', size: 'min125', url: `${SETTINGS}&theme=dark`, prep: (p) => openCreate(p) },
    // The readability nudge: dark text on a dark theme, faint secondary text, a weak label on the accent.
    {
        name: '05-editor-readability-nudge-1366x768', size: 'laptop', url: `${SETTINGS}&theme=dark`,
        prep: async (p) => {
            await openCreate(p);
            await p.locator('.cte-preset[data-preset="forest"]').click();
            await settle(p, 300);
            await setKnob(p, 'text', '#3b4a40');
            await setKnob(p, 'muted', '#26352b');
            await setKnob(p, 'onAccent', '#a5e3ae');
            await p.locator('.cte-row[data-knob="text"]').scrollIntoViewIfNeeded();
            await settle(p, 400);
        },
    },
    // The library tiles in Settings (a custom theme active).
    { name: '06-settings-tiles-ocean-1366x768', size: 'laptop', url: `${SETTINGS}&use=ocean`, prep: async (p) => { await p.locator('.ctl').scrollIntoViewIfNeeded(); await settle(p, 500); } },
    // Example themes applied to the real app.
    { name: '07-ocean-home-1366x768', size: 'laptop', url: 'view=home&use=ocean' },
    { name: '08-ocean-server-1366x768', size: 'laptop', url: 'view=server&use=ocean' },
    { name: '09-rose-home-1366x768', size: 'laptop', url: 'view=home&use=rose' },
    { name: '10-rose-server-1366x768', size: 'laptop', url: 'view=server&use=rose' },
    { name: '11-rose-settings-1366x768', size: 'laptop', url: `${SETTINGS}&use=rose`, prep: async (p) => { await p.locator('.ctl').scrollIntoViewIfNeeded(); await settle(p, 500); } },
    { name: '12-mono-server-1366x768', size: 'laptop', url: 'view=server&use=mono' },
    { name: '13-forest-settings-1920x1080', size: 'large', url: `${SETTINGS}&use=forest` },
    // Share (export) and import.
    {
        name: '14-share-dialog-1366x768', size: 'laptop', url: `${SETTINGS}&use=ocean`,
        prep: async (p) => {
            const tile = p.locator('[data-custom-theme-tile="p-ocean"]');
            await tile.scrollIntoViewIfNeeded();
            await tile.getByRole('button', { name: /^Share / }).click();
            await settle(p, 900);
        },
    },
    {
        name: '15-import-dialog-1366x768', size: 'laptop', url: `${SETTINGS}&use=mono`,
        prep: async (p) => {
            await p.getByRole('button', { name: /Import/ }).first().click();
            await settle(p, 600);
            // A friend's code (built in the page from a theme the harness does not ship).
            const code = await p.evaluate(async () => {
                const m = await import('/src/theme/customTheme.ts');
                return m.encodeShareCode({ v: 1, name: 'Dusk', base: 'dark', glow: true, colors: {
                    bg: '#160f1f', panel: '#1f1530', surface: '#2a1d40', text: '#f3ecff', muted: '#5b4d70',
                    accent: '#f59e6b', onAccent: '#2a1406', danger: '#ff6b8b', border: '#3a2a55' } });
            });
            await p.locator('#cts-paste').fill(code);
            await settle(p, 700);
        },
    },
];

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
const errors = [];
try {
    for (const shot of SHOTS) {
        if (only.length && !only.some((o) => shot.name.startsWith(o))) continue;
        const s = SIZES[shot.size];
        const ctx = await browser.newContext({
            viewport: { width: Math.round(s.width * 100 / s.z), height: Math.round(s.height * 100 / s.z) },
            deviceScaleFactor: s.dsf * s.z / 100,
            reducedMotion: 'reduce',
        });
        const page = await ctx.newPage();
        await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
        page.on('pageerror', (e) => errors.push(`${shot.name}: ${e.message}`));
        await page.goto(`${BASE}?${shot.url}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__booted === true, null, { timeout: 30000 });
        await settle(page, 1800);
        if (shot.prep) await shot.prep(page);
        await page.screenshot({ path: path.join(out, `${shot.name}.png`) });
        console.log('shot', shot.name);
        await ctx.close();
    }
} finally {
    await browser.close();
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
