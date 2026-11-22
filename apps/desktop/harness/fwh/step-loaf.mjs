// args: <ms> [play] — LoAF entries (>= 50 ms) on the main thread over the window, with phases and scripts,
// plus the game's own late frames as the probe hears them (fw probe messages are not visible here, so the
// worker side is read from window.__fwLoafGame if a build exposes it). Prints spacing of no-script frames.
export default async (page, { args }) => {
  const ms = Number(args[0] ?? 30000), play = args[1] === 'play';
  const res = page.evaluate(async (ms) => {
    const out = [];
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) out.push(e); });
    po.observe({ type: 'long-animation-frame', buffered: false });
    await new Promise((r) => setTimeout(r, ms));
    po.disconnect();
    return out.map((e) => ({
      at: Math.round(e.startTime), dur: Math.round(e.duration), block: Math.round(e.blockingDuration),
      tasks: e.renderStart ? Math.round(e.renderStart - e.startTime) : null,
      render: e.styleAndLayoutStart ? Math.round(e.startTime + e.duration - e.styleAndLayoutStart) : null,
      scripts: e.scripts.map((s) => `${Math.round(s.duration)}ms ${s.invokerType}:${(s.invoker || '').slice(0, 50)} ${(s.sourceURL || '').split('/').pop().split('?')[0]}:${s.sourceFunctionName || ''}`),
    }));
  }, ms);
  let presses = 0;
  if (play) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await page.keyboard.press('Space'); presses++; await page.waitForTimeout(350 + Math.random() * 100); } }
  const list = await res;
  const lines = list.map((l) => `  @${(l.at / 1000).toFixed(2)}s ${l.dur}ms tasks ${l.tasks} render ${l.render} BLOCK ${l.block} ${l.scripts.join(' | ') || 'NO SCRIPT'}`);
  const ns = list.filter((l) => !l.scripts.length);
  const iv = ns.slice(1).map((l, i) => ((l.at - ns[i].at) / 1000).toFixed(2));
  return `${list.length} LoAF (${ns.length} with no script) presses ${presses}\n${lines.join('\n')}\nno-script spacing: ${iv.join(' ')}`;
};
