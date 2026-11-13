// Per-application audio for Wayland window shares (src-native/audio_capture_linux.cc 'app' mode + listApps,
// electron/app-audio.ts). Runs INSIDE the container started by run.sh, with a live pipewire + wireplumber +
// pipewire-pulse and a null sink. The main-process rules (handles, share grant) are the REAL compiled
// electron/app-audio.js + electron/capture-consent.js, mounted at /js, composed exactly the way main.ts's
// audio:list-apps / audio:start-app-capture handlers compose them.
//
//   A    440 Hz  paplay            a PulseAudio client (how Chromium/Electron play): application "paplay", program "pacat"
//   B   1000 Hz  pw-cat           a native PipeWire client, application "pw-cat"
//   self 2000 Hz selfplay         a copy of paplay run as a CHILD of the pid we pretend is Cipherline (OWN)
//
// Exit code 0 only if every assertion holds. Machine-readable results go to $OUT/app-results.json.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { spectrum, RATE } from './dsp.mjs';

const require = createRequire(import.meta.url);
const addon = require(process.env.ADDON || '/addon/audio_capture.node');
const appAudioMod = require('/js/app-audio.js');
const consentMod = require('/js/capture-consent.js');
const OUT = process.env.OUT || '/out';
const WAV = '/tmp/tones';
const T = (n) => `${WAV}/${n}.wav`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRESENT = -25;     // a 0.25-amplitude sine is about -12 dBFS
const ABSENT = -90;      // digital silence in that bin

const results = { assertions: [], scenarios: [], listMs: [] };
let failures = 0;
function assert(name, ok, detail) {
    results.assertions.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
    if (!ok) failures++;
}

// ── processes ───────────────────────────────────────────────────────────────
fs.mkdirSync('/tmp/bin', { recursive: true });
fs.copyFileSync('/usr/bin/paplay', '/tmp/bin/selfplay');
fs.chmodSync('/tmp/bin/selfplay', 0o755);
const kids = new Set();
function spawnP(cmd, args) {
    const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    c.stderr.on('data', () => {});
    kids.add(c);
    c.on('exit', () => kids.delete(c));
    return c;
}
const playA = () => spawnP('paplay', [T('t440')]);
const playB = () => spawnP('pw-cat', ['-p', T('t1000')]);
/** "Cipherline": a bash whose CHILD plays 2000 Hz. OWN.pid is the pid handed to the addon as the excluded tree. */
const startOwn = () => spawnP('bash', ['-c', `/tmp/bin/selfplay ${T('t2000')} & wait`]);
const killAll = async () => {
    for (const c of kids) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
    for (const n of ['pw-cat', 'paplay', 'selfplay']) { try { execFileSync('pkill', ['-KILL', '-x', n]); } catch {} }
    kids.clear();
    await sleep(500);
};

// ── main.ts's composition, with the real modules ────────────────────────────
const SENDER = 1;
function newMain(clock) {
    const now = clock ?? Date.now;
    const consent = consentMod.createCaptureConsent({ confirm: async () => false, now });
    const appAudio = appAudioMod.createAppAudio({ now });
    return { consent, appAudio, now };
}
/** The picker's choice of a window, a real click, and the getDisplayMedia answer: a live WINDOW share + its grant token. */
async function liveWindowShare(m, sender = SENDER, sourceId = 'window:77:0') {
    m.consent.notePresence(sender);
    const minted = m.consent.mint(sender, sourceId, true);
    if (!minted.ok) throw new Error('mint');
    const v = await m.consent.authorizeVideo(sender, minted.token, { id: sourceId, name: 'a window' }, false);
    if (!v.allowed) throw new Error('video not allowed');
    return minted.token;
}
/** audio:list-apps */
const listApps = (m, own, sender = SENDER) => m.appAudio.list(sender, () => addon.listApps(own));
/** audio:start-app-capture: authorizeAppStart, then the addon with ONLY the key main resolved. */
async function startApp(m, own, handle, token, cb) {
    const d = appAudioMod.authorizeAppStart({ platform: 'linux', viaPortal: true, appAudio: m.appAudio, consent: m.consent }, SENDER, handle, token);
    if (!d.ok) return d;
    addon.startCapture(own, 'app', cb, d.key);
    return d;
}

// ── recording ───────────────────────────────────────────────────────────────
function recorder() {
    const chunks = [];      // { t, buf }
    const events = [];
    const t0 = Date.now();
    const cb = (c) => {
        if (c.data) chunks.push({ t: Date.now() - t0, buf: Buffer.from(c.data) }); else events.push({ t: Date.now() - t0, ...c });
    };
    /** Spectrum (left channel) of the PCM that arrived in [fromMs, toMs). */
    const window = (fromMs, toMs = Infinity) => {
        const bufs = chunks.filter((c) => c.t >= fromMs && c.t < toMs).map((c) => c.buf);
        const all = Buffer.concat(bufs);
        const f = new Float32Array(all.buffer, all.byteOffset, Math.floor(all.length / 4));
        const L = new Float32Array(f.length / 2);
        for (let i = 0; i < L.length; i++) L[i] = f[2 * i];
        return { spec: spectrum(L), seconds: +(L.length / RATE).toFixed(2) };
    };
    return { cb, window, events, chunks, t0 };
}
const fmt = (s) => `440=${s.at440} 1000=${s.at1000} 2000=${s.at2000} dBFS`;
const flush = (name, extra) => results.scenarios.push({ name, ...extra });

// ════════════════════════════════════════════════════════════════════════════
const sup = addon.isSupported();
assert('addon exports listApps', typeof addon.listApps === 'function', Object.keys(addon).sort().join(', '));
assert('isSupported() is true with a PipeWire daemon, a session manager and a sink', sup === true);
if (!sup || typeof addon.listApps !== 'function') { fs.writeFileSync(`${OUT}/app-results.json`, JSON.stringify(results, null, 2)); process.exit(1); }

// ── S1  the list ────────────────────────────────────────────────────────────
let handleA, handleB, listedNames = [];
{
    const OWN = startOwn(); const A = playA(); const B = playB();
    await sleep(1500);
    const m = newMain();
    const t = Date.now();
    const raw = addon.listApps(OWN.pid);
    results.listMs.push(Date.now() - t);
    const listed = listApps(m, OWN.pid);
    listedNames = listed.map((a) => a.name).sort();
    const byBin = (bin) => listed.find((a) => a.binary === bin);
    assert('S1  the list shows A (paplay, program pacat) and B (pw-cat)', !!byBin('pacat') && !!byBin('pw-cat'), `listed ${listed.length} application(s)`);
    assert('S1  the list does NOT show "self" (a child of the excluded pid), by name or program', !listed.some((a) => /selfplay/i.test(a.name + a.binary)) && !raw.some((a) => /selfplay/i.test(a.key + a.name + a.binary)), `raw=${raw.length} listed=${listed.length}`);
    assert('S1  exactly the two foreign applications, once each (de-duplicated)', listed.length === 2 && new Set(listed.map((a) => a.handle)).size === 2, JSON.stringify(listed.map((a) => a.binary)));
    assert('S1  what the renderer gets is {handle, name, binary} - no key, no pid', listed.every((a) => Object.keys(a).sort().join() === 'binary,handle,name' && /^aa_/.test(a.handle) && !JSON.stringify(a).includes('|')), JSON.stringify(Object.keys(listed[0] ?? {})));
    assert('S1  the raw addon list has a stream count per application', raw.every((a) => a.streams >= 1 && typeof a.key === 'string'), JSON.stringify(raw.map((a) => a.streams)));
    // a second list inside the throttle window reuses the first; handles are stable across lists
    await sleep(appAudioMod.LIST_MIN_INTERVAL_MS + 100);
    const again = listApps(m, OWN.pid);
    assert('S1  the same app keeps the same handle on the next list', again.find((a) => a.binary === 'pacat')?.handle === byBin('pacat').handle);
    handleA = byBin('pacat')?.handle; handleB = byBin('pw-cat')?.handle;
    flush('S1 list', { listed: listed.map((a) => ({ name: a.name, binary: a.binary })), listMsFirst: results.listMs[0] });
    await killAll();
}

// ── S2/S3  include A only, include B only ───────────────────────────────────
async function includeOnly(label, pick, expect) {
    const OWN = startOwn(); const A = playA(); const B = playB();
    await sleep(1500);
    const m = newMain();
    const listed = listApps(m, OWN.pid);
    const h = listed.find((a) => a.binary === pick)?.handle;
    const token = await liveWindowShare(m);
    const rec = recorder();
    const d = await startApp(m, OWN.pid, h, token, rec.cb);
    assert(`${label}  the start is authorized (issued handle + live window share grant)`, d.ok === true, JSON.stringify(d.ok ? { ok: true } : d));
    await sleep(3500);
    addon.stopCapture();
    const w = rec.window(500);
    await sleep(300);
    const after = execFileSync('pw-dump', { maxBuffer: 64 << 20 }).toString();
    flush(label, { pick, seconds: w.seconds, spec: w.spec, events: rec.events });
    console.log(`   [${label}] ${w.seconds}s of PCM: ${fmt(w.spec)}  top peaks ${JSON.stringify(w.spec.peaks)}`);
    const present = expect.present, absent = expect.absent;
    assert(`${label}  ${present.hz} Hz (${pick}) is captured`, w.spec[present.key] > PRESENT, fmt(w.spec));
    for (const ab of absent) assert(`${label}  ${ab.hz} Hz (${ab.who}) is absent`, w.spec[ab.key] < ABSENT, fmt(w.spec));
    assert(`${label}  stopCapture() removes our node and its links`, !after.includes('cipherline-share-audio'), 'pw-dump has no cipherline-share-audio after stop');
    await killAll();
    return w;
}
await includeOnly('S2 include A', 'pacat',
    { present: { hz: 440, key: 'at440' }, absent: [{ hz: 1000, key: 'at1000', who: 'B' }, { hz: 2000, key: 'at2000', who: 'self' }] });
await includeOnly('S3 include B', 'pw-cat',
    { present: { hz: 1000, key: 'at1000' }, absent: [{ hz: 440, key: 'at440', who: 'A' }, { hz: 2000, key: 'at2000', who: 'self' }] });

// ── S4  A's stream restarts mid-capture (a new process, a new stream): it is re-linked ─────────
{
    const OWN = startOwn(); let A = playA(); const B = playB();
    await sleep(1500);
    const m = newMain();
    const h = listApps(m, OWN.pid).find((a) => a.binary === 'pacat').handle;
    const rec = recorder();
    const d = await startApp(m, OWN.pid, h, await liveWindowShare(m), rec.cb);
    assert('S4  start authorized', d.ok === true);
    await sleep(2800);                                              // A has been linked for a while
    const killedAt = Date.now() - rec.t0;
    process.kill(A.pid, 'SIGKILL');
    await sleep(500);
    A = playA();                                                    // the app comes back with a NEW stream
    const restartedAt = Date.now() - rec.t0;
    await sleep(3200);
    addon.stopCapture();
    const before = rec.window(killedAt - 2200, killedAt - 100);
    const during = rec.window(killedAt + 100, restartedAt - 50);
    const after = rec.window(restartedAt + 1000);
    console.log(`   [S4] before the restart: ${fmt(before.spec)} | after: ${fmt(after.spec)} (${after.seconds}s) | events ${JSON.stringify(rec.events)}`);
    flush('S4 restart', { before: before.spec, after: after.spec, events: rec.events });
    assert('S4  before the restart: A (440 Hz) is captured', before.spec.at440 > PRESENT, fmt(before.spec));
    assert('S4  A\'s NEW stream after the restart is re-linked: 440 Hz is back', after.spec.at440 > PRESENT, fmt(after.spec));
    assert('S4  B and self stay out, before and after', before.spec.at1000 < ABSENT && after.spec.at1000 < ABSENT && before.spec.at2000 < ABSENT && after.spec.at2000 < ABSENT, `${fmt(before.spec)} | ${fmt(after.spec)}`);
    assert('S4  a restart that is quick is NOT reported as the app quitting', !rec.events.some((e) => e.processExited), JSON.stringify(rec.events));
    await killAll();
}

// ── S5  the app is not playing when the capture starts, and starts later; the handle stayed good ──────
{
    const OWN = startOwn(); let A = playA();
    await sleep(1500);
    const m = newMain();
    const h = listApps(m, OWN.pid).find((a) => a.binary === 'pacat').handle;
    process.kill(A.pid, 'SIGKILL');
    await sleep(800);                                               // the app went quiet; the handle must stay valid
    const B = playB();
    const rec = recorder();
    const d = await startApp(m, OWN.pid, h, await liveWindowShare(m), rec.cb);
    assert('S5  a handle for an app that has gone quiet still starts a capture', d.ok === true, JSON.stringify(d));
    await sleep(1200);
    A = playA();                                                    // ...and its stream is picked up when it appears
    const startedAt = Date.now() - rec.t0;
    await sleep(3000);
    addon.stopCapture();
    const w = rec.window(startedAt + 800);
    console.log(`   [S5] ${fmt(w.spec)}`);
    flush('S5 starts later', { spec: w.spec, events: rec.events });
    assert('S5  a stream that appears AFTER the capture started is picked up (440 Hz)', w.spec.at440 > PRESENT, fmt(w.spec));
    assert('S5  while another app (B) plays, it stays out (1000 Hz absent)', w.spec.at1000 < ABSENT, fmt(w.spec));
    await killAll();
}

// ── S6  the app quits: { processExited } (and a pause is not a quit: see S4/S5) ─────────────────────
{
    const OWN = startOwn(); const A = playA(); const B = playB();
    await sleep(1500);
    const m = newMain();
    const h = listApps(m, OWN.pid).find((a) => a.binary === 'pacat').handle;
    const rec = recorder();
    await startApp(m, OWN.pid, h, await liveWindowShare(m), rec.cb);
    await sleep(2000);
    const killAt = Date.now() - rec.t0;
    process.kill(A.pid, 'SIGKILL');
    await sleep(5000);
    const ex = rec.events.find((e) => e.processExited);
    console.log(`   [S6] events ${JSON.stringify(rec.events)} killAt=${killAt}`);
    flush('S6 quit', { events: rec.events, killAt });
    assert('S6  the app quitting is reported as { processExited } within ~4 s', !!ex && ex.t - killAt < 4500, ex ? `${ex.t - killAt} ms after the kill` : 'no event');
    assert('S6  B (still playing) does not keep A alive', !!ex);
    addon.stopCapture();
    await killAll();
}

// ── S7  Cipherline's own tree is never captured, whatever the key says ─────────────────────────────
{
    const OWN = startOwn(); const B = playB();
    await sleep(1500);
    // (a) the addon itself, handed the key of our own player: excluded
    const rec = recorder();
    addon.startCapture(OWN.pid, 'app', rec.cb, 'selfplay|selfplay');
    await sleep(3000);
    addon.stopCapture();
    const w = rec.window(500);
    // (b) negative control: the same key with an UNRELATED pid as "own" captures the 2000 Hz tone (the key is valid)
    const unrelated = spawnP('sleep', ['60']);
    const rec2 = recorder();
    addon.startCapture(unrelated.pid, 'app', rec2.cb, 'selfplay|selfplay');
    await sleep(3000);
    addon.stopCapture();
    const w2 = rec2.window(500);
    console.log(`   [S7] own tree as the key: ${fmt(w.spec)} | negative control (unrelated own pid): ${fmt(w2.spec)}`);
    flush('S7 self', { excluded: w.spec, control: w2.spec });
    assert('S7  asking for our own player\'s key captures nothing of it (2000 Hz absent)', w.spec.at2000 < ABSENT && w.spec.at1000 < ABSENT, fmt(w.spec));
    assert('S7  NEGATIVE CONTROL: the same key with another "own" pid DOES capture 2000 Hz', w2.spec.at2000 > PRESENT, fmt(w2.spec));
    // (c) an empty / missing key starts nothing at all
    const rec3 = recorder();
    addon.startCapture(OWN.pid, 'app', rec3.cb);
    addon.startCapture(OWN.pid, 'app', rec3.cb, '');
    await sleep(1500);
    addon.stopCapture();
    assert('S7  a missing or empty key captures nothing', rec3.chunks.length === 0, `chunks=${rec3.chunks.length}`);
    await killAll();
}

// ── S8  main's rules: a handle main did not issue, no grant, wrong grant, expired handle ───────────
{
    const OWN = startOwn(); const A = playA(); const B = playB();
    await sleep(1500);
    const m = newMain();
    const listed = listApps(m, OWN.pid);
    const real = listed.find((a) => a.binary === 'pacat').handle;
    const token = await liveWindowShare(m);
    const rec = recorder();
    const deps = { platform: 'linux', viaPortal: true, appAudio: m.appAudio, consent: m.consent };
    const tries = {
        forged: appAudioMod.authorizeAppStart(deps, SENDER, 'aa_forgedhandle0000000000', token),
        rawKey: appAudioMod.authorizeAppStart(deps, SENDER, 'pacat|paplay', token),
        aPid: appAudioMod.authorizeAppStart(deps, SENDER, A.pid, token),
        aBinaryName: appAudioMod.authorizeAppStart(deps, SENDER, 'paplay', token),
        otherWindow: appAudioMod.authorizeAppStart(deps, SENDER + 1, real, token),
        noGrant: appAudioMod.authorizeAppStart(deps, SENDER, real, undefined),
    };
    for (const [k, v] of Object.entries(tries)) {
        if (k === 'noGrant') assert('S8  no share grant: refused (consent)', v.ok === false && v.why === 'consent', JSON.stringify(v));
        else assert(`S8  ${k}: a handle main did not issue is refused`, v.ok === false && v.why === 'bad_handle', JSON.stringify(v));
    }
    // nothing above reached the addon, and the real grant was not burned by the forged attempts
    const ok = await startApp(m, OWN.pid, real, token, rec.cb);
    assert('S8  the real handle + the (unburned) grant still starts', ok.ok === true, JSON.stringify(ok));
    await sleep(2500);
    addon.stopCapture();
    const w = rec.window(500);
    assert('S8  and it captures A only', w.spec.at440 > PRESENT && w.spec.at1000 < ABSENT, fmt(w.spec));
    // the grant is single-use for audio
    const replay = appAudioMod.authorizeAppStart(deps, SENDER, real, token);
    assert('S8  the same grant cannot start a second capture', replay.ok === false && replay.why === 'consent', JSON.stringify(replay));
    // a screen grant is not a window share
    m.consent.notePresence(SENDER);
    const sm = m.consent.mint(SENDER, 'screen:0:0', true);
    await m.consent.authorizeVideo(SENDER, sm.token, { id: 'screen:0:0', name: 'screen' }, false);
    const sc = appAudioMod.authorizeAppStart(deps, SENDER, real, sm.token);
    assert('S8  a SCREEN share\'s grant does not start an app capture', sc.ok === false && sc.why === 'consent', JSON.stringify(sc));
    // handles expire: unstarted after the TTL, started ones with the share
    let now = 1_000_000;
    const clock = () => now;
    const m2 = newMain(clock);
    const l2 = listApps(m2, OWN.pid);
    const h2 = l2.find((a) => a.binary === 'pacat').handle;
    now += appAudioMod.HANDLE_TTL_MS + 1;
    assert('S8  an unstarted handle expires', m2.appAudio.resolve(SENDER, h2) === null);
    const m3 = newMain(clock);
    const h3 = listApps(m3, OWN.pid).find((a) => a.binary === 'pacat').handle;
    const t3 = await liveWindowShare(m3);
    const d3 = appAudioMod.authorizeAppStart({ platform: 'linux', viaPortal: true, appAudio: m3.appAudio, consent: m3.consent }, SENDER, h3, t3);
    m3.appAudio.endShare(SENDER);
    now += appAudioMod.SHARE_GAP_MS + 1;
    assert('S8  a started handle runs out SHARE_GAP_MS after its share ends', d3.ok === true && m3.appAudio.resolve(SENDER, h3) === null);
    flush('S8 rules', { tries: Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, v.ok ? 'ok' : v.why])) });
    await killAll();
}

// ── S9  no application name in the addon's debug output (counts only) ─────────────────────────────
{
    const OWN = startOwn(); const A = playA(); const B = playB();
    await sleep(1500);
    const probe = `
        const a = require('${process.env.ADDON || '/addon/audio_capture.node'}');
        const apps = a.listApps(${OWN.pid});
        a.startCapture(${OWN.pid}, 'app', () => {}, apps.find((x) => x.binary === 'pacat').key);
        setTimeout(() => { a.stopCapture(); process.exit(0); }, 2500);`;
    const child = spawn(process.execPath, ['-e', probe], { env: { ...process.env, CIPHERLINE_AUDIO_DEBUG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => { err += d; });
    await new Promise((r) => child.on('exit', r));
    const lines = err.split('\n').filter((l) => l.includes('[audio_capture_linux]'));
    console.log(`   [S9] ${lines.length} debug line(s); sample: ${lines.slice(0, 3).join(' | ')}`);
    flush('S9 debug output', { lines: lines.length });
    assert('S9  the addon\'s debug output exists (positive control) ...', lines.length > 3, `${lines.length} lines`);
    assert('S9  ... and carries no application name, program name or pid of anything', !/paplay|pacat|pw-cat|selfplay|bash/i.test(err), 'checked for paplay / pacat / pw-cat / selfplay / bash');
    await killAll();
}

// ── S10 speed of the list ─────────────────────────────────────────────────────────────────────────
{
    const OWN = startOwn(); const A = playA(); const B = playB();
    await sleep(1200);
    const times = [];
    for (let i = 0; i < 8; i++) { const t = Date.now(); addon.listApps(OWN.pid); times.push(Date.now() - t); }
    results.listMs = times;
    console.log(`   [S10] listApps() ms: ${times.join(', ')}`);
    assert('S10 listApps() is a short round trip (every call under 1 s)', Math.max(...times) < 1000, `max ${Math.max(...times)} ms, median ${[...times].sort((a, b) => a - b)[4]} ms`);
    // 40 list+start cycles: no crash, no fd leak
    const fds0 = fs.readdirSync('/proc/self/fd').length;
    const m = newMain();
    for (let i = 0; i < 25; i++) {
        const key = addon.listApps(OWN.pid)[0]?.key ?? 'x|x';
        addon.startCapture(OWN.pid, 'app', () => {}, key);
        if (i % 3 === 0) await sleep(60);
        addon.stopCapture();
    }
    await sleep(300);
    const fds1 = fs.readdirSync('/proc/self/fd').length;
    assert('S10 25 list + start/stop cycles do not crash or leak descriptors', fds1 - fds0 < 8, `fds ${fds0} -> ${fds1}`);
    await killAll();
}

fs.writeFileSync(`${OUT}/app-results.json`, JSON.stringify(results, null, 2));
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} (${results.assertions.length} assertions)`);
process.exit(failures === 0 ? 0 : 1);
