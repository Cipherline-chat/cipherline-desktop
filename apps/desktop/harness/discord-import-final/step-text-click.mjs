// Click the first visible element whose own text is exactly args[0]; wait args[1] ms; screenshot args[2].
export default async (page, { args }) => {
  await page.getByText(args[0], { exact: true }).first().click();
  await page.waitForTimeout(Number(args[1] ?? 3000));
  if (args[2]) await page.screenshot({ path: `${process.env.S}/${args[2]}.png` });
  return await page.evaluate(() => document.querySelector('main, [role=main]')?.textContent?.replace(/\s+/g, ' ').slice(0, 800) ?? document.body.innerText.replace(/\s+/g, ' ').slice(0, 800));
};
