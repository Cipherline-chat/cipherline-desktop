// Sign in through the REAL AuthScreen as the account named in args[0] (state.json from setup.mjs).
import fs from 'node:fs';
export default async (page, { args }) => {
  const st = JSON.parse(fs.readFileSync(`${process.env.S}/../state.json`, 'utf8'));
  const who = st[args[0]];
  await page.locator('input[type="email"], input[placeholder="Email"]').first().fill(who.email);
  await page.locator('input[type="password"]').first().fill(who.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  // Dashboard: the server rail / Home appears; new-device setup runs on its own (proof-of-possession).
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 90000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${process.env.S}/after-login-${args[0]}.png` });
  return await page.evaluate(() => document.body.innerText.slice(0, 600));
};
