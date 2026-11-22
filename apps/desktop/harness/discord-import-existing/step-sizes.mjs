// Screenshot the CURRENT screen of the real app in Dark + Light at 1000x720, 1366x768, 1920x1080, 1280x800@1.5
// (CDP device metrics on the real window; the theme through the app's own setThemePreference), into
// $SHOTS/<name>-<theme>-<size>.png, and check: no sideways scroll, every [role=dialog] inside the viewport.
//   node pw.mjs <port> step-sizes.mjs <name> [selector that must be visible]
import fs from 'node:fs';
const SIZES = [{ w: 1000, h: 720, d: 1 }, { w: 1366, h: 768, d: 1 }, { w: 1920, h: 1080, d: 1 }, { w: 1280, h: 800, d: 1.5 }];
export default async (page, { ctx, args }) => {
  const name = args[0];
  const must = args[1] || null;
  const out = process.env.SHOTS;
  fs.mkdirSync(out, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const results = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(async (t) => { const m = await import('/src/theme/engine.ts'); await m.setThemePreference(t); }, theme);
    for (const s of SIZES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: s.d, mobile: false });
      await page.waitForTimeout(900);
      const tag = `${s.w}x${s.h}${s.d !== 1 ? '@' + s.d : ''}`;
      const file = `${out}/${name}-${theme}-${tag}.png`;
      await page.screenshot({ path: file });
      const m = await page.evaluate((sel) => {
        const se = document.scrollingElement;
        const dialogs = [...document.querySelectorAll('[role=dialog]')].filter((d) => d.getClientRects().length).map((d) => d.getBoundingClientRect());
        return {
          sideways: se.scrollWidth > window.innerWidth + 1,
          dialogsInside: dialogs.every((r) => r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1),
          must: sel ? !!document.querySelector(sel) && document.querySelector(sel).getClientRects().length > 0 : true,
          theme: document.documentElement.getAttribute('data-theme'),
        };
      }, must);
      results.push({ tag: `${theme} ${tag}`, ok: !m.sideways && m.dialogsInside && m.must && m.theme === theme, ...m });
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(async () => { const m = await import('/src/theme/engine.ts'); await m.setThemePreference('dark'); });
  await page.waitForTimeout(500);
  return results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${name} ${r.tag}${r.ok ? '' : ' ' + JSON.stringify(r)}`).join('\n');
};
