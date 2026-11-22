// node metrics.mjs trace.json [...] : one summary line per trace (JSON) for the before/after table.
import fs from 'node:fs';
for (const file of process.argv.slice(2)) {
  const { traceEvents: ev } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tn = new Map(), pn = new Map(), c = new Map();
  for (const e of ev) { if (e.ph === 'M' && e.name === 'thread_name') tn.set(`${e.pid}:${e.tid}`, e.args.name); if (e.ph === 'M' && e.name === 'process_name') pn.set(e.pid, e.args.name); const k = `${e.pid}:${e.tid}`; c.set(k, (c.get(k) ?? 0) + 1); }
  const pick = (re, proc) => [...tn].filter(([k, v]) => re.test(v) && (!proc || proc.test(pn.get(+k.split(':')[0]) ?? ''))).map(([k]) => k).sort((a, b) => c.get(b) - c.get(a))[0];
  const main = pick(/^CrRendererMain$/), worker = pick(/DedicatedWorker/), comp = pick(/^Compositor$/, /Renderer/), gpu = pick(/^CrGpuMain$/);
  const rpid = +main.split(':')[0];
  const X = (k) => ev.filter((e) => `${e.pid}:${e.tid}` === k && e.ph === 'X' && typeof e.dur === 'number');
  const mainEv = X(main), tasks = mainEv.filter((e) => e.name === 'ThreadControllerImpl::RunTask');
  const t0 = Math.min(...tasks.map((e) => e.ts)), t1 = Math.max(...tasks.map((e) => e.ts + e.dur)), sec = (t1 - t0) / 1e6;
  const bmf = tasks.filter((t) => t.args?.src_func === 'ScheduledActionSendBeginMainFrame').length;
  const ph = tasks.filter((t) => t.args?.src_func === 'PostImageToPlaceholder').length;
  const compEv = X(comp);
  const submits = compEv.filter((e) => e.name === 'LayerTreeHostImpl::DrawLayers' || e.name === 'SubmitCompositorFrame').length;
  const compBusy = compEv.filter((e) => e.name === 'ThreadControllerImpl::RunTask').reduce((s, e) => s + e.dur, 0) / 1000;
  const fr = X(worker).filter((e) => e.name === 'FireAnimationFrame').map((e) => e.ts).sort((a, b) => a - b);
  const gaps = fr.slice(1).map((t, i) => (t - fr[i]) / 1000).sort((a, b) => a - b);
  const q = (p) => +(gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] ?? 0).toFixed(1);
  const gpuBusy = X(gpu).filter((e) => e.name === 'ThreadControllerImpl::RunTask').reduce((s, e) => s + e.dur, 0) / 1000;
  const longTasks = tasks.filter((t) => t.dur >= 50000).length;
  console.log(JSON.stringify({
    trace: file.split('/').pop(), sec: +sec.toFixed(1),
    mainBeginMainFramePerSec: +(bmf / sec).toFixed(1), placeholderPostsPerSec: +(ph / sec).toFixed(1),
    mainTaskMsPerSec: +(tasks.reduce((s, t) => s + t.dur, 0) / 1000 / sec).toFixed(1), mainLongTasks50: longTasks,
    rendererCompositorFramesPerSec: +(submits / sec).toFixed(1), rendererCompositorMsPerSec: +(compBusy / sec).toFixed(1),
    gpuMainBusyPct: +(gpuBusy / sec / 10).toFixed(0),
    workerFps: +(fr.length / ((fr[fr.length - 1] - fr[0]) / 1e6)).toFixed(1), workerGapP50: q(0.5), workerGapP90: q(0.9), workerGapP99: q(0.99), workerGapMax: q(1),
    workerGapsOver50: gaps.filter((g) => g > 50).length, rendererPid: rpid,
  }));
}
