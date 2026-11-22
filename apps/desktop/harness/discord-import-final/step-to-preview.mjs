// The REAL wizard up to its preview step (Create or Join Server -> Create Server -> Import from a Discord server ->
// token -> invite step -> Preview). Nothing is created.
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'harness-token-for-the-mock-only-0123456789'].join('.');
export default async (page) => {
  await page.locator('[title="Create or Join Server"]').first().click();
  await page.getByRole('button', { name: /^Create Server$/ }).click();
  await page.getByRole('button', { name: /Import from a Discord server/ }).click();
  await page.waitForTimeout(1500);
  const pw = page.locator('[role=dialog] input[type="password"]');
  if (await pw.count()) { await pw.first().fill(TOKEN); await page.getByRole('button', { name: /Check token/ }).click(); await page.waitForTimeout(3000); }
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await page.waitForTimeout(3000);
  await page.locator('[role=dialog] [role=radio]').first().click();
  await page.getByRole('button', { name: /^Preview$/ }).click();
  await page.waitForTimeout(5000);
  // Scroll the "Also copy" group into view (icon, emojis, stickers).
  await page.locator('[role=group][aria-label="Also copy"]').scrollIntoViewIfNeeded();
  return await page.evaluate(() => document.querySelector('[role=group][aria-label="Also copy"]')?.textContent);
};
