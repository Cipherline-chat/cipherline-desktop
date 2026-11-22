// Right-click the element whose text is exactly args[0]; list the menu items; optionally click one matching args[1].
export default async (page, { args }) => {
  await page.getByText(args[0], { exact: true }).first().click({ button: 'right' });
  await page.waitForTimeout(800);
  const items = await page.evaluate(() => [...document.querySelectorAll('[role=menuitem], .ctxm-row')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()));
  if (args[1]) {
    const re = new RegExp(args[1], 'i');
    await page.locator('[role=menuitem], .ctxm-row').filter({ hasText: re }).first().click();
    await page.waitForTimeout(2000);
    if (args[2]) await page.screenshot({ path: `${process.env.S}/${args[2]}.png` });
  }
  return items.join(' | ');
};
