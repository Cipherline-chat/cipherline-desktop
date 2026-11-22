// The whole REAL Dashboard flow: Create or Join Server -> Create Server -> Import from a Discord server -> token
// (already saved by main, or pasted) -> invite step (pick the server) -> Preview -> Continue -> consent -> Import
// server -> the done step. Returns the done step's text.
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'harness-token-for-the-mock-only-0123456789'].join('.');
export default async (page) => {
  const S = process.env.S;
  const byTitle = (t) => page.locator(`[title="${t}"]`).first();
  await byTitle('Create or Join Server').click();
  await page.getByRole('button', { name: /^Create Server$/ }).click();
  await page.getByRole('button', { name: /Import from a Discord server/ }).click();
  await page.waitForTimeout(1500);
  const pw = page.locator('[role=dialog] input[type="password"]');
  if (await pw.count()) { await pw.first().fill(TOKEN); await page.getByRole('button', { name: /Check token/ }).click(); await page.waitForTimeout(3000); }
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await page.waitForTimeout(3000);
  await page.locator('[role=dialog] [role=radio]').first().click();
  await page.getByRole('button', { name: /^Preview$/ }).click();
  await page.waitForTimeout(5000);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await page.waitForTimeout(1500);
  // Consent: the structure box, and (messages on) the members + content boxes.
  const boxes = page.locator('[role=dialog] [role=checkbox]');
  for (let i = 0; i < await boxes.count(); i++) if ((await boxes.nth(i).getAttribute('aria-checked')) !== 'true') await boxes.nth(i).click();
  await page.screenshot({ path: `${S}/import-consent.png` });
  await page.getByRole('button', { name: /^Import server/ }).click();
  await page.waitForFunction(() => /is ready\.|Keep these messages|Stop copying|Something went wrong/.test(document.querySelector('[role=dialog]')?.textContent ?? '') && !/Copying|Reading|Posting|Building|Adding/.test(document.querySelector('[role=dialog] [role=progressbar]')?.getAttribute('aria-valuetext') ?? ''), null, { timeout: 240000 });
  await page.waitForTimeout(4000);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${S}/import-done.png` });
  return await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' '));
};
