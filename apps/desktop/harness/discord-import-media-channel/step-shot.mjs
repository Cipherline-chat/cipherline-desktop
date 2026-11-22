// Screenshot the current screen to $S/<args[0]>.png (inspection only).
export default async (page, { args }) => {
  await page.screenshot({ path: `${process.env.S}/${args[0] ?? 'shot'}.png` });
  return 'ok';
};
