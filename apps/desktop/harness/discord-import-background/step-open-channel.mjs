// Open rail server args[0] (by its rail title) and its channel args[1]; optionally type + send args[2] there.
// Returns the pill text and the last lines of the open channel.
export default async (page, { args }) => {
  await page.locator(`nav [title="${args[0]}"], nav img[alt="${args[0]}"]`).first().click();
  await page.waitForTimeout(1500);
  await page.locator('nav, aside, body').getByText(args[1], { exact: true }).first().click();
  await page.waitForTimeout(2500);
  if (args[2]) {
    const box = page.locator('[contenteditable="true"], textarea').last();
    await box.click();
    await page.keyboard.type(args[2], { delay: 20 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
  }
  return await page.evaluate(() => ({
    pill: document.querySelector('[data-testid="import-pill"]')?.textContent ?? null,
    tail: (document.querySelector('main, [role=main]') ?? document.body).textContent.replace(/\s+/g, ' ').slice(-300),
  }));
};
