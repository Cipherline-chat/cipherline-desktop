// Create a plain server named args[0] through the REAL "Create a Server" dialog (something to switch to while an
// import runs).
export default async (page, { args }) => {
  await page.locator('[title="Create or Join Server"]').first().click();
  await page.getByRole('button', { name: /^Create Server$/ }).click();
  await page.locator('[role=dialog] input').first().fill(args[0]);
  await page.getByRole('button', { name: /^Create server$/ }).click();
  await page.waitForTimeout(6000);
  return await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300));
};
