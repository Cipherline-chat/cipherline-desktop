// "No history on this device" -> Start fresh.
export async function run(page) {
  await page.getByText('Start fresh', { exact: true }).click({ timeout: 60000 });
  await page.waitForTimeout(15000);
}
