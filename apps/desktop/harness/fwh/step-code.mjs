import fs from 'node:fs';
export default async (page) => {
  const who = JSON.parse(fs.readFileSync(`${process.env.S}/acct.json`, 'utf8'));
  const blocks = fs.readFileSync(`${process.env.S}/api.log`, 'utf8').split('┌─ Email to ').slice(1).filter((b) => b.startsWith(who.email));
  const code = blocks[blocks.length - 1].match(/\b(\d{6})\b/)[1];
  const inputs = page.locator('input');
  const n = await inputs.count();
  if (n >= 6) { for (let i = 0; i < 6; i++) await inputs.nth(i).fill(code[i]); }
  else { await inputs.first().click(); await page.keyboard.type(code, { delay: 60 }); }
  const btn = page.getByRole('button', { name: /Verify/ });
  if (await btn.isEnabled().catch(() => false)) await btn.click().catch(() => {});
  await page.waitForTimeout(20000);
  await page.screenshot({ path: `${process.env.S}/after-code.png` });
  return await page.evaluate(() => document.body.innerText.slice(0, 300));
};
