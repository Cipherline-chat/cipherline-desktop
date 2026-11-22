// node gc.mjs trace.json : GC events on the renderer main thread (and worker), with spacing.
import fs from 'node:fs';
const { traceEvents: ev } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tname = new Map(), count = new Map();
for (const e of ev) {
  if (e.ph === 'M' && e.name === 'thread_name') tname.set(`${e.pid}:${e.tid}`, e.args.name);
  const k = `${e.pid}:${e.tid}`; count.set(k, (count.get(k) ?? 0) + 1);
}
const main = [...tname].filter(([, v]) => v === 'CrRendererMain').map(([k]) => k).sort((a, b) => count.get(b) - count.get(a))[0];
const all = ev.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X');
const ts0 = Math.min(...all.map((e) => e.ts));
const names = ['MajorGC', 'MinorGC', 'V8.GC_MARK_COMPACTOR', 'V8.GC_SCAVENGER', 'V8.GC_MC_FINISH', 'BlinkGC.AtomicPauseMarkEpilogue', 'CppGC.AtomicMark', 'V8.GCFinalizeMC', 'V8.GC_MC_COMPLETE_SWEEPING', 'V8.GC_MC_INCREMENTAL', 'V8.GC_MC_INCREMENTAL_FINALIZE', 'V8.GC_MINOR_MARK_SWEEPER', 'V8.GC_MS'];
const by = new Map();
for (const e of all) if (/GC|gc/.test(e.name)) { const g = by.get(e.name) ?? []; g.push(e); by.set(e.name, g); }
for (const [n, g] of [...by].sort((a, b) => b[1].reduce((s, e) => s + e.dur, 0) - a[1].reduce((s, e) => s + e.dur, 0)).slice(0, 14)) {
  const tot = g.reduce((s, e) => s + e.dur, 0) / 1000, max = Math.max(...g.map((e) => e.dur)) / 1000;
  console.log(`${n.padEnd(40)} ${String(g.length).padStart(5)}x total ${tot.toFixed(1)}ms max ${max.toFixed(1)}ms`);
}
for (const n of ['MajorGC', 'V8.GC_MARK_COMPACTOR', 'V8.GC_MC_INCREMENTAL_FINALIZE', 'V8.GC_MC_FINISH']) {
  const g = by.get(n); if (!g) continue;
  console.log(n, g.map((e) => `${((e.ts - ts0) / 1e6).toFixed(2)}s/${(e.dur / 1000).toFixed(0)}`).join(' '));
}
const mem = ev.filter((e) => `${e.pid}:${e.tid}` === main && (e.name === 'UpdateCounters') ).map((e) => e.args?.data?.jsHeapSizeUsed).filter(Boolean);
if (mem.length) console.log(`heap used min ${(Math.min(...mem) / 1048576).toFixed(0)}MB max ${(Math.max(...mem) / 1048576).toFixed(0)}MB`);
