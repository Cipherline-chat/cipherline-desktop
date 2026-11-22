// On the REAL done step: the person fixes the bot's access in Discord (the mock's /__fix), presses
// "Retry #files-pictures", and the report is read again. Returns the history report's text.
export default async (page) => {
  const S = process.env.S;
  const MOCK = process.env.DISCORD_MOCK ?? 'http://127.0.0.1:7994';
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK)) throw new Error('loopback mock only');
  await fetch(`${MOCK}/__fix`);
  await page.locator('[data-testid="history-retry"] button').click();
  await page.waitForFunction(() => !!document.querySelector('[data-testid="history-report"]') && !document.querySelector('[data-testid="history-failed"]'), null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${S}/retry-done.png` });
  return await page.evaluate(() => document.querySelector('[data-testid="history-report"]')?.innerText);
};
