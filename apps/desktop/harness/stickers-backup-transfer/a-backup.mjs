// Settings -> Storage (already open): passphrase, Local folder on (the folder picker answers with $S/backup via
// main-redirect.cjs), Back up now; waits for the .enc file to appear. args: <passphrase>
import fs from 'node:fs';
export async function run(page, [pass]) {
  const S = process.env.S;
  fs.mkdirSync(`${S}/backup`, { recursive: true });
  fs.writeFileSync(`${S}/pick-${process.env.PICK_NAME || 'alice'}.txt`, `${S}/backup`);
  await page.locator('input[placeholder="Choose a strong passphrase"]').fill(pass);
  await page.waitForTimeout(1500);
  const choose = page.getByRole('button', { name: 'Choose', exact: true });
  if (!(await choose.count())) {
    // Turning "Local folder" on reveals its Choose button.
    await page.locator('div', { hasText: /^Local folder/ }).locator('[role="switch"], button, input[type="checkbox"]').last().click({ timeout: 30000 });
    await page.waitForTimeout(1500);
  }
  await choose.click({ timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Back up now', exact: true }).click({ timeout: 30000 });
  for (let i = 0; i < 240; i++) {
    const files = fs.readdirSync(`${S}/backup`).filter((f) => f.endsWith('.enc'));
    if (files.length && i > 5) {
      const busy = await page.getByRole('button', { name: /Backing up/ }).count();
      if (!busy) return { files: files.map((f) => `${f} ${fs.statSync(`${S}/backup/${f}`).size}B`) };
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('no backup file');
}
