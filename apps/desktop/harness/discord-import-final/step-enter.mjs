// Press Enter in the composer (sends whatever is typed there), wait args[0] ms.
export default async (page, { args }) => {
  await page.locator('[contenteditable="true"], textarea').last().click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(Number(args[0] ?? 2500));
  return 'sent';
};
