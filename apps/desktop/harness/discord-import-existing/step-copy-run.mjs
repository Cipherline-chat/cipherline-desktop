// On the REAL mapping step: Continue -> tick the three consent boxes -> "Copy messages" -> wait for the
// report. args[0] = 'consent-only' stops at the ticked consent step (for screenshots). Returns the dialog text.
export default async (page, { args }) => {
  const S = process.env.S;
  const dlg = page.locator('[role=dialog]');
  if (await dlg.locator('[data-testid="copy-map"]').count()) {
    await dlg.getByRole('button', { name: /^Continue$/ }).click();
    await page.waitForTimeout(1200);
  }
  const boxes = dlg.locator('[role=checkbox]');
  for (let i = 0; i < await boxes.count(); i++) if ((await boxes.nth(i).getAttribute('aria-checked')) !== 'true') await boxes.nth(i).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${S}/copy-consent.png` });
  if (args[0] === 'consent-only') return await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' '));
  await dlg.getByRole('button', { name: /^Copy messages$/ }).click();
  await page.waitForSelector('[data-testid="copy-done"], [data-testid="history-failed"]', { timeout: 240000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${S}/copy-done.png` });
  return await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' '));
};
