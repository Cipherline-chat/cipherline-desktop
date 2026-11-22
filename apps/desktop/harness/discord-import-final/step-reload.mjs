// Reload the real app window (after the harness Vite restarted), then wait for the Dashboard.
export default async (page) => {
  await page.reload({ timeout: 120000 });
  await page.waitForTimeout(25000);
  await page.screenshot({ path: `${process.env.S}/reloaded.png` });
  return await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300));
};
