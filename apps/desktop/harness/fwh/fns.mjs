// node fns.mjs trace.json : JS entry points on the renderer main thread by function/url:line (count, total ms, spacing)
import fs from 'node:fs';
const { traceEvents: ev } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tname = new Map(), count = new Map();
for (const e of ev) {
  if (e.ph === 'M' && e.name === 'thread_name') tname.set(`${e.pid}:${e.tid}`, e.args.name);
  const k = `${e.pid}:${e.tid}`; count.set(k, (count.get(k) ?? 0) + 1);
}
const main = [...tname].filter(([, v]) => v === 'CrRendererMain').map(([k]) => k).sort((a, b) => count.get(b) - count.get(a))[0];
const mainEv = ev.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X' && typeof e.dur === 'number').sort((a, b) => a.ts - b.ts);
const ts0 = mainEv[0].ts;
const by = new Map();
for (const e of mainEv) {
  if (e.name !== 'FunctionCall' && e.name !== 'TimerFire') continue;
  const d = e.args?.data ?? {};
  const k = `${e.name}:${d.functionName || ''}@${(d.url || '').split('/').pop().split('?')[0]}:${d.lineNumber ?? ''} t${d.timerId ?? ''}`;
  const g = by.get(k) ?? { n: 0, ms: 0, at: [] }; g.n++; g.ms += e.dur / 1000; g.at.push((e.ts - ts0) / 1e6); by.set(k, g);
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
for (const [k, g] of [...by].sort((a, b) => b[1].ms - a[1].ms).slice(0, Number(process.argv[3] ?? 30))) {
  const iv = g.at.slice(1).map((t, i) => t - g.at[i]);
  console.log(`${String(g.n).padStart(5)}x ${g.ms.toFixed(0).padStart(5)}ms spacing~${iv.length ? med(iv).toFixed(3) : '-'}s  ${k}`);
}
