// The profile popout OPENED at 1000x720 (it is positioned when it opens; the sizes pass resized an open one).
export default async (page, { ctx }) => {
  const cdp = await ctx.newCDPSession(page);
  const out = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(async (t) => { const m = await import('/src/theme/engine.ts'); await m.setThemePreference(t); }, theme);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 720, deviceScaleFactor: 1, mobile: false });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    await page.getByText('Sammy', { exact: true }).first().click();
    await page.waitForTimeout(1500);
    const file = `${process.env.SHOTS}/5-profile-member-since-${theme}-1000x720.png`;
    await page.screenshot({ path: file });
    const r = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="profile-member-since"]');
      const card = el?.closest('[role=dialog]') ?? el?.parentElement;
      const b = card?.getBoundingClientRect();
      return { visible: !!el, inside: !!b && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight, text: el?.textContent };
    });
    out.push(`${r.visible && r.inside ? 'PASS' : 'FAIL'} 5-profile-member-since ${theme} 1000x720 (opened there) ${JSON.stringify(r)}`);
  }
  await page.keyboard.press('Escape');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(async () => { const m = await import('/src/theme/engine.ts'); await m.setThemePreference('dark'); });
  return out.join('\n');
};
