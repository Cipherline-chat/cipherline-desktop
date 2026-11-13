// Portal chooser accounting for one share action: counts the xdg-desktop-portal ScreenCast calls the sharer's session made
// between two wall-clock instants (dbus-monitor on the session bus, started by inside/common.sh portal_monitor), plus, on sway,
// the number of times the portal backend actually ran its chooser (inside/xdpw-chooser.sh logs each invocation).
//   A ScreenCast `Start` on the FRONTEND is what makes a backend with UI show its chooser / consent dialog, so the Start count
//   inside one share flow is the number of prompts that flow costs a person.
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lab.mjs';

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

export function dbusCalls(role = 'sharer') {
  const calls = [];
  for (const line of read(path.join(OUT, 'run', role, 'dbus-portal.log')).split('\n')) {
    const m = line.match(/^method call time=([\d.]+) sender=(\S+) -> destination=(\S+) serial=\d+ path=(\S+); interface=(\S+); member=(\w+)/);
    if (m) calls.push({ t: Math.round(+m[1] * 1000), iface: m[5], member: m[6], dest: m[3], path: m[4] });
  }
  return calls;
}

export function chooserCalls(role = 'sharer') {
  return read(path.join(OUT, 'run', role, 'chooser-calls.log')).split('\n').filter(Boolean).map((l) => ({ t: +l.split(' ')[0], line: l }));
}

/** Counts inside [t0, t1] (epoch ms). */
export function portalCounts(t0, t1, role = 'sharer') {
  const inWin = (c) => c.t >= t0 && c.t <= t1;
  const c = dbusCalls(role).filter(inWin);
  const n = (iface, member) => c.filter((x) => x.iface === iface && x.member === member).length;
  const FE = 'org.freedesktop.portal.ScreenCast', IMPL = 'org.freedesktop.impl.portal.ScreenCast';
  return {
    createSession: n(FE, 'CreateSession'), selectSources: n(FE, 'SelectSources'), start: n(FE, 'Start'),
    implStart: n(IMPL, 'Start'), openPipeWireRemote: n(FE, 'OpenPipeWireRemote'),
    chooserRuns: chooserCalls(role).filter(inWin).length,
  };
}
