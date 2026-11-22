// args: <ms> — open the game (if closed), play <ms>, close it, then print the probe's dev text report
// (window.__fwHitchReport) and the firewall rows it wrote to the Performance log (what Report a problem sends).
export default async (page, { args }) => {
  const ms = Number(args[0] ?? 15000);
  if (!(await page.locator('.fw-root').count())) throw new Error('open the game first (step-open.mjs)');
  await page.locator('.fw-root').focus().catch(() => {});
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await page.keyboard.press('Space'); await page.waitForTimeout(360 + Math.random() * 100); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500);
  const out = await page.evaluate(async () => {
    const rep = window.__fwHitchReport ?? '(no report)';
    const log = (await window.electronAPI?.perfGetLog?.()) ?? [];
    const rows = log.filter((r) => /firewall:/.test(r.activity)).slice(0, 14).map((r) => `${r.ms}ms ${r.activity}`);
    return { rep, rows };
  });
  return `${out.rep.split('\n').slice(0, 16).join('\n')}\n...\nPerformance-log rows:\n${out.rows.join('\n')}`;
};
