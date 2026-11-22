// Click a button by its exact accessible name (args[0]), inside the open dialog when there is one.
export default async (page, { args }) => {
  const name = new RegExp(`^${args[0]}$`);
  const inDialog = page.locator('[role=dialog]').getByRole('button', { name });
  await ((await inDialog.count()) ? inDialog : page.getByRole('button', { name })).first().click();
  await page.waitForTimeout(2500);
  return await page.evaluate(() => (document.querySelector('[role=dialog]')?.innerText ?? document.body.innerText).slice(0, 400));
};
