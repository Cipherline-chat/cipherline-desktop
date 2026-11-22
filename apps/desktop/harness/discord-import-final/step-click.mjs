// Click the visible control whose accessible name / text matches args[0] (a regex), wait args[1] ms, screenshot as args[2].
export default async (page, { args }) => {
  const re = new RegExp(args[0], 'i');
  const wait = Number(args[1] ?? 3000);
  const cands = page.locator('button, [role=button], [role=menuitem], [role=radio], [role=checkbox], [role=tab], a');
  const n = await cands.count();
  let clicked = null;
  for (let i = 0; i < n; i++) {
    const el = cands.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const name = ((await el.getAttribute('aria-label')) || (await el.innerText().catch(() => '')) || (await el.getAttribute('title')) || '').trim();
    if (re.test(name)) { await el.click(); clicked = name; break; }
  }
  if (!clicked) throw new Error(`nothing visible matches ${re}`);
  await page.waitForTimeout(wait);
  if (args[2]) await page.screenshot({ path: `${process.env.S}/${args[2]}.png` });
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 700));
  return `clicked "${clicked.slice(0, 60)}" :: ${txt}`;
};
