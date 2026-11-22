// The REAL import flow (see step-import.mjs), but the person presses "Keep using Cipherline" as soon as it starts,
// so it finishes with nothing on screen: waits for the finish toast and returns its text + the pill's.
// Screenshots $S/bg-running.png (pill while importing) and $S/bg-finished.png (toast + pill).
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
  const boxes = page.locator('[role=dialog] [role=checkbox]');
  for (let i = 0; i < await boxes.count(); i++) if ((await boxes.nth(i).getAttribute('aria-checked')) !== 'true') await boxes.nth(i).click();
  await page.getByRole('button', { name: /^Import server/ }).click();
  await page.getByRole('button', { name: /^Keep using Cipherline$/ }).first().click({ timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${S}/bg-running.png` });
  await page.waitForFunction(() => /issues found|Import finished|Import stopped/.test(document.body.innerText), null, { timeout: 300000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${S}/bg-finished.png` });
  return await page.evaluate(() => ({
    pill: document.querySelector('[data-testid="import-pill"]')?.textContent,
    pillClass: document.querySelector('[data-testid="import-pill"]')?.className,
    toast: [...document.querySelectorAll('[role=status], [role=alert]')].map((n) => n.textContent).filter((t) => /issues found/.test(t ?? '')).join(' | '),
  }));
};
