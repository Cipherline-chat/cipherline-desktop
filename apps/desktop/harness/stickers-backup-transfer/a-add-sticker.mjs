// In the open conversation: Stickers button -> "+ Add" (the picker's own file input) -> Add a sticker dialog ->
// "Add sticker". args: <image path> [send]  ("send" then sends it from the picker).
export async function run(page, [file, send]) {
  const S = process.env.S;
  await page.getByRole('button', { name: 'Stickers', exact: true }).click({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('[aria-label="Sticker picker"] input[type="file"]').setInputFiles(file);
  const add = page.getByRole('button', { name: 'Add sticker', exact: true });
  await add.waitFor({ timeout: 60000 });
  for (let i = 0; i < 120 && !(await add.isEnabled()); i++) await page.waitForTimeout(500);
  await page.screenshot({ path: `${S}/add-dialog-${file.split('/').pop()}.png` });
  await add.click();
  await page.waitForTimeout(3000);
  const name = file.split('/').pop().replace(/\.png$/, '');
  if (send === 'send') {
    await page.locator(`[aria-label="Sticker picker"] [aria-label^="Send sticker"][aria-label*="${name}"]`).first().click({ timeout: 30000 });
    await page.waitForTimeout(4000);
  } else {
    await page.keyboard.press('Escape');
  }
}
