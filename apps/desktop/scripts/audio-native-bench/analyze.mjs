// node analyze.mjs results.json  ->  one summary per step: hand-off percentiles, slack, underruns per jitter depth, CPU/RSS, latency, continuity
import { readFileSync } from 'node:fs';
const { results } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pct = (a, p) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))]; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
function lag(a, b, maxLag, from, n) {
  // cross-correlation: b(t) ~ a(t - L); returns L (samples) maximising the normalised correlation over [from, from+n)
  let best = -1, bl = 0;
  for (let L = 0; L <= maxLag; L += 1) { let r = 0, e1 = 0, e2 = 0; for (let i = from; i < from + n; i += 2) { const x = a[i - L], y = b[i]; r += x * y; e1 += x * x; e2 += y * y; } const v = r / Math.sqrt(e1 * e2 + 1e-20); if (v > best) { best = v; bl = L; } }
  return { lag: bl, corr: best };
}
for (const r of results) {
  const s = r.step, res = r.res || {};
  console.log(`\n== ${s.name}  (native=${!!s.native} jitter=${s.jitter} ${s.seconds}s)`);
  if (res.error) { console.log('ERROR', res.error); continue; }
  const t = res.trace || [];
  const rtt = [], slack = [], us = [], seq = [];
  for (let i = 0; i + 3 < t.length; i += 4) { rtt.push(t[i]); slack.push(t[i + 1]); us.push(t[i + 2]); seq.push(t[i + 3]); }
  if (rtt.length) {
    console.log(`replies ${rtt.length}; round trip ms (Date.now, 1 ms steps): median ${pct(rtt, 50)} p95 ${pct(rtt, 95)} p99 ${pct(rtt, 99)} p99.9 ${pct(rtt, 99.9)} max ${Math.max(...rtt)}`);
    console.log(`host process480 us: median ${f1(pct(us, 50))} p99 ${f1(pct(us, 99))} max ${f1(Math.max(...us))}`);
    // slack (samples) at arrival relative to the frame's first output sample; on time iff >= 0. Re-derive for other depths.
    const J0 = s.jitter ?? 0;
    const rows = [];
    for (const J of [0, 1, 2, 3, 4]) { const late = slack.filter((v) => v + 480 * (J - J0) < 0).length; rows.push(`J=${J}: ${late} late (${(100 * late / slack.length).toFixed(3)} %)`); }
    console.log(`slack at arrival, samples: min ${Math.min(...slack)} p1 ${pct(slack, 1)} median ${pct(slack, 50)}; underruns if the depth were  ${rows.join('  ')}`);
  }
  const last = (res.stats || []).at(-1);
  if (last && last.native) { const n = last.native; console.log(`worklet counters: frames ${n.frames} played ${n.played} underrun ${n.underrun} late ${n.late} dup ${n.dup} ooo ${n.ooo} bad ${n.bad} hostFail ${n.hostFail} failed=${n.failed} ${n.reason || ''}`); if (n.frames) console.log(`  underrun % = ${(100 * n.underrun / n.frames).toFixed(3)}`); if (n.host) console.log(`  host (last second): ${JSON.stringify(n.host)}`); }
  if ((res.paused || []).length || (res.resumed || []).length) console.log(`native paused: ${(res.paused || []).map((m) => `${m.reason}@${m.at.toFixed(1)}s(wait ${m.resumeFrames / 100}s)`).join(', ')}; resumed: ${(res.resumed || []).map((m) => `@${m.at.toFixed(1)}s`).join(', ')}`);
  if (res.nativeFailed) console.log(`nativeFailed: ${res.nativeFailed.reason} at ${f1(res.nativeFailedAtS)} s`);
  if (res.openMs !== null && res.openMs !== undefined) console.log(`open (spawn + model load + port) ${f1(res.openMs)} ms`);
  if (res.ready) console.log(`worklet ready: ${JSON.stringify(res.ready)}`);
  const cpu = (r.samples || []).map((x) => x.cpuPct), rss = (r.samples || []).map((x) => x.rssMb);
  if (cpu.length) {
    console.log(`utility CPU % of one core: mean ${f1(cpu.reduce((a, b) => a + b, 0) / cpu.length)} median ${f1(pct(cpu, 50))} p95 ${f1(pct(cpu, 95))} max ${f1(Math.max(...cpu))}  RSS MB: median ${f1(pct(rss, 50))} max ${f1(Math.max(...rss))}`);
    if (r.loadStart && r.loadEnd) {
      const inL = (r.samples || []).filter((x) => x.at >= r.loadStart && x.at <= r.loadEnd).map((x) => x.cpuPct), outL = (r.samples || []).filter((x) => x.at < r.loadStart || x.at > r.loadEnd).map((x) => x.cpuPct);
      console.log(`  CPU idle-part mean ${f1(outL.reduce((a, b) => a + b, 0) / Math.max(1, outL.length))}  under load mean ${f1(inL.reduce((a, b) => a + b, 0) / Math.max(1, inL.length))}`);
    }
  }
  if (r.loadStart && r.loadEnd && res.trace) {
    // split the hand-off by load: need absolute time; trace frames are ~10 ms apart from startedAt
    const t0 = r.startedAt;
    const during = [], outside = [];
    for (let i = 0; i < rtt.length; i++) { const at = t0 + seq[i] * 10; (at >= r.loadStart && at <= r.loadEnd ? during : outside).push(rtt[i]); }
    if (during.length) console.log(`  round trip ms under load (${during.length}): median ${pct(during, 50)} p95 ${pct(during, 95)} p99 ${pct(during, 99)} max ${Math.max(...during)};  idle part (${outside.length}): median ${pct(outside, 50)} p95 ${pct(outside, 95)} p99 ${pct(outside, 99)} max ${Math.max(...outside)}`);
  }
  if (res.rec) {
    const a = res.rec.a, b = res.rec.b;
    const L = lag(a, b, 4000, 48000 * 2, 48000 * 3);
    console.log(`measured delay input->output: ${L.lag} samples = ${(L.lag / 48).toFixed(2)} ms (corr ${L.corr.toFixed(3)})`);
    // continuity: longest run of exact zeros in the output after the first 1.5 s while the input is non-zero
    let run = 0, worst = 0, worstAt = 0;
    for (let i = 72000; i < b.length; i++) { if (b[i] === 0 && a[i - 600 > 0 ? i - 600 : 0] !== 0) { run++; if (run > worst) { worst = run; worstAt = i; } } else run = 0; }
    console.log(`longest run of zero output samples (input non-zero): ${worst} samples = ${(worst / 48).toFixed(1)} ms at ${(worstAt / 48000).toFixed(2)} s`);
  }
}
