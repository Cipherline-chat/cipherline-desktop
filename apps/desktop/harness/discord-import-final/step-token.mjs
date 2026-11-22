// Page one of the REAL wizard: paste the (mock) bot token and Check token. The token goes to main over the
// preload bridge; main calls the loopback mock Discord.
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'harness-token-for-the-mock-only-0123456789'].join('.');
export default async (page) => {
  await page.locator('input[type="password"]').first().fill(TOKEN);
  await page.getByRole('button', { name: /Check token/ }).click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${process.env.S}/wizard-token.png` });
  return await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' ').slice(0, 900));
};
