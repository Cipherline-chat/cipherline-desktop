// Sign in through the REAL AuthScreen as args[0] ('alice' | 'bob' from state.json). A new-device login that asks
// for the emailed code gets it from the isolated API's log.
import fs from 'node:fs';
const S = process.env.S;
export default async (page, { args }) => {
  const st = JSON.parse(fs.readFileSync(`${S}/state.json`, 'utf8'));
  const who = st[args[0]];
  const before = fs.readFileSync(`${S}/api.log`, 'utf8').split('┌─ Email to ' + who.email).length - 1;
  await page.locator('input[type="email"], input[placeholder="Email"]').first().fill(who.email, { timeout: 120000 });
  await page.locator('input[type="password"]').first().fill(who.password);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  for (let i = 0; i < 180; i++) {
    if (!(await page.locator('input[type="password"]').count())) break;
    await page.waitForTimeout(1000);
  }
  // Email code step (new device), if shown.
  for (let i = 0; i < 20; i++) {
    const codeBox = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    if (await codeBox.count()) {
      let code = null;
      for (let j = 0; j < 120 && !code; j++) {
        const blocks = fs.readFileSync(`${S}/api.log`, 'utf8').split('┌─ Email to ' + who.email).slice(1);
        if (blocks.length > before) code = blocks[blocks.length - 1].match(/\b(\d{6})\b/)?.[1] ?? null;
        if (!code) await page.waitForTimeout(500);
      }
      if (!code) throw new Error('no login code');
      const n = await codeBox.count();
      if (n >= 6) for (let k = 0; k < 6; k++) await codeBox.nth(k).fill(code[k]);
      else await codeBox.first().fill(code);
      await page.keyboard.press('Enter').catch(() => {});
      break;
    }
    if (await page.locator('nav, [data-testid="server-rail"], [aria-label="Home"]').count()) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(12000);
  await page.screenshot({ path: `${S}/after-login-${args[0]}-${process.argv[2]}.png` });
  return await page.evaluate(() => document.body.innerText.slice(0, 500));
};
