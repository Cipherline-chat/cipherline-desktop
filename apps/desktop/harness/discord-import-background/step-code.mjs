// The sign-in email code (read from the isolated API's log, where the dev mailer prints it), typed into the REAL form.
import fs from 'node:fs';
import { shot } from './step-shot.mjs';
export default async (page, { ctx, args }) => {
  const st = JSON.parse(fs.readFileSync(`${process.env.S}/../state.json`, 'utf8'));
  const email = st[args[0]].email;
  const dir = `${process.env.S}/..`;
  const log = fs.readdirSync(dir).filter((f) => /^api\d*\.log$/.test(f)).sort().map((f) => fs.readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
  const blocks = log.split('┌─ Email to ').slice(1).filter((b) => b.startsWith(email));
  const code = blocks[blocks.length - 1].match(/\b(\d{6})\b/)[1];
  const inputs = page.locator('input');
  const n = await inputs.count();
  if (n >= 6) { for (let i = 0; i < 6; i++) await inputs.nth(i).fill(code[i]); }
  else await inputs.first().fill(code);
  const btn = page.getByRole('button', { name: /Verify and sign in/ });
  if (await btn.isEnabled().catch(() => false)) await btn.click().catch(() => undefined);
  await page.waitForTimeout(15000);
  await shot(page, ctx, `${process.env.S}/after-code-${args[0]}.png`);
  return await page.evaluate(() => document.body.innerText.slice(0, 800));
};
