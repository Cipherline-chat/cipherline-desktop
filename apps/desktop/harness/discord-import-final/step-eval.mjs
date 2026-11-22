// Evaluate the JS expression in args[0] in the real renderer and return the result (debugging aid).
export default async (page, { args }) => page.evaluate((src) => (0, eval)(src), args[0]);
