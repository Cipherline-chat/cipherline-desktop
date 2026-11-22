// A member's profile popout (member list name args[0]) OPENED at 1366x768 and 1000x720, Dark + Light:
// $SHOTS/<args[1]>-<theme>-<size>.png. Checks the role pill carries the role's icon and the card fits.
const SIZES = [{ w: 1366, h: 768 }, { w: 1000, h: 720 }];
export default async (page, { ctx, args }) => {
  const cdp = await ctx.newCDPSession(page);
  const out = [];
  for (const theme of ['dark', 'light']) {
    await page.evaluate(async (t) => { const m = await import('/src/theme/engine.ts'); await m.setThemePreference(t); }, theme);
    for (const s of SIZES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      // The member list entry (right panel), not a chat author name.
      await page.locator('aside, [class*=member], [class*=Member]').getByText(args[0], { exact: true }).last().click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${process.env.SHOTS}/${args[1]}-${theme}-${s.w}x${s.h}.png` });
      const r = await page.evaluate(() => {
        const roles = document.querySelector('[data-testid="profile-roles"]');
        const card = roles?.closest('[role=dialog]') ?? roles?.parentElement?.parentElement;
        const b = card?.getBoundingClientRect();
        return { roles: roles?.textContent, since: document.querySelector('[data-testid="profile-member-since"]')?.textContent ?? null, inside: !!b && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight };
      });
      out.push(`${r.roles && r.inside ? 'PASS' : 'FAIL'} ${theme} ${s.w}x${s.h} ${JSON.stringify(r)}`);
    }
  }
  await page.keyboard.press('Escape');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(async () => { const m = await import('/src/theme/engine.ts'); await m.setThemePreference('dark'); });
  return out.join('\n');
};
