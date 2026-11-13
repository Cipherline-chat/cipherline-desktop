// Fold the dbus-monitor capture of the ScreenCast portal against the test app's phase markers.
//   node analyze-portal.mjs <dbus-portal.log> <phases-default.log>
// A ScreenCast `Start` is the call that makes the portal backend show its chooser / consent dialog, so the number of
// Start calls inside one share flow IS the number of prompts that flow costs a user on a backend that has UI.
import fs from 'node:fs';
const [dbusLog, phaseLog] = process.argv.slice(2);
const calls = [];
for (const line of fs.existsSync(dbusLog) ? fs.readFileSync(dbusLog, 'utf8').split('\n') : []) {
  const m = line.match(/^method call time=([\d.]+) sender=(\S+) -> destination=(\S+) serial=\d+ path=(\S+); interface=(\S+); member=(\w+)/);
  if (m) calls.push({ t: Math.round(+m[1] * 1000), iface: m[5], member: m[6], dest: m[3], path: m[4] });
}
// Every call belongs to the most recent `:begin` marker before it (phases overlap their own :end by design: Chromium
// resolves getDisplayMedia a few ms BEFORE the PipeWire capturer opens its portal session).
const begins = [];
for (const line of fs.existsSync(phaseLog) ? fs.readFileSync(phaseLog, 'utf8').split('\n') : []) {
  const m = line.match(/^(\d+) (\S+):begin$/); if (m) begins.push({ t: +m[1], name: m[2] });
  // The run is over: portal traffic after this belongs to whatever ran next in the same cell (the dbus log is one file per cell).
  const done = line.match(/^(\d+) done$/); if (done) begins.push({ t: +done[1], name: '(after run)' });
}
begins.sort((x, y) => x.t - y.t);
const spanOf = (t) => { let cur = null; for (const b of begins) { if (b.t <= t + 20) cur = b.name; else break; } return cur || '(before any phase)'; };
const perPhase = {};
for (const c of calls) {
  const sp = spanOf(c.t);
  const e = (perPhase[sp] ||= { createSession: 0, selectSources: 0, start: 0, implStart: 0, openPipeWireRemote: 0 });
  const fe = c.iface === 'org.freedesktop.portal.ScreenCast', im = c.iface === 'org.freedesktop.impl.portal.ScreenCast';
  if (fe && c.member === 'CreateSession') e.createSession++;
  if (fe && c.member === 'SelectSources') e.selectSources++;
  if (fe && c.member === 'Start') e.start++;
  if (im && c.member === 'Start') e.implStart++;
  if (fe && c.member === 'OpenPipeWireRemote') e.openPipeWireRemote++;
}
// The A/B flows (app/main.js stages flow-before / flow-after): markers are `flow:<flow>:<step>`; the Starts of every step of a flow,
// by step and in total. This is the number that is one user decision's worth of desktop choosers.
const flows = {};
for (const [name, v] of Object.entries(perPhase)) {
  const m = name.match(/^flow:(before|after):([^:]+)/);
  if (!m) continue;
  const f = (flows[m[1]] ||= { total: 0, steps: {} });
  f.steps[m[2]] = (f.steps[m[2]] || 0) + v.start;
  f.total += v.start;
}
const sum = (pred, k = 'start') => Object.entries(perPhase).filter(([n]) => pred(n)).reduce((a, [, v]) => a + v[k], 0);
const out = {
  totalScreenCastCalls: calls.length,
  totalStart: calls.filter((c) => c.iface === 'org.freedesktop.portal.ScreenCast' && c.member === 'Start').length,
  perPhase,
  flows,
  // headline: portal chooser invocations for ONE picker-driven share (list the screens, then open the stream)
  promptsScreenShare: sum((n) => n === 'getSources:screen' || n === 'gdm:screen'),
  promptsScreenShare_getSources: sum((n) => n === 'getSources:screen'),
  promptsScreenShare_getDisplayMedia: sum((n) => n === 'gdm:screen'),
  promptsWindowShare: sum((n) => n === 'getSources:window' || n === 'gdm:window'),
  windowListPromptedPortal: sum((n) => n === 'getSources:window'),
  // each applyConstraints(frameRate) on the live share that restarted the capturer = one more portal session
  extraSessionsFromApplyConstraints: sum((n) => /^measure:screen:/.test(n)),
  rawCalls: calls.map((c) => ({ ...c, span: spanOf(c.t) })).filter((c) => c.member === 'Start' && c.iface === 'org.freedesktop.portal.ScreenCast'),
};
console.log(JSON.stringify(out, null, 2));
