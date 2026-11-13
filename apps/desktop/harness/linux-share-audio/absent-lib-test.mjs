// libpipewire (and libX11) are NOT installed here. The addon must still load, keep the other exports
// (window geometry, share power, hdr) and report isSupported() === false, and the capture calls must
// fail cleanly instead of crashing.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

const hasLib = ['/usr/lib/x86_64-linux-gnu/libpipewire-0.3.so.0', '/lib/x86_64-linux-gnu/libpipewire-0.3.so.0'].some((p) => fs.existsSync(p));
console.log('libpipewire-0.3.so.0 on this system:', hasLib);
let bad = 0;
const check = (name, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d ? '  -- ' + d : ''}`); if (!ok) bad++; };
check('precondition: library really is absent', !hasLib);

let addon;
try { addon = require('/addon/audio_capture.node'); } catch (e) { check('addon loads', false, e.message); process.exit(1); }
check('addon loads', true);
for (const n of ['isSupported', 'getPidFromSourceId', 'startCapture', 'stopCapture',
                 'getWindowInfo', 'getScreenRectFromDeviceIndex', 'placeOverlayAbove',
                 'setProcessPowerThrottling', 'setTimerResolution', 'getForegroundInfo', 'hdrCaptureStart', 'hdrGetDisplays']) {
    check(`export ${n} is a function`, typeof addon[n] === 'function');
}
check('isSupported() === false', addon.isSupported() === false);
check('getPidFromSourceId(screen) === null', addon.getPidFromSourceId('screen:0:0') === null);
check('getPidFromSourceId(window, no X) === null', addon.getPidFromSourceId('window:1234:0') === null);
check('other exports still answer (hdrGetDisplays is an array)', Array.isArray(addon.hdrGetDisplays()));

const events = [];
addon.startCapture(process.pid, 'exclude', (c) => events.push(c));
await new Promise((r) => setTimeout(r, 300));
check('startCapture reports { failed, reason: "unsupported" } instead of crashing', events.length === 1 && events[0].failed === true && events[0].reason === 'unsupported', JSON.stringify(events));
addon.stopCapture(); addon.stopCapture();
check('stopCapture() after a failed start, twice, is safe', true);
console.log(bad === 0 ? 'ABSENT-LIBRARY: ALL PASSED' : `ABSENT-LIBRARY: ${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
