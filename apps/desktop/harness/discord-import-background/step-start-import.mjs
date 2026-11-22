// The REAL Dashboard flow up to "Import server" (Create or Join Server -> Create Server -> Import from a Discord
// server -> token (saved by main, or pasted) -> pick the server -> Preview -> [args[0] = new server name] ->
// Continue -> consent -> Import server), then waits only until the run view shows. Returns its text.
import { shot } from './step-shot.mjs';
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'harness-token-for-the-mock-only-0123456789'].join('.');
export default async (page, { ctx, args }) => {
  const S = process.env.S;
  await page.locator('[title="Create or Join Server"]').first().click();
  await page.getByRole('button', { name: /^Create Server$/ }).click();
  await page.getByRole('button', { name: /Import from a Discord server/ }).click();
  await page.waitForTimeout(1500);
  const pw = page.locator('[role=dialog] input[type="password"]');
  if (await pw.count()) { await pw.first().fill(TOKEN); await page.getByRole('button', { name: /Check token/ }).click(); await page.waitForTimeout(3000); }
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await page.waitForTimeout(3000);
  await page.locator('[role=dialog] [role=radio]').first().click();
  await page.getByRole('button', { name: /^Preview$/ }).click();
  await page.waitForFunction(() => /New server name/.test(document.querySelector('[role=dialog]')?.textContent ?? ''), null, { timeout: 60000 });
  if (args[0]) {
    const nameBox = page.locator('[role=dialog] input').first();
    await nameBox.fill(args[0]);
  }
  await shot(page, ctx, `${S}/${args[1] || 'start'}-preview.png`);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await page.waitForTimeout(1200);
  const boxes = page.locator('[role=dialog] [role=checkbox]');
  for (let i = 0; i < await boxes.count(); i++) if ((await boxes.nth(i).getAttribute('aria-checked')) !== 'true') await boxes.nth(i).click();
  await page.getByRole('button', { name: /^Import server/ }).click();
  await page.waitForSelector('[data-testid="run-label"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await shot(page, ctx, `${S}/${args[1] || 'start'}-run.png`);
  return await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' '));
};
