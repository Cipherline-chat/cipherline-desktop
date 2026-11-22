export default async (page) => {
  for (let i = 0; i < 3 && (await page.locator('.fw-root').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(600); }
  await page.waitForTimeout(1500);
  return 'fw-root=' + (await page.locator('.fw-root').count());
};
