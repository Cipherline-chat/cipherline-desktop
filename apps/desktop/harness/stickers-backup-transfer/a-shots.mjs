// Screenshots of what came back on THIS device, per theme and window size, into the repo's shots folder:
//   <prefix>-<theme>-<w>x<h>-dm.png        the DM with the old sticker messages (a friend's + my own)
//   <prefix>-<theme>-<w>x<h>-picker.png    the sticker picker: Recent + My stickers
//   <prefix>-<theme>-<w>x<h>-settings.png  Settings -> Activity & Style -> My stickers
// args: <prefix> <Dark|Light> <friend name>
const OUT = '/home/antigravity/Cipherline/.claude/worktrees/agent-aba7591839d9acd19/docs/worklog/shots/stickers-backup-transfer';
const SIZES = [[1366, 768], [1000, 720]];

async function size(page, w, h) {
  // Electron's CDP has no Browser.setWindowBounds; the renderer viewport is set to exactly w x h instead.
  const s = await page.context().newCDPSession(page);
  await s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await page.waitForTimeout(1500);
}
async function settingsOpen(page) { return (await page.getByRole('button', { name: 'Appearance', exact: true }).count()) > 0; }
async function openSettings(page) {
  if (!(await settingsOpen(page))) { await page.locator('button').nth(5).click(); await page.waitForTimeout(2500); }
}
async function closeSettings(page) {
  for (let i = 0; i < 3 && (await settingsOpen(page)); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(1200); }
}

export async function run(page, [prefix, theme, friend]) {
  fs_mkdir();
  await openSettings(page);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.waitForTimeout(1500);
  await page.locator('button', { hasText: new RegExp(`^${theme}`) }).first().click();
  await page.waitForTimeout(2500);
  const taken = [];
  for (const [w, h] of SIZES) {
    await size(page, w, h);
    const base = `${OUT}/${prefix}-${theme.toLowerCase()}-${w}x${h}`;
    // Settings -> Activity & Style -> My stickers
    await openSettings(page);
    await page.getByRole('button', { name: 'Activity & Style', exact: true }).click();
    await page.waitForTimeout(2000);
    const card = page.locator('[aria-label="My stickers"]').first();
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${base}-settings.png` }); taken.push(`${base}-settings.png`);
    await closeSettings(page);
    // The DM
    await page.locator('button').nth(1).click(); await page.waitForTimeout(1500);
    await page.getByText(friend, { exact: true }).first().click(); await page.waitForTimeout(3000);
    await page.screenshot({ path: `${base}-dm.png` }); taken.push(`${base}-dm.png`);
    // The picker
    await page.getByRole('button', { name: 'Stickers', exact: true }).click(); await page.waitForTimeout(2500);
    await page.screenshot({ path: `${base}-picker.png` }); taken.push(`${base}-picker.png`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(800);
  }
  return taken.map((p) => p.split('/').pop()).join('\n');
}
import fs from 'node:fs';
function fs_mkdir() { fs.mkdirSync(OUT, { recursive: true }); }
