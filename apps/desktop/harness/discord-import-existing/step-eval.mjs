// Evaluate a small expression in the REAL renderer (args[0]); prints the result. Inspection only.
export default async (page, { args }) => await page.evaluate((src) => (0, eval)(src), args[0]);
