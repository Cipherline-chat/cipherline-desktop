// args: <ms> — a blob worker spins and records every gap > 30 ms in its own clock (it was not running),
// while the main thread records its own setTimeout(0)-chain gaps > 30 ms. Same-time gaps on both = the
// whole renderer process stopped (not a main-thread task). Optional Space presses keep a game run going.
export default async (page, { args }) => {
  const ms = Number(args[0] ?? 20000), play = args[1] === 'play';
  const res = page.evaluate(async (ms) => {
    const src = `let last=performance.now(),end=last+${ms};const g=[];while(true){const t=performance.now();if(t>end)break;if(t-last>30)g.push([Math.round(last+performance.timeOrigin),Math.round(t-last)]);last=t;}postMessage(g);`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const mainGaps = [];
    let last = performance.now(), stop = false;
    const chan = new MessageChannel();
    chan.port1.onmessage = () => { const t = performance.now(); if (t - last > 30) mainGaps.push([Math.round(last + performance.timeOrigin), Math.round(t - last)]); last = t; if (!stop) chan.port2.postMessage(0); };
    chan.port2.postMessage(0);
    const wg = await new Promise((r) => { w.onmessage = (e) => r(e.data); });
    stop = true; w.terminate();
    return { wg, mainGaps };
  }, ms);
  let presses = 0;
  if (play) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await page.keyboard.press('Space'); presses++; await page.waitForTimeout(350 + Math.random() * 100); } }
  const { wg, mainGaps } = await res;
  const both = wg.filter(([a, d]) => mainGaps.some(([b, e]) => b < a + d && b + e > a));
  const t0 = Math.min(...[...wg, ...mainGaps].map((x) => x[0]));
  const fmt = (l) => l.map(([a, d]) => `${((a - t0) / 1000).toFixed(2)}s/${d}`).join(' ');
  const iv = both.slice(1).map((x, i) => ((x[0] - both[i][0]) / 1000).toFixed(2));
  return `spin-worker gaps>30ms ${wg.length}: ${fmt(wg)}\nmain gaps>30ms ${mainGaps.length} (max ${Math.max(0, ...mainGaps.map((x) => x[1]))})\nBOTH (process stopped) ${both.length}: ${fmt(both)}\n  spacing ${iv.join(' ')}  presses ${presses}`;
};
