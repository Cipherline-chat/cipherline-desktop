// On the REAL report: the person gives the bot access to #memes in Discord (the mock's /__fix) and presses Retry.
//   args[0]: 'all' (the old single "Retry N channels" / the new "Retry all") or a channel name (the new per-channel
//   "Retry #name"). Waits for the run to finish; returns the report's text. Screenshot $S/retry-<arg>.png.
export default async (page, { args }) => {
  const S = process.env.S;
  const MOCK = process.env.DISCORD_MOCK ?? 'http://127.0.0.1:8014';
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(MOCK)) throw new Error('loopback mock only');
  await fetch(`${MOCK}/__fix`);
  const which = args[0] ?? 'all';
  const btn = which === 'all'
    ? page.locator('[data-testid="history-retry"] button')
    : page.locator('[data-testid="history-retry-one"] button', { hasText: `Retry #${which}` });
  await btn.first().click();
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !!document.querySelector('[data-testid="history-report"]') && !/Copying|Reading/.test(document.querySelector('[data-testid="run-label"]')?.textContent ?? ''), null, { timeout: 180000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${S}/retry-${which}.png` });
  return await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' '));
};
