// From the pill: open the report -> Open server -> (server-save popup) Done -> the channel named args[0].
// Screenshot $S/channel-<name>.png; returns the visible text lines mentioning "couldn’t be copied".
export default async (page, { args }) => {
  const S = process.env.S;
  await page.locator('[data-testid="import-pill"]').click();
  await page.waitForTimeout(1500);
  await page.locator('[role=dialog]').getByRole('button', { name: /^Open server$/ }).click();
  await page.waitForTimeout(2000);
  const done = page.locator('[role=dialog]').getByRole('button', { name: /^Done$/ });
  if (await done.count()) await done.first().click();
  await page.waitForTimeout(3000);
  await page.getByText(args[0], { exact: true }).first().click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${S}/channel-${args[0]}.png` });
  return await page.evaluate(() => document.body.innerText.split('\n').filter((l) => /couldn’t be copied/.test(l)).slice(0, 5));
};
