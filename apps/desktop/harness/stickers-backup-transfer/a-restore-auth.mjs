// Fresh device, "No history on this device" -> Restore from backup file: the real file input + passphrase form.
// args: <.enc path> <passphrase>
export async function run(page, [file, pass]) {
  const S = process.env.S;
  await page.getByText('Restore from backup file', { exact: true }).click({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.locator('input[type="file"][accept=".enc"]').setInputFiles(file);
  await page.locator('input[type="password"]').last().fill(pass);
  await page.screenshot({ path: `${S}/restore-form.png` });
  await page.locator('form button[type="submit"]').last().click({ timeout: 30000 });
  // Wait for the dashboard (the form goes away) and the restore to settle.
  for (let i = 0; i < 240; i++) {
    if (!(await page.locator('input[type="file"][accept=".enc"]').count())) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(15000);
}
