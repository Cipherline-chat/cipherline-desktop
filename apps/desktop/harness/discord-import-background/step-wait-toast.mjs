// Wait (up to args[0] s) for the "Import finished" / "Import stopped" toast with NO import view open, screenshot it
// as $S/<args[1]>.png the moment it shows, then press its "See the report" button and return the report's text.
import { shot } from './step-shot.mjs';
export default async (page, { ctx, args }) => {
  const limit = Date.now() + Number(args[0] ?? 300) * 1000;
  let seen = null;
  while (Date.now() < limit) {
    seen = await page.evaluate(() => {
      const t = [...document.querySelectorAll('[role=status], [role=alert], div')].find((e) => /^(Import finished|Import stopped)/.test(e.textContent?.trim() ?? '') && e.querySelector('button'));
      return t ? t.textContent.replace(/\s+/g, ' ').slice(0, 200) : null;
    });
    if (seen) break;
    await page.waitForTimeout(400);
  }
  if (!seen) throw new Error('no toast');
  await shot(page, ctx, `${process.env.S}/${args[1] || 'toast'}.png`);
  const dialogBefore = await page.evaluate(() => !!document.querySelector('[role=dialog]'));
  await page.getByRole('button', { name: /^See the report$/ }).first().click();
  await page.waitForTimeout(2500);
  await shot(page, ctx, `${process.env.S}/${args[1] || 'toast'}-report.png`);
  const report = await page.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' ').slice(0, 500));
  return { toast: seen, dialogBefore, report };
};
