// Fold a `rate` stage run (app-default.json) and its portal traffic (portal.json) into one table.
//   node rate-report.mjs <cell dir> [app json name]
// Starts = ScreenCast.Start calls inside the case's phase (a chooser on a desktop with UI unless the portal restores silently).
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const app = JSON.parse(fs.readFileSync(path.join(dir, process.argv[3] || 'app-default.json'), 'utf8'));
let portal = { perPhase: {} };
try { portal = JSON.parse(fs.readFileSync(path.join(dir, 'portal.json'), 'utf8')); } catch { /* none */ }
const starts = (label) => {
  let n = 0;
  for (const [k, v] of Object.entries(portal.perPhase)) if (k === `rate:${label}`) n += v.start;
  return n;
};
const sz = (s) => (s ? `${s[0]}x${s[1]}` : '-');
const r = app.stages && app.stages.rate;
if (!r) { console.log('no rate stage', app.errors); process.exit(1); }
if (r.error) console.log('rate stage error:', r.error);
console.log(`output ${sz(r.output)}  max request fps ${r.maxFps}`);
const row = (label, m, cpu, extra = '') => {
  if (!m || m.error) return `${label.padEnd(18)} ERROR ${m && m.error || ''}`;
  const s = m.source, e = m.encoded, v = m.viewer;
  return `${label.padEnd(18)} starts=${String(starts(label)).padEnd(2)} src ${String(s.fps).padStart(5)}fps(u${String(s.uniqueFps).padStart(5)}) ${sz(s.size).padEnd(9)} | enc ${String(e.fps).padStart(5)}fps ${sz(e.size).padEnd(9)} | viewer ${String(v.fps).padStart(5)}fps ${sz(v.size).padEnd(9)} | cpu app ${String(cpu && cpu.app).padStart(5)}% comp ${String(cpu && cpu.comp).padStart(5)}% ${extra}`;
};
for (const c of r.cases || []) {
  if (c.error) { console.log(`${c.label.padEnd(18)} ERROR ${c.error}`); continue; }
  const pw = (c.pw || []).filter((p) => p.format).map((p) => `${p.name}:${p.format.size ? p.format.size.width + 'x' + p.format.size.height : '?'}@${p.format.framerate ? p.format.framerate.num + '/' + p.format.framerate.denom : '?'}max${p.format.maxFramerate ? p.format.maxFramerate.num + '/' + p.format.maxFramerate.denom : '?'}`).join(' ');
  console.log(row(c.label, c.m, c.cpu, `rAF ${c.patternFps} settings ${c.start && c.start.settings ? sz([c.start.settings.width, c.start.settings.height]) + '@' + c.start.settings.frameRate : ''} ${pw}`));
}
for (const live of r.lives || []) {
  console.log(`-- live (one capture, applyConstraints) sender=${live.withSender} start=${live.start && JSON.stringify(live.start.settings)} ${live.error || ''}`);
  for (const s of live.steps) {
    const ar = s.applyResult || {};
    console.log(row(s.step, s.m, s.cpu, `patternRAF ${s.patternFps} applied ${ar.settings ? sz([ar.settings.width, ar.settings.height]) + '@' + ar.settings.frameRate : ''} ${ar.error ? 'ERR ' + ar.error : ''} state=${ar.state}`));
  }
}
if (r.plan) {
  console.log(`-- plan (the app's own decision, restoreListed=${r.plan.restoreListed}) ${r.plan.error || ''}`);
  for (const s of r.plan.steps) {
    const ar = s.applyResult || {};
    console.log(row(s.step, s.m, s.cpu, `touchedCapture=${s.touchedCapture} asked ${s.asked.fps}fps<=${s.asked.width}x${s.asked.height} patternRAF ${s.patternFps} ${ar.error ? 'ERR ' + ar.error : ''}`));
  }
}
