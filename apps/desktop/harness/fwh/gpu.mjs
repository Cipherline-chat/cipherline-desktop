// node gpu.mjs trace.json [minMs=8] [threadRe=CrGpuMain] : long tasks on a GPU-process thread, grouped by poster + main child.
import fs from 'node:fs';
const file = process.argv[2], minMs = Number(process.argv[3] ?? 8), re = new RegExp(process.argv[4] ?? '^CrGpuMain$');
const { traceEvents: ev } = JSON.parse(fs.readFileSync(file, 'utf8'));
const tn = new Map(), pn = new Map(), c = new Map();
for (const e of ev) { if (e.ph === 'M' && e.name === 'thread_name') tn.set(`${e.pid}:${e.tid}`, e.args.name); if (e.ph === 'M' && e.name === 'process_name') pn.set(e.pid, e.args.name); const k = `${e.pid}:${e.tid}`; c.set(k, (c.get(k) ?? 0) + 1); }
const th = [...tn].filter(([k, v]) => re.test(v) && /GPU/.test(pn.get(+k.split(':')[0]) ?? 'GPU')).map(([k]) => k).sort((a, b) => c.get(b) - c.get(a))[0];
const all = ev.filter((e) => `${e.pid}:${e.tid}` === th && e.ph === 'X' && typeof e.dur === 'number').sort((a, b) => a.ts - b.ts);
const ts0 = all[0].ts;
const tasks = all.filter((e) => e.name === 'ThreadControllerImpl::RunTask');
const busy = tasks.reduce((s, t) => s + t.dur, 0) / 1000, span = (all[all.length - 1].ts - ts0) / 1e6;
console.log(`${file.split('/').pop()} ${tn.get(th)}: ${tasks.length} tasks, busy ${busy.toFixed(0)}ms over ${span.toFixed(1)}s (${(busy / span / 10).toFixed(0)}%)`);
const groups = new Map(); let j = 0;
for (const t of tasks) {
  if (t.dur / 1000 < minMs) continue;
  while (j < all.length && all[j].ts < t.ts) j++;
  const kids = []; for (let i = j; i < all.length && all[i].ts <= t.ts + t.dur; i++) if (all[i] !== t && all[i].dur > t.dur * 0.25) kids.push(all[i].name);
  const key = `${t.args?.src_file?.split('/').slice(-2).join('/')}:${t.args?.src_func} | ${kids.slice(0, 4).join('>')}`;
  const g = groups.get(key) ?? { n: 0, ms: 0, max: 0, at: [] }; g.n++; g.ms += t.dur / 1000; g.max = Math.max(g.max, t.dur / 1000); g.at.push((t.ts - ts0) / 1e6); groups.set(key, g);
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
for (const [k, g] of [...groups].sort((a, b) => b[1].ms - a[1].ms).slice(0, 20)) {
  const iv = g.at.slice(1).map((t, i) => t - g.at[i]);
  console.log(`${String(g.n).padStart(4)}x ${g.ms.toFixed(0).padStart(5)}ms max ${g.max.toFixed(1).padStart(6)} spacing~${iv.length ? med(iv).toFixed(2) : '-'}s ${k.slice(0, 200)}`);
}
