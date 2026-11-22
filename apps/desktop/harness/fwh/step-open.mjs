// Dismiss first-run dialogs, then spam-click Home's Keys until the Firewall overlay opens.
export default async (page) => {
  const rec = page.getByRole('button', { name: /Use recommended/ });
  if (await rec.count()) await rec.first().click().catch(() => {});
  await page.waitForTimeout(1500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  if (await page.locator('.fw-root').count()) return 'already open';
  const hk = page.locator('.hk').first();
  await hk.waitFor({ timeout: 20000 });
  const box = await hk.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  for (let i = 0; i < 40 && !(await page.locator('.fw-root').count()); i++) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${process.env.S}/open.png` });
  return `fw-root=${await page.locator('.fw-root').count()} ready=${await page.locator('.fw-root.is-ready').count()}`;
};
