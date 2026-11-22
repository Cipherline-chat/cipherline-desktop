// Real-app screenshots of the rail indicator at rest on a server, Dark + Light, at the four review sizes.
//   node pw.mjs <cdp> step-shots.mjs <outDir> <serverIndex>
// The viewport is set over CDP (Emulation.setDeviceMetricsOverride) and the theme through the app's own
// applyTheme() (the same module instance the running app uses: Vite dev serves one URL per module).
// For each size+theme it switches DMs -> server (a real click), waits for the indicator to land, and saves
// <outDir>/<theme>-<w>x<h>[@dsf].png plus a mid-flight frame <theme>-<w>x<h>[@dsf]-flight.png.
import fs from 'node:fs';
export default async (page, { ctx, args }) => {
    const [out, srv] = args;
    fs.mkdirSync(out, { recursive: true });
    const cdp = await ctx.newCDPSession(page);
    const SIZES = [{ w: 1000, h: 720, d: 1 }, { w: 1366, h: 768, d: 1 }, { w: 1920, h: 1080, d: 1 }, { w: 1280, h: 800, d: 1.5 }];
    const done = [];
    for (const theme of ['dark', 'light']) {
        await page.evaluate(async (t) => {
            const { applyTheme } = await import('/src/theme/engine.ts');
            const { DARK_THEME, LIGHT_THEME } = await import('/src/theme/themes.ts');
            applyTheme(t === 'light' ? LIGHT_THEME : DARK_THEME);
        }, theme);
        for (const s of SIZES) {
            await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: s.d, mobile: false });
            await page.waitForTimeout(1500);
            const tag = `${theme}-${s.w}x${s.h}${s.d !== 1 ? '@' + s.d : ''}`;
            await page.locator('[data-rail-id="nav:dm"]').click();
            await page.waitForTimeout(1500);
            const tile = page.locator('[data-testid="rail-scroll"] [data-rail-id^="srv:"]').nth(Number(srv)).locator('button').first();
            await tile.scrollIntoViewIfNeeded();
            await page.waitForTimeout(300);
            await tile.click();
            await page.screenshot({ path: `${out}/${tag}-flight.png` });
            await page.waitForTimeout(2500);
            await page.screenshot({ path: `${out}/${tag}.png` });
            const g = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="rail-scroll"] .cl-rail-indicator');
                const tiles = [...document.querySelectorAll('[data-testid="rail-scroll"] [data-rail-id^="srv:"]')];
                return { top: el.style.top, height: el.style.height, width: el.style.width, radius: el.style.borderRadius };
            });
            done.push({ tag, ...g });
        }
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await page.evaluate(async () => {
        const { applyTheme } = await import('/src/theme/engine.ts');
        const { DARK_THEME } = await import('/src/theme/themes.ts');
        applyTheme(DARK_THEME);
    });
    return done;
};
