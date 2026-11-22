// In the open REAL channel settings dialog: Slowmode -> args[0] (e.g. "30 seconds"), screenshot, Save.
export default async (page, { args }) => {
  const dlg = page.locator('[role=dialog]').last();
  const row = dlg.getByText('Slowmode', { exact: true }).locator('xpath=ancestor::*[.//button or .//select][1]');
  const sel = row.locator('select');
  if (await sel.count()) await sel.first().selectOption({ label: args[0] });
  else {
    await row.locator('button').last().click();
    await page.waitForTimeout(500);
    await page.getByRole('option', { name: new RegExp(`^${args[0]}$`, 'i') }).first().click();
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${process.env.S}/slowmode-set.png` });
  await dlg.getByRole('button', { name: /^Save/ }).click();
  await page.waitForTimeout(2500);
  return await page.evaluate(() => document.querySelector('header, [class*=chat-head]')?.textContent?.slice(0, 200) ?? '');
};
