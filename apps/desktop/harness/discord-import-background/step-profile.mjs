// CPU-profile the REAL renderer's main thread for args[0] seconds (CDP Profiler) and return the top self-time
// functions with their source file, plus the share that is idle / GC / program. Saves the raw profile as
// $S/<args[1]>.cpuprofile. What is the main thread busy with while an import runs?
import fs from 'node:fs';
export default async (page, { ctx, args }) => {
  const secs = Number(args[0] ?? 15);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');
  await page.waitForTimeout(secs * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  if (args[1]) fs.writeFileSync(`${process.env.S}/${args[1]}.cpuprofile`, JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  profile.samples.forEach((id, i) => { self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)); });
  const agg = new Map();
  let total = 0;
  for (const [id, us] of self) {
    const n = byId.get(id); const cf = n.callFrame;
    const file = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    const key = `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}`;
    agg.set(key, (agg.get(key) ?? 0) + us); total += us;
  }
  const top = [...agg].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => `${(us / 1000).toFixed(0).padStart(6)} ms  ${(100 * us / total).toFixed(1).padStart(5)}%  ${k}`);
  // By file (where the time goes, roughly).
  const files = new Map();
  for (const [k, us] of agg) { const f = k.split(' ').slice(1).join(' ').replace(/:\d+$/, '') || '(native)'; files.set(f, (files.get(f) ?? 0) + us); }
  const topFiles = [...files].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, us]) => `${(us / 1000).toFixed(0).padStart(6)} ms  ${(100 * us / total).toFixed(1).padStart(5)}%  ${f}`);
  return `total ${(total / 1000).toFixed(0)} ms sampled over ${secs}s\n-- top functions --\n${top.join('\n')}\n-- by file --\n${topFiles.join('\n')}`;
};
