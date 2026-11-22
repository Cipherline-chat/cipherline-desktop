// The failed slowmode send at 1366x768 and 1000x720, Dark + Light: the "!" scrolled into view and its reason
// popover opened AT that size (a popover is positioned when it opens). $SHOTS/realapp-slowmode-failed-*.png
const SIZES = [{ w: 1366, h: 768 }, { w: 1000, h: 720 }];
export default async (page, { ctx }) => {
  const cdp = await ctx.newCDPSession(page);
  const out = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(async (t) => { const m = await import('/src/theme/engine.ts'); await m.setThemePreference(t); }, theme);
    for (const s of SIZES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      const bang = page.locator('[data-testid="undelivered-indicator"]').last();
      await bang.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await bang.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${process.env.SHOTS}/realapp-slowmode-failed-${theme}-${s.w}x${s.h}.png` });
      const r = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="undelivered-popover"]');
        const b = p?.getBoundingClientRect();
        return { text: p?.textContent, inside: !!b && b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight };
      });
      out.push(`${/Slowmode: wait \d:\d\d/.test(r.text ?? '') && r.inside ? 'PASS' : 'FAIL'} ${theme} ${s.w}x${s.h} ${r.text}`);
    }
  }
  await page.keyboard.press('Escape');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(async () => { const m = await import('/src/theme/engine.ts'); await m.setThemePreference('dark'); });
  return out.join('\n');
};
