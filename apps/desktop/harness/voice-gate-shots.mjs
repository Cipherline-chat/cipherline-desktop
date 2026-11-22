// Screenshots + keyboard check of the Noise gate row (new engine, manual gate) at the three window sizes.
//   npx vite --config harness/voice-gate.vite.config.ts      (another shell, :5312)
//   node harness/voice-gate-shots.mjs --out=<dir>
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
const out = arg('out', '/tmp/voice-gate-shots');
fs.mkdirSync(out, { recursive: true });
const base = `http://127.0.0.1:${process.env.VG_PORT ?? 5312}/harness/voice-gate.html`;
const SIZES = [['min', 1000, 720], ['laptop', 1366, 768], ['large', 1920, 1080]];
const browser = await chromium.launch({ executablePath: exe, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
let bad = 0;
try {
    for (const [id, width, height] of SIZES) {
        const ctx = await browser.newContext({ viewport: { width, height } });
        await ctx.grantPermissions(['microphone']);
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(String(e)));
        for (const q of ['gate=0', 'gate=1&db=-50']) {
            await page.goto(`${base}?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
            await page.waitForTimeout(2500);
            const row = page.locator('.vv-row').filter({ hasText: /Noise gate|Voice gate/ }).first();
            await row.scrollIntoViewIfNeeded();
            const hs = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
            const sliders = await page.locator('[role=slider][aria-label="Noise gate threshold"]').count();
            const toggle = await page.locator('button[role=switch][aria-label="Noise gate"]').count();
            console.log(id, q, { pageHScroll: hs, noiseGateToggle: toggle, noiseGateSlider: sliders });
            const meter = await page.evaluate(() => { const f = document.querySelector('.vv-gate .sfill'); const d = document.querySelector('.vv-gateval'); return f ? { fillWidth: f.style.width, live: !!d && d.classList.contains('vv-live') } : null; });
            console.log('   meter', meter);
            if (hs) bad++;
            await page.screenshot({ path: `${out}/${id}-${q.replace(/[&=]/g, '_')}.png`, clip: undefined });
        }
        // keyboard: tab to the toggle, Space turns it on, Tab to the slider, arrows move it
        await page.goto(`${base}?gate=0`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForTimeout(1500);
        const tg = page.locator('button[role=switch][aria-label="Noise gate"]').first();
        await tg.focus();
        await page.keyboard.press('Space');
        await page.waitForTimeout(300);
        const sl = page.locator('[role=slider][aria-label="Noise gate threshold"]').first();
        const present = await sl.count();
        let now0 = null, now1 = null, home = null;
        if (present) {
            await sl.focus();
            now0 = await sl.getAttribute('aria-valuenow');
            await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
            now1 = await sl.getAttribute('aria-valuenow');
            await page.keyboard.press('Home');
            home = await sl.getAttribute('aria-valuenow');
        }
        console.log(id, 'keyboard', { toggledOn: !!present, now0, afterTwoRight: now1, home });
        if (!present || Number(now1) !== Number(now0) + 2 || Number(home) !== -80) bad++;
        await page.screenshot({ path: `${out}/${id}-keyboard-home.png` });
        if (errs.length) { console.log('page errors', errs.slice(0, 3)); bad++; }
        await ctx.close();
    }
} finally { await browser.close(); }
process.exit(bad ? 1 : 0);
