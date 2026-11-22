// Reload the renderer (Ctrl+R) and wait for it to settle.
export async function run(page) {
  await page.reload();
  await page.waitForTimeout(25000);
}
