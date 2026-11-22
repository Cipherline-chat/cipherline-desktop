// Open the failed send's "!" popover (the reason) in the real ChatPane; return its text.
export default async (page) => {
  await page.locator('[data-testid="undelivered-indicator"]').last().click();
  await page.waitForTimeout(800);
  return await page.locator('[data-testid="undelivered-popover"]').textContent();
};
