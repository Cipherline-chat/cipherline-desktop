// Click a button by accessible name INSIDE the open dialog (args[0] regex), wait args[1] ms, screenshot args[2].
export default async (page, { args }) => {
  await page.locator('[role=dialog]').last().getByRole('button', { name: new RegExp(args[0], 'i') }).first().click();
  await page.waitForTimeout(Number(args[1] ?? 2000));
  if (args[2]) await page.screenshot({ path: `${process.env.S}/${args[2]}.png` });
  return await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 500));
};
