// node overlap.mjs trace.json [minTaskMs=50] : for each long main-thread task, the worker's frame gap across it,
// against the worker's gap distribution overall (FireAnimationFrame starts on the DedicatedWorker thread).
import fs from 'node:fs';
const file = process.argv[2], minMs = Number(process.argv[3] ?? 50);
const { traceEvents: ev } = JSON.parse(fs.readFileSync(file, 'utf8'));
const tn = new Map(), c = new Map();
for (const e of ev) { if (e.ph === 'M' && e.name === 'thread_name') tn.set(`${e.pid}:${e.tid}`, e.args.name); const k = `${e.pid}:${e.tid}`; c.set(k, (c.get(k) ?? 0) + 1); }
const pick = (re) => [...tn].filter(([, v]) => re.test(v)).map(([k]) => k).sort((a, b) => c.get(b) - c.get(a))[0];
const main = pick(/^CrRendererMain$/), worker = pick(/DedicatedWorker/);
const X = (k, n) => ev.filter((e) => `${e.pid}:${e.tid}` === k && e.ph === 'X' && (!n || n.includes(e.name))).sort((a, b) => a.ts - b.ts);
const tasks = X(main, ['ThreadControllerImpl::RunTask']);
const frames = X(worker, ['FireAnimationFrame']).map((e) => e.ts);
const ts0 = tasks[0].ts;
const gaps = frames.slice(1).map((t, i) => ({ at: frames[i], end: t, g: (t - frames[i]) / 1000 }));
const sorted = gaps.map((x) => x.g).sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const span = (frames[frames.length - 1] - frames[0]) / 1e6;
console.log(`${file.split('/').pop()}: worker ${frames.length} frames over ${span.toFixed(1)}s = ${(frames.length / span).toFixed(1)} fps; gap p50 ${q(0.5).toFixed(1)} p90 ${q(0.9).toFixed(1)} p99 ${q(0.99).toFixed(1)} max ${q(1).toFixed(1)} ms`);
const long = tasks.filter((t) => t.dur / 1000 >= minMs);
let hit = 0;
for (const t of long) {
  const over = gaps.filter((x) => x.at < t.ts + t.dur && x.end > t.ts);
  const worst = over.reduce((m, x) => Math.max(m, x.g), 0);
  if (worst > q(0.9)) hit++;
  console.log(`  main task @${((t.ts - ts0) / 1e6).toFixed(2)}s ${(t.dur / 1000).toFixed(0)}ms (${t.args?.src_func ?? '?'}) -> worker worst gap across it ${worst.toFixed(0)}ms (${over.length} gaps)`);
}
console.log(`long main tasks ${long.length}; with a worker gap above its p90: ${hit}`);
