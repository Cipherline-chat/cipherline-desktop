// Count what the USER saw per phase, not what the app called: a `ScreenCast.Start` is a chooser only if the backend actually opened a dialog.
//   node dialogs.mjs <cell dir> [phases log name]
// Per phase marker (`<name>:begin`): frontend Start calls, frontend SelectSources calls that carried a restore_token, streams opened
// (OpenPipeWireRemote) and DIALOGS - GNOME's backend logs "Failed to associate portal window with parent window" once per dialog it opens
// (verified 1:1 against the bot's own log). Other backends have no such line: `dialogs` is then null, never a guess.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const phaseName = process.argv[3] || 'phases-default.log';
const rd = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
const dbus = rd('dbus-portal.log').split('\n');
const calls = [];
for (let i = 0; i < dbus.length; i++) {
  const m = dbus[i].match(/^method call time=([\d.]+) sender=(\S+) -> destination=(\S+) serial=\d+ path=(\S+); interface=(\S+); member=(\w+)/);
  if (!m) continue;
  let j = i + 1; const body = [];
  while (j < dbus.length && !/^(method call|signal|method return|error)/.test(dbus[j])) body.push(dbus[j++]);
  if (m[5] === 'org.freedesktop.portal.ScreenCast') calls.push({ t: Math.round(+m[1] * 1000), member: m[6], token: /restore_token/.test(body.join('\n')) });
}
const begins = [];
for (const line of rd(phaseName).split('\n')) {
  const m = line.match(/^(\d+) (\S+):begin$/); if (m) begins.push({ t: +m[1], name: m[2] });
  const d = line.match(/^(\d+) done$/); if (d) begins.push({ t: +d[1], name: '(after run)' });
}
begins.sort((a, b) => a.t - b.t);
const spanOf = (t) => { let cur = '(before)'; for (const b of begins) { if (b.t <= t + 20) cur = b.name; else break; } return cur; };
const gnomeLog = rd('portal-xdg-desktop-portal-gnome.log');
const hasGnome = gnomeLog.length > 0;
const dialogs = [];
if (hasGnome) {
  const day = new Date((calls[0] ? calls[0].t : Date.now())); day.setUTCHours(0, 0, 0, 0);
  for (const l of gnomeLog.split('\n')) {
    const m = l.match(/(\d\d):(\d\d):(\d\d)\.(\d+): Failed to associate portal window/);
    if (m) dialogs.push(day.getTime() + ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4]);
  }
}
const per = {};
const slot = (n) => (per[n] ||= { start: 0, selectWithToken: 0, selectNoToken: 0, streamsOpened: 0, dialogs: hasGnome ? 0 : null });
for (const c of calls) {
  const e = slot(spanOf(c.t));
  if (c.member === 'Start') e.start++;
  if (c.member === 'SelectSources') c.token ? e.selectWithToken++ : e.selectNoToken++;
  if (c.member === 'OpenPipeWireRemote') e.streamsOpened++;
}
for (const t of dialogs) slot(spanOf(t)).dialogs++;
console.log(JSON.stringify(per, null, 1));
