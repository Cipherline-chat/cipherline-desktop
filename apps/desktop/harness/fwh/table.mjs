// node table.mjs metrics.jsonl : the before/after table (markdown) from metrics.mjs output lines, with the
// main thread's frames normalised per game frame (worker fps on this box is load noise; the ratio is not).
import fs from 'node:fs';
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const head = '| trace | main BeginMainFrames/s | main frames per game frame | main task ms/s | renderer compositor ms/s | game fps | game gap p50 / p90 / p99 ms | gaps > 50 ms |';
console.log(head); console.log(head.replace(/[^|]+/g, '---'));
for (const r of rows) {
  console.log(`| ${r.trace} | ${r.mainBeginMainFramePerSec} | ${(r.mainBeginMainFramePerSec / r.workerFps).toFixed(2)} | ${r.mainTaskMsPerSec} | ${r.rendererCompositorMsPerSec} | ${r.workerFps} | ${r.workerGapP50} / ${r.workerGapP90} / ${r.workerGapP99} | ${r.workerGapsOver50} |`);
}
const avg = (k, f) => { const a = rows.filter(f); return a.reduce((s, r) => s + r[k], 0) / a.length; };
for (const [name, f] of [['old (rAF loop)', (r) => /old/.test(r.trace)], ['new', (r) => /new/.test(r.trace)]]) {
  const ratio = rows.filter(f).reduce((s, r) => s + r.mainBeginMainFramePerSec / r.workerFps, 0) / rows.filter(f).length;
  console.log(`\n${name}: mean ${avg('mainBeginMainFramePerSec', f).toFixed(1)} main frames/s, ${ratio.toFixed(2)} per game frame; main task ${avg('mainTaskMsPerSec', f).toFixed(0)} ms/s; renderer compositor ${avg('rendererCompositorMsPerSec', f).toFixed(1)} ms/s`);
}
