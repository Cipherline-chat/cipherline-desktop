// Screenshot the real app as $S/<args[0]>.png (raw CDP capture: never waits on web fonts, which the harness
// blocks) and return the visible text (debugging / evidence).
import fs from 'node:fs';
export async function shot(page, ctx, file) {
  const cdp = await ctx.newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  await cdp.detach().catch(() => undefined);
}
export default async (page, { ctx, args }) => {
  await shot(page, ctx, `${process.env.S}/${args[0] || 'shot'}.png`);
  return await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 900));
};
