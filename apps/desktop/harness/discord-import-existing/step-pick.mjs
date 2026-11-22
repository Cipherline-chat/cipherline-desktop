// On the REAL mapping step: leave ticked ONLY the Discord channels named in args (comma list). Returns the rows.
export default async (page, { args }) => {
  const keep = new Set(String(args[0] ?? '').split(',').filter(Boolean));
  const rows = page.locator('[data-testid="copy-row"]');
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i);
    const box = row.locator('[role=checkbox]').first();
    const label = (await row.innerText()).split('\n')[0].trim();
    const on = (await box.getAttribute('aria-checked')) === 'true';
    const disabled = (await box.getAttribute('aria-disabled')) === 'true' || (await box.isDisabled().catch(() => false));
    if (!disabled && on !== keep.has(label)) await box.click();
  }
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${process.env.S}/copy-picked.png` });
  return await page.evaluate(() => [...document.querySelectorAll('[data-testid="copy-row"]')].map(r => `${r.getAttribute('data-status')} ${r.querySelector('[role=checkbox]')?.getAttribute('aria-checked')} ${r.innerText.split('\n')[0]}`).join('\n') + '\n' + document.querySelector('[data-testid="copy-picked"]')?.textContent);
};
