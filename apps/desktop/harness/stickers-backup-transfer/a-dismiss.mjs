// First-run chrome out of the way: storage setup (recommended), any open popover, the keyring banner.
export async function run(page) {
  const rec = page.getByRole('button', { name: 'Use recommended' });
  if (await rec.count()) { await rec.click(); await page.waitForTimeout(1500); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const close = page.locator('[aria-label="Dismiss"], [aria-label="Close banner"], [aria-label="Dismiss banner"]');
  if (await close.count()) await close.first().click().catch(() => {});
  await page.waitForTimeout(1000);
}
