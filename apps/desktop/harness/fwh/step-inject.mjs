// args: on|off  — a 70 ms main-thread busy loop every 3.1 s (window.__fwInject), to test whether a
// main-thread stall alone stalls the game's worker canvas.
export default async (page, { args }) => page.evaluate((on) => {
  const w = window;
  if (w.__fwInject) { clearInterval(w.__fwInject); w.__fwInject = 0; }
  if (on === 'on') w.__fwInject = setInterval(() => { const t = performance.now(); while (performance.now() - t < 70) { /* busy */ } }, 3100);
  return `inject ${on}`;
}, args[0]);
