// node periodic.mjs trace.json [minMs=4]
// Groups the renderer main thread's top-level tasks by what posted them + their main child, and reports
// for each group: count, total/max ms, and the median spacing (to find a ~3.1 s clock).
import fs from 'node:fs';
const file = process.argv[2], minMs = Number(process.argv[3] ?? 4);
const { traceEvents: ev } = JSON.parse(fs.readFileSync(file, 'utf8'));
const tname = new Map(), count = new Map();
for (const e of ev) {
  if (e.ph === 'M' && e.name === 'thread_name') tname.set(`${e.pid}:${e.tid}`, e.args.name);
  const k = `${e.pid}:${e.tid}`; count.set(k, (count.get(k) ?? 0) + 1);
}
const main = [...tname].filter(([, v]) => v === 'CrRendererMain').map(([k]) => k).sort((a, b) => count.get(b) - count.get(a))[0];
const mainEv = ev.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X' && typeof e.dur === 'number').sort((a, b) => a.ts - b.ts);
const ts0 = mainEv[0].ts;
const tasks = mainEv.filter((e) => e.name === 'ThreadControllerImpl::RunTask');
const groups = new Map();
let j = 0;
for (const t of tasks) {
  if (t.dur / 1000 < minMs) continue;
  while (j < mainEv.length && mainEv[j].ts < t.ts) j++;
  const kids = [];
  for (let i = j; i < mainEv.length && mainEv[i].ts <= t.ts + t.dur; i++) if (mainEv[i] !== t) kids.push(mainEv[i]);
  const fc = kids.find((e) => e.name === 'FunctionCall' || e.name === 'TimerFire' || e.name === 'EventDispatch' || e.name === 'FireAnimationFrame');
  const what = fc ? `${fc.name}:${fc.args?.data?.functionName || fc.args?.data?.type || ''}@${(fc.args?.data?.url || '').split('/').pop().split('?')[0]}:${fc.args?.data?.lineNumber ?? ''}` : (kids.filter((k) => k.dur > t.dur * 0.3).map((k) => k.name).slice(0, 3).join('>') || 'no-child');
  const key = `${t.args?.src_file?.split('/').slice(-2).join('/') ?? '?'}:${t.args?.src_func ?? '?'} | ${what}`;
  const g = groups.get(key) ?? { n: 0, ms: 0, max: 0, at: [] };
  g.n++; g.ms += t.dur / 1000; g.max = Math.max(g.max, t.dur / 1000); g.at.push((t.ts - ts0) / 1e6);
  groups.set(key, g);
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
for (const [k, g] of [...groups].sort((a, b) => b[1].ms - a[1].ms).slice(0, 40)) {
  const iv = g.at.slice(1).map((t, i) => t - g.at[i]);
  console.log(`${g.n.toString().padStart(4)}x ${g.ms.toFixed(0).padStart(5)}ms max ${g.max.toFixed(1).padStart(6)} spacing~${iv.length ? med(iv).toFixed(2) : '-'}s  ${k}`);
}
