// Open channel args[0] in the real app and either send text args[1] (Enter) or, with args[1] = "sticker:<name>",
// send that server sticker from the composer's sticker picker. Screenshot as args[2].
export default async (page, { args }) => {
  const S = process.env.S;
  await page.locator('nav, aside, body').getByText(args[0], { exact: true }).first().click();
  await page.waitForTimeout(3000);
  const gate = page.getByRole('button', { name: /I am 18 or older|I'm 18|Continue/i });
  const out = [];
  if (await page.getByText(/18 or older/i).first().isVisible().catch(() => false)) out.push('GATE shown');
  if (args[1].startsWith('sticker:')) {
    await page.getByRole('button', { name: /^Stickers?$/ }).first().click();
    await page.waitForTimeout(2000);
    const name = args[1].slice(8);
    await page.locator(`[role=gridcell][aria-label^="Send sticker ${name}"]`).first().click();
  } else {
    const box = page.locator('[contenteditable="true"], textarea').last();
    await box.click();
    await page.keyboard.type(args[1]);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(4000);
  if (args[2]) await page.screenshot({ path: `${S}/${args[2]}.png` });
  void gate;
  out.push(await page.evaluate(() => document.querySelector('main, [role=main]')?.textContent?.replace(/\s+/g, ' ').slice(-400) ?? ''));
  return out.join(' :: ');
};
