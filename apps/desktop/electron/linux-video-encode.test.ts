import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    decideLinuxHwEncode, parseLinuxHwEncodeMode, LINUX_HW_ENCODE_FEATURE, LINUX_HW_ENCODE_ENV,
    LINUX_HW_ENCODE_DEFAULT_ON, LINUX_HW_ENCODE_BLOCKING_SWITCHES,
    LINUX_HW_ENCODE_FAILURE_KINDS, LINUX_HW_ENCODE_LOCKOUT_LAUNCHES, LINUX_HW_ENCODE_LEDGER_WINDOW_MS,
    LINUX_HW_ENCODE_LEDGER_MAX_BYTES, LINUX_HW_ENCODE_LEDGER_FILENAME,
    parseLinuxHwEncodeLedger, serializeLinuxHwEncodeLedger, recordLinuxHwEncodeFailure, activeLedgerEntries,
    isLinuxHwEncodeLockedOut, isLinuxHwEncodeFailureKind, readLinuxHwEncodeLedgerFile, writeLinuxHwEncodeLedgerFile,
    clearLinuxHwEncodeLedgerFile, LinuxHwEncodeFailureGate, isGpuCrashForHwEncode,
    type LinuxHwEncodeLedger,
} from './linux-video-encode';
import { buildChromiumMediaSwitches } from './capture-flags';

const noSwitches = () => false;
const only = (...names: string[]) => (n: string) => names.includes(n);
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const V = '1.0.24';
const entry = (ago: number, kind: (typeof LINUX_HW_ENCODE_FAILURE_KINDS)[number] = 'stall', version = V) => ({ at: NOW - ago, version, kind });
const linux = (over: Partial<Parameters<typeof decideLinuxHwEncode>[0]> = {}) =>
    decideLinuxHwEncode({ platform: 'linux', mode: 'auto', setting: true, hasSwitch: noSwitches, ledger: null, appVersion: V, now: NOW, ...over });

describe('parseLinuxHwEncodeMode', () => {
    it.each([['1', 'on'], ['on', 'on'], ['TRUE', 'on'], [' yes ', 'on'], ['0', 'off'], ['off', 'off'], ['False', 'off'], ['no', 'off']])(
        '%j -> %s', (v, want) => expect(parseLinuxHwEncodeMode(v)).toBe(want));
    it.each([undefined, '', '2', 'maybe', 'enable'])('%j -> auto (never an error: it is a test knob)', (v) => {
        expect(parseLinuxHwEncodeMode(v)).toBe('auto');
    });
});

describe('decideLinuxHwEncode - the launch decision', () => {
    it('is ON by default on Linux with no env var, no setting change and a clean ledger (2026-11-04: measured ~60 fps where VA-API exists, a no-op elsewhere)', () => {
        expect(LINUX_HW_ENCODE_DEFAULT_ON).toBe(true);
        expect(linux()).toEqual({ enable: true, features: ['AcceleratedVideoEncoder'], reason: 'auto: on' });
        expect(LINUX_HW_ENCODE_FEATURE).toBe('AcceleratedVideoEncoder');
        expect(LINUX_HW_ENCODE_ENV).toBe('CIPHERLINE_LINUX_HW_ENCODE');
    });

    it('works without the optional inputs (an older call site that only passes platform / mode / hasSwitch)', () => {
        expect(decideLinuxHwEncode({ platform: 'linux', mode: 'auto', hasSwitch: noSwitches }).enable).toBe(true);
    });

    it('env =0 turns it off and beats everything else', () => {
        expect(linux({ mode: 'off' })).toEqual({ enable: false, features: [], reason: 'off (env)' });
        expect(linux({ mode: 'off', setting: true, ledger: null }).enable).toBe(false);
    });

    it('the Settings toggle off turns it off', () => {
        expect(linux({ setting: false })).toEqual({ enable: false, features: [], reason: 'off (Settings)' });
    });

    it('env =1 forces it on past the Settings toggle AND the failure ledger (a tester\'s knob)', () => {
        const ledger = { entries: [entry(DAY), entry(2 * DAY)] };
        expect(linux({ mode: 'on', setting: false, ledger })).toEqual({ enable: true, features: ['AcceleratedVideoEncoder'], reason: 'on (env)' });
    });

    it('is Linux only - Windows and macOS keep their own encoders (Media Foundation / VideoToolbox)', () => {
        for (const platform of ['win32', 'darwin']) {
            for (const mode of ['auto', 'on', 'off'] as const) {
                expect(linux({ platform, mode })).toEqual({ enable: false, features: [], reason: 'not linux' });
            }
        }
    });

    it('does not even try when the user launched with the GPU or video acceleration switched off - even with env =1', () => {
        expect(LINUX_HW_ENCODE_BLOCKING_SWITCHES).toEqual(['disable-gpu', 'disable-accelerated-video-encode']);
        for (const sw of LINUX_HW_ENCODE_BLOCKING_SWITCHES) {
            for (const mode of ['auto', 'on'] as const) {
                expect(linux({ mode, hasSwitch: only(sw) })).toEqual({ enable: false, features: [], reason: `blocked by --${sw}` });
            }
        }
    });

    it('never enables anything for NVIDIA: VaapiOnNvidiaGPUs and the blocklist override stay untouched', () => {
        // nvidia-vaapi-driver is decode-only; Chromium skips nvidia-drm unless VaapiOnNvidiaGPUs (off by default).
        const d = linux({ mode: 'on' });
        expect(d.features.join(',')).not.toMatch(/Nvidia|ignore/i);
        expect(d.features).toEqual(['AcceleratedVideoEncoder']);
    });
});

describe('the failure ledger and the lockout', () => {
    it('one bad launch does NOT lock hardware encode out; LINUX_HW_ENCODE_LOCKOUT_LAUNCHES do', () => {
        expect(LINUX_HW_ENCODE_LOCKOUT_LAUNCHES).toBe(2);
        expect(linux({ ledger: { entries: [entry(DAY)] } }).enable).toBe(true);
        const d = linux({ ledger: { entries: [entry(2 * DAY, 'drift'), entry(DAY, 'gpu_crash')] } });
        expect(d.enable).toBe(false);
        expect(d.features).toEqual([]);
        expect(d.lockedOut).toBe(true);
        expect(d.reason).toBe('stayed software: 2 launches with an encoder failure (last: gpu_crash)');
    });

    it('a new app version retries (entries from another version do not count)', () => {
        const ledger = { entries: [entry(2 * DAY, 'stall', '1.0.23'), entry(DAY, 'stall', '1.0.23')] };
        expect(linux({ ledger, appVersion: '1.0.24' }).enable).toBe(true);
        expect(linux({ ledger, appVersion: '1.0.23' }).enable).toBe(false);
    });

    it('entries older than the window are forgotten (a driver or Mesa update gets another try)', () => {
        expect(LINUX_HW_ENCODE_LEDGER_WINDOW_MS).toBe(30 * DAY);
        const old = { entries: [entry(31 * DAY), entry(40 * DAY)] };
        expect(linux({ ledger: old }).enable).toBe(true);
        expect(linux({ ledger: { entries: [entry(31 * DAY), entry(DAY)] } }).enable).toBe(true);
        expect(linux({ ledger: { entries: [entry(29 * DAY), entry(DAY)] } }).enable).toBe(false);
    });

    it('a clock that went backwards cannot lock it out forever: far-future entries do not count', () => {
        const future = { entries: [{ at: NOW + 400 * DAY, version: V, kind: 'stall' as const }, { at: NOW + 401 * DAY, version: V, kind: 'stall' as const }] };
        expect(activeLedgerEntries(future, V, NOW)).toEqual([]);
        expect(linux({ ledger: future }).enable).toBe(true);
    });

    it('recordLinuxHwEncodeFailure appends, forgets entries past the window and caps the length', () => {
        let l: LinuxHwEncodeLedger = { entries: [entry(40 * DAY)] };
        l = recordLinuxHwEncodeFailure(l, entry(0, 'hw_lost'));
        expect(l.entries.map(e => e.kind)).toEqual(['hw_lost']);
        for (let i = 0; i < 20; i++) l = recordLinuxHwEncodeFailure(l, entry(0, 'drift'));
        expect(l.entries.length).toBeLessThanOrEqual(8);
        expect(isLinuxHwEncodeLockedOut(l, V, NOW)).toBe(true);
        expect(isLinuxHwEncodeLockedOut(null, V, NOW)).toBe(false);
    });

    it('serialize -> parse round-trips; only the known words reach the file', () => {
        const l: LinuxHwEncodeLedger = { entries: [entry(DAY, 'high_start'), entry(0, 'gpu_crash')] };
        const text = serializeLinuxHwEncodeLedger(l);
        expect(parseLinuxHwEncodeLedger(text)).toEqual(l);
        expect(text.length).toBeLessThan(LINUX_HW_ENCODE_LEDGER_MAX_BYTES);
        expect(Object.keys(JSON.parse(text))).toEqual(['entries']);
        expect(Object.keys(JSON.parse(text).entries[0]).sort()).toEqual(['at', 'kind', 'version']);
    });

    it.each([
        ['empty', ''], ['null', null], ['undefined', undefined], ['malformed', '{"entries":['], ['array', '[1]'],
        ['not an object', '"x"'], ['entries not an array', '{"entries":{}}'],
        ['oversized', 'x'.repeat(LINUX_HW_ENCODE_LEDGER_MAX_BYTES + 1)],
    ])('%s -> empty ledger (never throws)', (_l, text) => {
        expect(parseLinuxHwEncodeLedger(text as string | null | undefined)).toEqual({ entries: [] });
    });

    it('drops bad entries one by one and keeps the good ones', () => {
        const good = entry(DAY);
        const text = JSON.stringify({ entries: [
            good,
            { at: 'x', version: V, kind: 'stall' },
            { at: NOW, version: '', kind: 'stall' },
            { at: NOW, version: V, kind: 'rm -rf' },
            { at: -5, version: V, kind: 'stall' },
            { at: NOW, version: 'v'.repeat(80), kind: 'stall' },
            null, 7,
        ] });
        expect(parseLinuxHwEncodeLedger(text)).toEqual({ entries: [good] });
    });

    it('failure kinds are a closed list', () => {
        expect([...LINUX_HW_ENCODE_FAILURE_KINDS]).toEqual(['gpu_crash', 'hw_lost', 'stall', 'drift', 'high_start']);
        expect(isLinuxHwEncodeFailureKind('stall')).toBe(true);
        for (const bad of ['', 'STALL', 'stall; drop table', 7, null, undefined, {}]) expect(isLinuxHwEncodeFailureKind(bad)).toBe(false);
    });
});

describe('ledger file I/O', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-hwenc-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('write -> read round-trips (0600) and clear removes it', () => {
        const f = path.join(dir, LINUX_HW_ENCODE_LEDGER_FILENAME);
        const l: LinuxHwEncodeLedger = { entries: [entry(DAY, 'drift')] };
        expect(writeLinuxHwEncodeLedgerFile(f, l)).toBe(true);
        expect(readLinuxHwEncodeLedgerFile(f)).toEqual(l);
        expect(fs.statSync(f).mode & 0o777).toBe(0o600);
        clearLinuxHwEncodeLedgerFile(f);
        expect(fs.existsSync(f)).toBe(false);
        expect(readLinuxHwEncodeLedgerFile(f)).toEqual({ entries: [] });
        clearLinuxHwEncodeLedgerFile(f); // absent: no throw
    });

    it('a missing, garbled or oversized file reads as empty, and an unwritable path returns false instead of throwing', () => {
        expect(readLinuxHwEncodeLedgerFile(path.join(dir, 'nope.json'))).toEqual({ entries: [] });
        const f = path.join(dir, 'x.json');
        fs.writeFileSync(f, '{{{');
        expect(readLinuxHwEncodeLedgerFile(f)).toEqual({ entries: [] });
        fs.writeFileSync(f, 'x'.repeat(LINUX_HW_ENCODE_LEDGER_MAX_BYTES + 10));
        expect(readLinuxHwEncodeLedgerFile(f)).toEqual({ entries: [] });
        expect(writeLinuxHwEncodeLedgerFile(path.join(f, 'inside-a-file', 'l.json'), { entries: [] })).toBe(false);
    });
});

describe('the fallback state machine (decision + gate + ledger, as main.ts drives them)', () => {
    it('launch 1 fails -> still on; launch 2 fails -> launch 3 stays software; Settings off/on or a new version retries', () => {
        let ledger: LinuxHwEncodeLedger = { entries: [] };
        const launch = (version: string, at: number, failWith?: (typeof LINUX_HW_ENCODE_FAILURE_KINDS)[number]) => {
            const d = linux({ ledger, appVersion: version, now: at });
            const gate = new LinuxHwEncodeFailureGate();
            if (failWith) {
                // several symptoms in one launch: ONE entry
                for (const k of [failWith, 'stall', 'drift']) if (gate.accept(d.enable, k)) ledger = recordLinuxHwEncodeFailure(ledger, { at, version, kind: k });
            }
            return d;
        };
        expect(launch(V, NOW, 'hw_lost').enable).toBe(true);
        expect(ledger.entries).toHaveLength(1);
        expect(launch(V, NOW + DAY, 'drift').enable).toBe(true);
        expect(ledger.entries).toHaveLength(2);
        const third = launch(V, NOW + 2 * DAY);
        expect(third.enable).toBe(false);
        expect(third.lockedOut).toBe(true);
        // a new app version retries...
        expect(launch('1.0.25', NOW + 3 * DAY).enable).toBe(true);
        // ...and clearing the ledger (Settings toggled back on) does too
        ledger = { entries: [] };
        expect(launch(V, NOW + 3 * DAY).enable).toBe(true);
    });

    it('the gate: only the first valid failure of a launch counts, and only when hardware encode is active', () => {
        const g = new LinuxHwEncodeFailureGate();
        expect(g.accept(false, 'stall')).toBe(false);          // feature not on this launch: nothing to learn
        expect(g.hasRecorded).toBe(false);
        expect(g.accept(true, 'nonsense')).toBe(false);        // outside the allowlist: ignored, does not use up the launch's slot
        expect(g.hasRecorded).toBe(false);
        expect(g.accept(true, 'gpu_crash')).toBe(true);
        expect(g.hasRecorded).toBe(true);
        expect(g.accept(true, 'stall')).toBe(false);           // second symptom, same launch
    });

    it('a GPU crash counts; a clean exit, a kill from outside, and other processes do not', () => {
        expect(isGpuCrashForHwEncode({ type: 'GPU', reason: 'crashed' })).toBe(true);
        expect(isGpuCrashForHwEncode({ type: 'GPU', reason: 'abnormal-exit' })).toBe(true);
        for (const reason of ['clean-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure']) expect(isGpuCrashForHwEncode({ type: 'GPU', reason })).toBe(false);
        expect(isGpuCrashForHwEncode({ type: 'Utility', reason: 'crashed' })).toBe(false);
        expect(isGpuCrashForHwEncode({})).toBe(false);
    });
});

describe('the assembled --enable-features list', () => {
    it('Linux, default: ONE list with the capturer feature and the encoder feature', () => {
        const m = buildChromiumMediaSwitches('linux', 'auto', 'chromium-default', linux().features);
        expect(m.enableFeatures).toEqual(['WebRTCPipeWireCapturer', 'AcceleratedVideoEncoder']);
        expect(m.disableFeatures).toEqual([]);
    });

    it('Linux, off: exactly what it was before this feature existed', () => {
        const m = buildChromiumMediaSwitches('linux', 'auto', 'chromium-default', linux({ setting: false }).features);
        expect(m).toEqual({ enableFeatures: ['WebRTCPipeWireCapturer'], disableFeatures: [] });
    });

    it('does not duplicate an entry that is already there', () => {
        const m = buildChromiumMediaSwitches('linux', 'auto', 'chromium-default', ['WebRTCPipeWireCapturer', 'AcceleratedVideoEncoder', 'AcceleratedVideoEncoder']);
        expect(m.enableFeatures).toEqual(['WebRTCPipeWireCapturer', 'AcceleratedVideoEncoder']);
    });

    it('no extras is byte-for-byte what it was before', () => {
        expect(buildChromiumMediaSwitches('linux', 'auto')).toEqual({ enableFeatures: ['WebRTCPipeWireCapturer'], disableFeatures: [] });
        expect(buildChromiumMediaSwitches('darwin', 'auto')).toEqual({ enableFeatures: [], disableFeatures: [] });
    });

    it('the Windows list is unchanged by the Linux decision', () => {
        const win = buildChromiumMediaSwitches('win32', 'auto', 'chromium-default', linux({ platform: 'win32', mode: 'on' }).features);
        expect(win).toEqual(buildChromiumMediaSwitches('win32', 'auto'));
    });
});

describe('main.ts wiring (source pins - main.ts cannot run under vitest)', () => {
    const MAIN = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');

    it('decides once at module level from env + Settings + ledger, and feeds it into the ONE media feature list', () => {
        expect(MAIN).toMatch(/const LINUX_HW_ENCODE = decideLinuxHwEncode\(\{[\s\S]*?platform: process\.platform,[\s\S]*?parseLinuxHwEncodeMode\(process\.env\[LINUX_HW_ENCODE_ENV\]\)[\s\S]*?setting: STARTUP_FLAGS\.linuxHwEncode[\s\S]*?ledger:[\s\S]*?readLinuxHwEncodeLedgerFile\(LINUX_HW_ENCODE_LEDGER_PATH\)/);
        expect(MAIN).toMatch(/const linuxHwEncode = LINUX_HW_ENCODE;/);
        expect(MAIN).toMatch(/buildChromiumMediaSwitches\(process\.platform, SCREEN_CAPTURER_PREF, AUTO_CAPTURER\.backend, linuxHwEncode\.features\)/);
        expect(MAIN).toMatch(/linux_hw_encode=\$\{linuxHwEncode\.reason\}/);
    });

    it('the smoke test never reads the ledger (a stale file on a CI runner cannot change what the gate measures)', () => {
        expect(MAIN).toMatch(/ledger: IS_SMOKE_TEST \|\| process\.platform !== 'linux' \? null : readLinuxHwEncodeLedgerFile/);
        expect(MAIN).toMatch(/if \(IS_SMOKE_TEST \|\| !linuxHwFailureGate\.accept\(LINUX_HW_ENCODE\.enable, kind\)\) return;/);
    });

    it('appends enable-features exactly once (a second append would silently replace the first list)', () => {
        const appends = MAIN.match(/appendSwitch\('enable-features'/g) ?? [];
        expect(appends).toHaveLength(1);
    });

    it('records a GPU crash (crashed / abnormal exit) whenever the feature is on - a driver that aborts inside libva takes the GPU process down wherever the call came from', () => {
        expect(MAIN).toMatch(/if \(LINUX_HW_ENCODE\.enable && isGpuCrashForHwEncode\(details\)\) recordLinuxHwEncodeFailureNow\('gpu_crash'\);/);
        expect(MAIN).not.toMatch(/linuxHwMediaLive/);
    });

    it('the renderer report is allowlisted by kind before anything is written', () => {
        expect(MAIN).toMatch(/ipcMain\.handle\('linux-hw-encode:report-failure', \(_event, kind: unknown\): boolean => \{\s*if \(process\.platform !== 'linux'\) return false;\s*if \(!isLinuxHwEncodeFailureKind\(kind\)\) return false;/);
    });

    it('turning the Settings toggle back on clears the ledger (the retry after a lockout)', () => {
        expect(MAIN).toMatch(/if \(change\.linuxHwEncode === true && process\.platform === 'linux'\) clearLinuxHwEncodeLedgerFile\(LINUX_HW_ENCODE_LEDGER_PATH\);/);
    });

    it('never touches the GPU blocklist; the NVIDIA VA-API gate lives only in linux-video-decode.ts', () => {
        expect(MAIN).not.toMatch(/ignore-gpu-blocklist/);
        expect(MAIN).not.toMatch(/VaapiOnNvidiaGPUs/);
        expect(MAIN).not.toMatch(/swiftshader|use-gl=swiftshader|disable-gpu-sandbox|disable-setuid-sandbox/i);
    });
});
