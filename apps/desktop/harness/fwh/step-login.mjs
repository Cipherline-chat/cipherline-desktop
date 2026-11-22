import fs from 'node:fs';
export default async (page) => {
  const who = JSON.parse(fs.readFileSync(`${process.env.S}/acct.json`, 'utf8'));
  await page.screenshot({ path: `${process.env.S}/before-login.png` });
  await page.locator('input[type="email"], input[placeholder="Email"]').first().fill(who.email, { timeout: 30000 });
  await page.locator('input[type="password"]').first().fill(who.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 90000 });
  await page.waitForTimeout(10000);
  await page.screenshot({ path: `${process.env.S}/after-login.png` });
  return await page.evaluate(() => document.body.innerText.slice(0, 400));
};
