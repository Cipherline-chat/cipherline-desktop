// Generic step: run the action module named in args[0] (a file in this folder exporting `run(page, args)`),
// then screenshot to $S/<label>.png and return the visible text head. Keeps each UI step small and re-runnable.
const S = process.env.S;
export default async (page, { args }) => {
  const [mod, label, ...rest] = args;
  const m = await import(new URL(`./${mod}?t=${Date.now()}`, import.meta.url).href);
  const out = await m.run(page, rest);
  await page.waitForTimeout(1500);
  if (label && label !== '-') await page.screenshot({ path: `${S}/${label}.png` });
  return out ?? (await page.evaluate(() => document.body.innerText.slice(0, 300)));
};
