// "Copy messages from Discord" through the REAL UI: right-click the server in the rail -> "Copy messages from
// Discord" -> the token step (already saved by main) -> pick the Discord server -> "Choose channels" -> the
// mapping step. Returns the mapping step's text. args[0] = the server's name (for the log), args[1] = which server tile (0 = first).
export default async (page, { args }) => {
  const S = process.env.S;
  const name = args[0];
  // Server tiles in the rail carry the Alt+Arrow reorder shortcut; args[1] picks the nth (0 = first server).
  const tile = page.locator('button[aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]').nth(Number(args[1] ?? 0));
  await tile.click({ button: 'right' });
  await page.waitForTimeout(800);
  await page.getByText('Copy messages from Discord', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  await page.locator('[role=dialog]').getByRole('button', { name: /^Continue$/ }).click();
  await page.waitForTimeout(3000);
  await page.locator('[role=dialog] [role=radio]').first().click();
  await page.locator('[role=dialog]').getByRole('button', { name: /^Choose channels$/ }).click();
  await page.waitForSelector('[data-testid="copy-map"]', { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${S}/copy-map.png` });
  return await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' '));
};
