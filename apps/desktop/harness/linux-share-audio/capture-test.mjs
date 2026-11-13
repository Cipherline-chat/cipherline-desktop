// Real exclusion test for src-native/audio_capture_linux.cc. Runs INSIDE the container started by
// run.sh, with a live pipewire + wireplumber + pipewire-pulse and a null sink.
//
//   440 Hz  played by process "A"  (the process we pretend is Cipherline)
//   1000 Hz played by process "B"  (everything else the computer plays)
//
// Each scenario starts a capture FIRST and the players afterwards (so it also proves streams that
// appear later are picked up), records ~3.5 s of PCM through the addon, and FFTs it.
//
// Exit code 0 only if every assertion holds. Machine-readable results go to $OUT/results.json.
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const addon = require(process.env.ADDON || '/addon/audio_capture.node');
const OUT = process.env.OUT || '/out';
const WAV = '/tmp/tones';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = { scenarios: [], assertions: [], routing: null, lifecycle: null };
let failures = 0;
function assert(name, ok, detail) {
    results.assertions.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
    if (!ok) failures++;
}

import { fft, spectrum, RATE, N } from './dsp.mjs';

// ── players ─────────────────────────────────────────────────────────────────
const kids = new Set();
function spawnPlayer(cmd, args) {
    const c = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    c.stderr.on('data', () => {});
    kids.add(c);
    c.on('exit', () => kids.delete(c));
    return c;
}
const pwcat = (file) => ['pw-cat', ['-p', file]];
const killAll = async () => {
    for (const c of kids) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
    try { execFileSync('pkill', ['-KILL', '-x', 'pw-cat']); } catch {}
    try { execFileSync('pkill', ['-KILL', '-x', 'paplay']); } catch {}
    await sleep(500);
};

// ── capture helper ──────────────────────────────────────────────────────────
function pwDump() { return JSON.parse(execFileSync('pw-dump', { maxBuffer: 64 << 20 }).toString()); }
const props = (o) => o?.info?.props ?? {};

/** Links summarised as "<out node's pid or name class> -> <in node name>". No media names are read. */
function linkSummary(dump) {
    const nodes = new Map(dump.filter((o) => o.type === 'PipeWire:Interface:Node').map((o) => [o.id, o]));
    const clients = new Map(dump.filter((o) => o.type === 'PipeWire:Interface:Client').map((o) => [o.id, o]));
    // A stream's pids: its own application.process.id, else its client's (claimed, then kernel-attested).
    const pidsOf = (n) => {
        const c = clients.get(props(n)['client.id']);
        return [props(n)['application.process.id'], props(c)['application.process.id'], props(c)['pipewire.sec.pid']]
            .map((v) => Number(v || 0)).filter((v) => v > 0);
    };
    const out = [];
    for (const o of dump) {
        if (o.type !== 'PipeWire:Interface:Link') continue;
        const a = nodes.get(o.info['output-node-id']), b = nodes.get(o.info['input-node-id']);
        out.push({
            fromPids: pidsOf(a),
            fromClass: props(a)['media.class'], to: props(b)['node.name'],
            outPort: o.info['output-port-id'], inPort: o.info['input-port-id'], state: o.info.state,
        });
    }
    return out;
}

async function capture({ label, pid, mode, players, ms = 3500, during }) {
    const chunks = [];
    const events = [];
    let cb = (c) => {
        if (c.data) chunks.push(Buffer.from(c.data)); else events.push(c);
    };
    const startedAt = Date.now();
    addon.startCapture(pid, mode, (c) => cb(c));
    await sleep(400);                                // capture is up BEFORE the players exist
    const procs = players.map(([cmd, args]) => spawnPlayer(cmd, args));
    await sleep(ms * 0.6);
    const mid = during ? await during(procs) : null;
    await sleep(ms * 0.4);
    addon.stopCapture();
    const elapsed = Date.now() - startedAt;
    cb = () => {};
    await killAll();
    const all = Buffer.concat(chunks);
    const f = new Float32Array(all.buffer, all.byteOffset, Math.floor(all.length / 4));
    const L = new Float32Array(f.length / 2), R = new Float32Array(f.length / 2);
    for (let i = 0; i < L.length; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
    const r = { label, mode, chunks: chunks.length, seconds: +(L.length / RATE).toFixed(2), elapsedMs: elapsed, events, L: spectrum(L), R: spectrum(R), mid };
    results.scenarios.push(r);
    console.log(`\n[${label}] mode=${mode} chunks=${r.chunks} (${r.seconds}s of PCM) events=${JSON.stringify(events)}`);
    console.log(`   L: 440Hz=${r.L.at440} dBFS  1000Hz=${r.L.at1000} dBFS   top peaks ${JSON.stringify(r.L.peaks)}`);
    console.log(`   R: 440Hz=${r.R.at440} dBFS  1000Hz=${r.R.at1000} dBFS`);
    return r;
}
const PRESENT = -25;     // a 0.25-amplitude sine is about -12 dBFS
const ABSENT = -90;      // digital silence in that bin

// ── scenarios ───────────────────────────────────────────────────────────────
console.log('addon exports:', Object.keys(addon).sort().join(', '));
const sup = addon.isSupported();
assert('isSupported() is true with a PipeWire daemon, a session manager and a sink', sup === true, `got ${sup}`);
if (!sup) { fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2)); process.exit(1); }

const T = (n) => `${WAV}/${n}.wav`;

// S1  exclude A where A IS the player process: `exec` keeps bash's pid == pw-cat's pid
{
    const A = spawnPlayer('bash', ['-c', 'sleep 0.6; exec pw-cat -p ' + T('t440')]);
    const r = await capture({
        label: 'S1 exclude A (A is the playing process itself)', pid: A.pid, mode: 'exclude',
        players: [pwcat(T('t1000'))],
    });
    assert('S1  exclude A: B (1000 Hz) is captured', r.L.at1000 > PRESENT && r.R.at1000 > PRESENT, `L=${r.L.at1000} R=${r.R.at1000} dBFS`);
    assert('S1  exclude A: A (440 Hz) is absent', r.L.at440 < ABSENT && r.R.at440 < ABSENT, `L=${r.L.at440} R=${r.R.at440} dBFS`);
}

// S2  exclude A where the player is a CHILD of A (A = bash)
{
    const A = spawnPlayer('bash', ['-c', `sleep 0.6; pw-cat -p ${T('t440')} & wait`]);
    const r = await capture({
        label: 'S2 exclude A (player is a CHILD of A)', pid: A.pid, mode: 'exclude',
        players: [pwcat(T('t1000'))],
    });
    assert('S2  child of excluded pid is excluded too (440 Hz absent)', r.L.at440 < ABSENT && r.R.at440 < ABSENT, `L=${r.L.at440} R=${r.R.at440} dBFS`);
    assert('S2  other process still captured (1000 Hz present)', r.L.at1000 > PRESENT && r.R.at1000 > PRESENT, `L=${r.L.at1000} R=${r.R.at1000} dBFS`);
}

// S2b grandchild: A -> bash -> pw-cat
{
    const A = spawnPlayer('bash', ['-c', `sleep 0.6; bash -c "pw-cat -p ${T('t440')} & wait" & wait`]);
    const r = await capture({
        label: 'S2b exclude A (player is a GRANDCHILD of A)', pid: A.pid, mode: 'exclude',
        players: [pwcat(T('t1000'))],
    });
    assert('S2b grandchild of excluded pid is excluded (440 Hz absent)', r.L.at440 < ABSENT && r.R.at440 < ABSENT, `L=${r.L.at440} R=${r.R.at440} dBFS`);
    assert('S2b other process still captured (1000 Hz present)', r.L.at1000 > PRESENT, `L=${r.L.at1000} dBFS`);
}

// S3  NEGATIVE CONTROL: exclude a pid that owns neither player -> both tones must appear
{
    const A = spawnPlayer('bash', ['-c', `sleep 0.6; pw-cat -p ${T('t440')} & wait`]);
    const unrelated = spawnPlayer('sleep', ['60']);        // a real process that owns no audio and is nobody's ancestor
    const r = await capture({
        label: 'S3 NEGATIVE CONTROL: wrong exclude pid (an unrelated process)', pid: unrelated.pid, mode: 'exclude',
        players: [pwcat(T('t1000'))],
    });
    assert('S3  wrong pid: 440 Hz present', r.L.at440 > PRESENT && r.R.at440 > PRESENT, `L=${r.L.at440} R=${r.R.at440} dBFS`);
    assert('S3  wrong pid: 1000 Hz present', r.L.at1000 > PRESENT && r.R.at1000 > PRESENT, `L=${r.L.at1000} R=${r.R.at1000} dBFS`);
}

// S4  include mode: only A's tree
{
    const A = spawnPlayer('bash', ['-c', `sleep 0.6; pw-cat -p ${T('t440')} & wait`]);
    const r = await capture({
        label: 'S4 include A (tree)', pid: A.pid, mode: 'include',
        players: [pwcat(T('t1000'))],
    });
    assert('S4  include A: 440 Hz present', r.L.at440 > PRESENT && r.R.at440 > PRESENT, `L=${r.L.at440} R=${r.R.at440} dBFS`);
    assert('S4  include A: 1000 Hz absent', r.L.at1000 < ABSENT && r.R.at1000 < ABSENT, `L=${r.L.at1000} R=${r.R.at1000} dBFS`);
}

// S5  through pipewire-pulse (paplay = how Chromium plays): pid attribution via application.process.id
{
    const A = spawnPlayer('bash', ['-c', `sleep 0.6; paplay ${T('t440')} & wait`]);
    const r = await capture({
        label: 'S5 exclude A, players are PulseAudio clients (paplay via pipewire-pulse)', pid: A.pid, mode: 'exclude',
        players: [['paplay', [T('t1000')]]],
    });
    assert('S5  pulse client B captured (1000 Hz present)', r.L.at1000 > PRESENT && r.R.at1000 > PRESENT, `L=${r.L.at1000} R=${r.R.at1000} dBFS`);
    assert('S5  pulse client child of A excluded (440 Hz absent)', r.L.at440 < ABSENT && r.R.at440 < ABSENT, `L=${r.L.at440} R=${r.R.at440} dBFS`);
}

// S6  a MONO source lands on BOTH channels
{
    const A = spawnPlayer('bash', ['-c', `sleep 0.6; pw-cat -p ${T('t440')} & wait`]);
    const r = await capture({
        label: 'S6 mono source B (1 channel) -> both sides', pid: A.pid, mode: 'exclude',
        players: [['pw-cat', ['-p', '--channels', '1', T('t1000mono')]]],
    });
    assert('S6  mono 1000 Hz appears on LEFT', r.L.at1000 > PRESENT, `L=${r.L.at1000} dBFS`);
    assert('S6  mono 1000 Hz appears on RIGHT', r.R.at1000 > PRESENT, `R=${r.R.at1000} dBFS`);
    assert('S6  mono source is not louder on one side', Math.abs(r.L.at1000 - r.R.at1000) < 1, `L=${r.L.at1000} R=${r.R.at1000}`);
}

// S7  routing is untouched: B keeps its link to the sink while we listen, nothing is rerouted
{
    let beforeLinks = null;
    const before = spawnPlayer(...pwcat(T('t1000')));
    await sleep(1200);
    beforeLinks = linkSummary(pwDump());
    const defaultBefore = execFileSync('pw-metadata', ['-n', 'default', '0', 'default.audio.sink']).toString();
    process.kill(before.pid, 'SIGKILL'); kids.delete(before);
    await sleep(600);
    const A = spawnPlayer('bash', ['-c', `sleep 0.6; pw-cat -p ${T('t440')} & wait`]);
    const r = await capture({
        label: 'S7 routing check', pid: A.pid, mode: 'exclude',
        players: [pwcat(T('t1000'))],
        during: async () => ({
            aChildren: execFileSync('pgrep', ['-P', String(A.pid)]).toString().split('\n').filter(Boolean).map(Number),
            links: linkSummary(pwDump()),
            defaultSink: execFileSync('pw-metadata', ['-n', 'default', '0', 'default.audio.sink']).toString(),
        }),
    });
    const sinkName = 'cipherline-test-sink';
    const duringLinks = r.mid.links;
    const toSink = duringLinks.filter((l) => l.to === sinkName);
    const toUs = duringLinks.filter((l) => l.to === 'cipherline-share-audio');
    const toSinkBefore = beforeLinks.filter((l) => l.to === sinkName).length;
    results.routing = { sink: sinkName, linksToSinkBeforeCapture: toSinkBefore, linksDuringCapture: duringLinks, defaultSinkBefore: defaultBefore.trim(), defaultSinkDuring: r.mid.defaultSink.trim() };
    const intoUsPids = new Set(toUs.flatMap((l) => l.fromPids));
    const aTree = new Set([A.pid, ...r.mid.aChildren]);
    // Two stereo players (A's child excluded from our listening, B listened to): each keeps both links to the sink.
    assert('S7  every player is still linked to the real sink (routing untouched)', toSink.length >= 4, `links to the sink during capture: ${toSink.length} (B alone, before: ${toSinkBefore})`);
    assert('S7  we listen via extra links into our own capture node only', toUs.length === 2, `links into the capture node: ${toUs.length} (B's FL+FR)`);
    assert('S7  the excluded tree (A and its child) has NO link into our node', ![...intoUsPids].some((p) => aTree.has(p)), `excluded pids ${JSON.stringify([...aTree])}, pids linked into us ${JSON.stringify([...intoUsPids])}`);
    assert('S7  default sink unchanged', defaultBefore.trim() === r.mid.defaultSink.trim(), r.mid.defaultSink.trim().split('\n').pop());
    await sleep(500);
    const after = linkSummary(pwDump()).filter((l) => l.to === 'cipherline-share-audio');
    assert('S7  after stopCapture() our node and its links are gone', after.length === 0, `links remaining into capture node: ${after.length}`);
}

// S8  lifecycle: stop twice, stop with nothing running, restart
{
    let threw = null;
    try { addon.stopCapture(); addon.stopCapture(); } catch (e) { threw = e; }
    assert('S8  stopCapture() with nothing running, twice, is safe', !threw, String(threw ?? ''));
    const A = spawnPlayer('bash', ['-c', `sleep 0.6; pw-cat -p ${T('t440')} & wait`]);
    const r1 = await capture({ label: 'S8a start/stop #1', pid: A.pid, mode: 'exclude', players: [pwcat(T('t1000'))], ms: 2500 });
    const r2 = await capture({ label: 'S8b start/stop #2 (restart after stop)', pid: A.pid, mode: 'exclude', players: [pwcat(T('t1000'))], ms: 2500 });
    assert('S8  a second capture after stop works', r2.chunks > 50 && r2.L.at1000 > PRESENT, `chunks=${r2.chunks} 1000Hz=${r2.L.at1000}`);
    // start twice without stop: the first is replaced
    let c1 = 0, c2 = 0;
    const unrelated = spawnPlayer('sleep', ['60']);
    addon.startCapture(unrelated.pid, 'exclude', (c) => { if (c.data) c1++; });
    addon.startCapture(unrelated.pid, 'exclude', (c) => { if (c.data) c2++; });
    const P = spawnPlayer(...pwcat(T('t1000')));
    await sleep(1800);
    addon.stopCapture(); addon.stopCapture();
    const c1After = c1; await sleep(500);
    await killAll();
    assert('S8  starting twice replaces the first capture (old callback goes quiet)', c1 === c1After && c2 > 20, `first=${c1} second=${c2}`);
    results.lifecycle = { stopTwice: !threw, restartChunks: r2.chunks, replaced: { first: c1, second: c2 } };
}

// S9  include mode: target exit is reported
{
    const A = spawnPlayer('bash', ['-c', 'sleep 1.5']);
    let exited = false;
    addon.startCapture(A.pid, 'include', (c) => { if (c.processExited) exited = true; });
    await sleep(3500);
    addon.stopCapture();
    assert('S9  include mode reports { processExited } when the target quits', exited);
}

// S9b safety net: a stream that cannot be tied to the excluded TREE (a pid from another PID namespace is the
// usual way) is still excluded when it comes from the very same EXECUTABLE. The excluded process here is a copy
// of `sleep` named pw-cat; the 1000 Hz pw-cat player is in no way its descendant, yet shares its executable name.
{
    fs.mkdirSync('/tmp/bin', { recursive: true });
    fs.copyFileSync('/usr/bin/sleep', '/tmp/bin/pw-cat');
    fs.chmodSync('/tmp/bin/pw-cat', 0o755);
    const X = spawnPlayer('/tmp/bin/pw-cat', ['60']);
    const r = await capture({
        label: 'S9b exclude by executable name (not a descendant)', pid: X.pid, mode: 'exclude',
        players: [pwcat(T('t1000')), ['paplay', [T('t440')]]],
    });
    assert('S9b same-executable stream (pw-cat, 1000 Hz) is excluded even though it is not in the tree', r.L.at1000 < ABSENT && r.R.at1000 < ABSENT, `L=${r.L.at1000} R=${r.R.at1000} dBFS`);
    assert('S9b a different executable (paplay, 440 Hz) is still captured', r.L.at440 > PRESENT && r.R.at440 > PRESENT, `L=${r.L.at440} R=${r.R.at440} dBFS`);
}

// S10 churn: 25 rapid start/stop cycles with a stream coming and going; the process must survive intact
{
    const unrelated = spawnPlayer('sleep', ['60']);
    let total = 0;
    for (let i = 0; i < 25; i++) {
        addon.startCapture(unrelated.pid, i % 2 ? 'include' : 'exclude', (c) => { if (c.data) total++; });
        const p = spawnPlayer(...pwcat(T('t1000')));
        await sleep(120 + (i % 5) * 40);
        if (i % 3 === 0) addon.stopCapture();
        addon.stopCapture();
        try { process.kill(p.pid, 'SIGKILL'); } catch {}
    }
    await killAll();
    assert('S10 25 rapid start/stop cycles do not crash or hang', true, `chunks seen across cycles: ${total}`);
    const fds = fs.readdirSync('/proc/self/fd').length;
    assert('S10 no descriptor leak after the churn', fds < 40, `open fds: ${fds}`);
}

// S11 the daemon dies mid-capture: a terminal { failed, reason: "unavailable" }, then stop is still safe
{
    const events = [];
    const unrelated = spawnPlayer('sleep', ['60']);
    addon.startCapture(unrelated.pid, 'exclude', (c) => { if (!c.data) events.push(c); });
    await sleep(800);
    execFileSync('pkill', ['-KILL', '-x', 'pipewire']);
    await sleep(1500);
    assert('S11 daemon death is reported as { failed, reason: "unavailable" }', events.some((e) => e.failed && e.reason === 'unavailable'), JSON.stringify(events));
    let threw = null;
    try { addon.stopCapture(); addon.stopCapture(); } catch (e) { threw = e; }
    assert('S11 stopCapture() after the daemon died is safe', !threw);
    await sleep(3500);   // the "no" answer is cached for 3 s
    assert('S11 isSupported() turns false once the daemon is gone', addon.isSupported() === false);
}

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'} (${results.assertions.length} assertions)`);
process.exit(failures === 0 ? 0 : 1);
