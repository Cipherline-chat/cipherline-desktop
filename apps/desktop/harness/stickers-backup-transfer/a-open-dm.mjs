// Open the DM with the friend named args[0] from Home's Friends card (a profile card's "Message" if one opens).
export async function run(page, [friend]) {
  const banner = page.locator('div', { hasText: /^No system keyring found/ }).locator('button').last();
  if (await banner.count()) await banner.click().catch(() => {});
  await page.getByText(friend, { exact: true }).first().click({ timeout: 30000 });
  await page.waitForTimeout(2500);
  const msg = page.getByRole('button', { name: /^(Message|Send message)$/ });
  if (await msg.count()) { await msg.first().click(); await page.waitForTimeout(2500); }
  await page.waitForTimeout(3000);
}
