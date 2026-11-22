// Slowmode in the REAL ChatPane as a plain member: send one message, look at the composer (countdown strip, send
// chip), try to send again at once, then (args[0] = "reload") reload the window and send within the window so the
// SERVER refuses it (429 SLOWMODE_ACTIVE) and the failed state appears. Screenshots: $S/sm-*.png. Returns findings.
export default async (page, { args }) => {
  const S = process.env.S;
  const box = () => page.locator('[contenteditable="true"], textarea').last();
  const composerText = () => page.evaluate(() => {
    const c = document.querySelector('[contenteditable="true"], textarea')?.closest('form, [class*=composer], [class*=Composer]') ?? document.querySelector('footer');
    return (c?.parentElement?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 300);
  });
  const out = {};
  if (args[0] !== 'reload-only') {
    await box().click();
    await page.keyboard.type('First one through the gate');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${S}/sm-after-first.png` });
    out.afterFirst = await composerText();
    await box().click();
    await page.keyboard.type('Too soon?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${S}/sm-second-try.png` });
    out.afterSecond = await composerText();
  }
  if (args[0] === 'reload' || args[0] === 'reload-only') {
    await page.reload({ timeout: 120000 });
    await page.waitForTimeout(20000);
    await page.getByText('general', { exact: true }).first().click();
    await page.waitForTimeout(5000);
    await box().click();
    await page.keyboard.type('Sent after a reload');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${S}/sm-after-reload-send.png` });
    out.afterReload = await page.evaluate(() => document.querySelector('main, [role=main]')?.textContent?.replace(/\s+/g, ' ').slice(-300));
  }
  return out;
};
