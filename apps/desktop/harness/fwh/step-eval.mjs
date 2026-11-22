// args[0] = JS expression evaluated in the renderer (awaited)
export default async (page, { args }) => {
  const r = await page.evaluate(async (src) => { try { return await (0, eval)(src); } catch (e) { return 'ERR ' + e; } }, args[0]);
  return typeof r === 'string' ? r : JSON.stringify(r);
};
