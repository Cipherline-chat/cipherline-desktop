// After the first sign-in on this device: "Start fresh" (no history to restore in a throwaway account).
export default async (page) => {
  await page.getByText('Start fresh').first().click();
  await page.waitForTimeout(1500);
  const go = page.getByRole('button', { name: /^(Continue|Start fresh|Get started|Done)$/ });
  if (await go.count()) await go.first().click().catch(() => undefined);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${process.env.S}/after-fresh.png` });
  return await page.evaluate(() => document.body.innerText.slice(0, 600));
};
