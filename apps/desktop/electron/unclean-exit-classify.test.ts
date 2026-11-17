import { describe, it, expect } from 'vitest';
import {
    BOOT_JITTER_MS, CLOCK_SKEW_MS, EXE_GRACE_MS, bootTimeFrom, classifyEnvNow, classifyUncleanExit, deadSessionFrom,
    exeStampPaths, newestFileChange, sane, type ClassifyEnv, type DeadSession,
} from './unclean-exit-classify';
import type { PreviousSession } from './previous-session';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const MIN = 60_000;
const START = NOW - 40 * MIN;
const SEEN = NOW - 30 * MIN;

const hiddenIdle = { window_visible: false, window_focused: false, in_call: false, sharing: false, camera_live: false };
const dead = (o: Partial<DeadSession> = {}): DeadSession => ({
    startedAt: START, lastSeenAt: SEEN, appVersion: '0.1.0', hung: false, state: { ...hiddenIdle }, rows: [], ...o,
});
const env = (o: Partial<ClassifyEnv> = {}): ClassifyEnv => ({
    now: NOW, exeChangedAt: START - 5 * 24 * 3600_000, bootTime: START - 3 * 24 * 3600_000, currentVersion: '0.1.0', ...o,
});
const cls = (d: DeadSession, e: ClassifyEnv = env()) => classifyUncleanExit(d, e);

describe('classifyUncleanExit — classes', () => {
    it('hung-exit freeze evidence is always a real candidate, even if the exe is newer and the OS rebooted', () => {
        expect(cls(dead({ hung: true }), env({ exeChangedAt: NOW - MIN, bootTime: NOW - MIN }))).toEqual({ cls: 'real_candidate', reason: 'hung_exit' });
    });

    it('installer_replaced: exe changed after the session was last seen', () => {
        expect(cls(dead(), env({ exeChangedAt: SEEN + 5 * MIN }))).toEqual({ cls: 'installer_replaced', reason: 'exe_newer_than_session' });
    });
    it('installer_replaced: the exe changed after the START when there is no previous-session file', () => {
        expect(cls(dead({ lastSeenAt: null, state: undefined, rows: undefined }), env({ exeChangedAt: START + 2 * MIN })).cls).toBe('installer_replaced');
    });
    it('installer_replaced: the dead session ran another version', () => {
        expect(cls(dead({ appVersion: '0.0.9' }))).toEqual({ cls: 'installer_replaced', reason: 'version_changed' });
    });
    it('installer_replaced: the dead session ran another build commit', () => {
        expect(cls(dead({ buildCommit: 'aaaaaaa' }), env({ currentBuildCommit: 'bbbbbbb' }))).toEqual({ cls: 'installer_replaced', reason: 'build_changed' });
    });
    it('exe changed BEFORE the session was last seen (e.g. AV touched it mid-session) is not an install', () => {
        expect(cls(dead(), env({ exeChangedAt: SEEN - 5 * MIN })).cls).not.toBe('installer_replaced');
    });

    it('os_restart: the OS booted after the session was last seen', () => {
        expect(cls(dead(), env({ bootTime: SEEN + 10 * MIN }))).toEqual({ cls: 'os_restart', reason: 'boot_after_last_seen' });
    });
    it('os_restart falls back to the session start when there is no previous-session file', () => {
        expect(cls(dead({ lastSeenAt: null, state: undefined }), env({ bootTime: START + 10 * MIN })).cls).toBe('os_restart');
    });
    it('a power loss during a call is still an os_restart (not ours)', () => {
        expect(cls(dead({ state: { ...hiddenIdle, in_call: true } }), env({ bootTime: SEEN + MIN })).cls).toBe('os_restart');
    });

    it('external_kill_suspected: hidden, idle, healthy rows, previous-session file present', () => {
        const rows = [{ t_s: -5, source: 'main' as const, ms: 120, activity: 'idle' }, { t_s: -2, source: 'metrics' as const, ms: 0, activity: 'cpu=1%' }];
        expect(cls(dead({ rows }))).toEqual({ cls: 'external_kill_suspected', reason: 'hidden_idle_healthy' });
    });

    it.each([
        ['in_call', 'call_active'], ['sharing', 'share_active'], ['camera_live', 'camera_active'],
    ] as const)('real candidate: %s at death', (flag, reason) => {
        expect(cls(dead({ state: { ...hiddenIdle, [flag]: true } }))).toEqual({ cls: 'real_candidate', reason });
    });
    it('real candidate: a main stall in the last minute', () => {
        expect(cls(dead({ rows: [{ t_s: -20, source: 'main', ms: 4000, activity: 'sync' }] }))).toEqual({ cls: 'real_candidate', reason: 'stall_before_death' });
    });
    it('real candidate: a renderer stall', () => {
        expect(cls(dead({ rows: [{ t_s: -1, source: 'renderer', ms: 3000, activity: 'x' }] })).reason).toBe('stall_before_death');
    });
    it('an OLD stall (> 60 s before the last write) is not evidence about how it ended', () => {
        expect(cls(dead({ rows: [{ t_s: -300, source: 'main', ms: 9000, activity: 'sync' }] })).cls).toBe('external_kill_suspected');
    });
    it('a short stall (< 3 s) is not a stall', () => {
        expect(cls(dead({ rows: [{ t_s: -2, source: 'main', ms: 2999, activity: 'sync' }] })).cls).toBe('external_kill_suspected');
    });
    it.each([
        'process:gone type=GPU reason=crashed', 'gpu:features gpu_compositing=disabled', 'linux_hw_encode:failure kind=gpu_crash',
        'process:gone type=Utility reason=oom',
    ])('real candidate: renderer / GPU trouble event "%s"', (activity) => {
        expect(cls(dead({ rows: [{ t_s: -10, source: 'event', ms: 0, activity }] }))).toEqual({ cls: 'real_candidate', reason: 'renderer_or_gpu_trouble' });
    });
    it('plain startup events are not trouble', () => {
        const rows = [{ t_s: -10, source: 'event' as const, ms: 900, activity: 'startup:did-finish-load ms since process start' }];
        expect(cls(dead({ rows })).cls).toBe('external_kill_suspected');
    });

    it('real candidate: window was visible (a visible app dying is not "idle in the tray")', () => {
        expect(cls(dead({ state: { ...hiddenIdle, window_visible: true } }))).toEqual({ cls: 'real_candidate', reason: 'window_visible' });
    });
    it('real candidate: window state unknown', () => {
        expect(cls(dead({ state: { in_call: false } })).reason).toBe('window_state_unknown');
    });
    it('real candidate: no previous-session evidence at all (old file missing / mismatched)', () => {
        expect(cls(dead({ lastSeenAt: null, state: undefined, rows: undefined }))).toEqual({ cls: 'real_candidate', reason: 'no_previous_session_evidence' });
    });
});

describe('classifyUncleanExit — rule zero: a bad clock never hides a crash', () => {
    it('exe change time in the future (beyond skew) is ignored', () => {
        expect(cls(dead({ state: { ...hiddenIdle, window_visible: true } }), env({ exeChangedAt: NOW + CLOCK_SKEW_MS + 1000 }))).toEqual({ cls: 'real_candidate', reason: 'window_visible' });
    });
    it('boot time in the future is ignored', () => {
        expect(cls(dead({ state: { ...hiddenIdle, window_visible: true } }), env({ bootTime: NOW + 3_600_000 })).cls).toBe('real_candidate');
    });
    it('boot time before 2000 / zero / NaN / null is ignored', () => {
        for (const bootTime of [0, -1, Date.UTC(1970, 0, 2), NaN, Infinity, null]) {
            expect(cls(dead({ state: { ...hiddenIdle, window_visible: true } }), env({ bootTime })).cls).toBe('real_candidate');
        }
    });
    it('exe time nonsense (0, negative, NaN, null) is ignored', () => {
        for (const exeChangedAt of [0, -5, NaN, null]) {
            expect(cls(dead({ state: { ...hiddenIdle, window_visible: true } }), env({ exeChangedAt })).cls).toBe('real_candidate');
        }
    });
    it('a dead session with a future / nonsense start is a real candidate, whatever else says', () => {
        for (const startedAt of [NOW + 3_600_000, null, NaN, 0]) {
            expect(cls(dead({ startedAt, lastSeenAt: null }), env({ bootTime: NOW - MIN, exeChangedAt: NOW - MIN }))).toEqual({ cls: 'real_candidate', reason: 'bad_dead_session_time' });
        }
    });
    it('a last-seen before the start / in the future is dropped and the start is the reference', () => {
        // boot is after the start, so the OS-restart rule fires off the START even though last-seen is garbage
        expect(cls(dead({ lastSeenAt: START - 10 * MIN }), env({ bootTime: START + 10 * MIN })).cls).toBe('os_restart');
        expect(cls(dead({ lastSeenAt: NOW + 3_600_000 }), env({ bootTime: START + 10 * MIN })).cls).toBe('os_restart');
        // ...and with no external evidence it is just a real candidate (no trusted previous-session proof)
        expect(cls(dead({ lastSeenAt: NOW + 3_600_000 })).cls).toBe('real_candidate');
    });
    it('small skew into the future is tolerated (not nonsense)', () => {
        expect(sane(NOW + CLOCK_SKEW_MS - 1, NOW)).toBe(true);
        expect(sane(NOW + CLOCK_SKEW_MS + 1, NOW)).toBe(false);
    });
});

describe('classifyUncleanExit — boundaries', () => {
    it('exe change within the grace after last-seen is not "newer"', () => {
        expect(cls(dead(), env({ exeChangedAt: SEEN + EXE_GRACE_MS })).cls).toBe('external_kill_suspected');
        expect(cls(dead(), env({ exeChangedAt: SEEN + EXE_GRACE_MS + 1 })).cls).toBe('installer_replaced');
    });
    it('boot within the jitter after last-seen is not a restart', () => {
        expect(cls(dead(), env({ bootTime: SEEN + BOOT_JITTER_MS })).cls).toBe('external_kill_suspected');
        expect(cls(dead(), env({ bootTime: SEEN + BOOT_JITTER_MS + 1 })).cls).toBe('os_restart');
    });
    it('installer outranks os_restart (the app was replaced, then the PC rebooted)', () => {
        expect(cls(dead(), env({ exeChangedAt: SEEN + 5 * MIN, bootTime: SEEN + 10 * MIN })).cls).toBe('installer_replaced');
    });
    it('missing exe / boot info (unreadable) falls through to the evidence rules', () => {
        expect(cls(dead(), env({ exeChangedAt: null, bootTime: null })).cls).toBe('external_kill_suspected');
        expect(cls(dead({ state: { ...hiddenIdle, in_call: true } }), env({ exeChangedAt: null, bootTime: null })).cls).toBe('real_candidate');
    });
    it('unknown dead version never counts as a version change', () => {
        expect(cls(dead({ appVersion: null })).cls).toBe('external_kill_suspected');
    });
});

describe('exeStampPaths / newestFileChange / bootTimeFrom', () => {
    it('Windows: execPath', () => {
        expect(exeStampPaths({ platform: 'win32', execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Cipherline\\Cipherline.exe', env: {} })).toEqual(['C:\\Users\\a\\AppData\\Local\\Programs\\Cipherline\\Cipherline.exe']);
    });
    it('macOS: the bundle executable and Info.plist', () => {
        expect(exeStampPaths({ platform: 'darwin', execPath: '/Applications/Cipherline.app/Contents/MacOS/Cipherline', env: {} }))
            .toEqual(['/Applications/Cipherline.app/Contents/MacOS/Cipherline', '/Applications/Cipherline.app/Contents/Info.plist']);
    });
    it('macOS: an unexpected execPath shape still yields the executable', () => {
        expect(exeStampPaths({ platform: 'darwin', execPath: '/opt/x/electron', env: {} })).toEqual(['/opt/x/electron']);
    });
    it('Linux AppImage: the AppImage file, not the transient mount', () => {
        expect(exeStampPaths({ platform: 'linux', execPath: '/tmp/.mount_Ciphexyz/cipherline', env: { APPIMAGE: '/home/u/Cipherline.AppImage' } })).toEqual(['/home/u/Cipherline.AppImage']);
    });
    it('Linux deb / unpacked: execPath', () => {
        expect(exeStampPaths({ platform: 'linux', execPath: '/opt/Cipherline/cipherline', env: {} })).toEqual(['/opt/Cipherline/cipherline']);
    });
    it('newestFileChange takes the newest of mtime / ctime / birthtime over all files, tolerating failures', () => {
        const stats: Record<string, { mtimeMs: number; ctimeMs: number; birthtimeMs: number }> = {
            a: { mtimeMs: 100, ctimeMs: 900, birthtimeMs: 50 },
            b: { mtimeMs: 400, ctimeMs: 300, birthtimeMs: 0 },
        };
        const stat = (p: string) => { if (p === 'boom') throw new Error('EACCES'); return stats[p] ?? null; };
        expect(newestFileChange(stat, ['a', 'b', 'boom', 'missing'])).toBe(900);
        expect(newestFileChange(stat, ['missing', 'boom'])).toBeNull();
        expect(newestFileChange(stat, [])).toBeNull();
    });
    it('NSIS keeps the source mtime: only ctime shows the replacement', () => {
        const stat = () => ({ mtimeMs: START - 10 * 24 * 3600_000, ctimeMs: SEEN + 5 * MIN, birthtimeMs: START - 10 * 24 * 3600_000 });
        const e = classifyEnvNow({ now: NOW, platform: 'win32', execPath: 'C:\\x.exe', env: {}, stat, uptimeSeconds: 30 * 24 * 3600, currentVersion: '0.1.0' });
        expect(cls(dead(), e).cls).toBe('installer_replaced');
    });
    it('bootTimeFrom rejects nonsense uptime', () => {
        expect(bootTimeFrom(NOW, 10)).toBe(NOW - 10_000);
        expect(bootTimeFrom(NOW, -1)).toBeNull();
        expect(bootTimeFrom(NOW, NaN)).toBeNull();
    });
});

describe('deadSessionFrom', () => {
    const prev: PreviousSession = {
        started_at: new Date(START).toISOString(), last_written_at: new Date(SEEN).toISOString(), app_version: '0.1.0',
        state: { window_visible: false }, rows: [{ t_s: -1, source: 'main', ms: 10, activity: 'idle' }],
    };
    it('takes last-seen, state and rows from the previous-session record', () => {
        const d = deadSessionFrom({ app_version_at_crash: '0.1.0' }, prev, START, false);
        expect(d).toMatchObject({ startedAt: START, lastSeenAt: SEEN, appVersion: '0.1.0', hung: false, state: { window_visible: false } });
        expect(d.rows).toHaveLength(1);
    });
    it('without a previous-session record there is no last-seen / state', () => {
        const d = deadSessionFrom({}, null, START, true);
        expect(d).toEqual({ startedAt: START, lastSeenAt: null, appVersion: null, hung: true });
    });
    it('an unparsable last_written_at becomes null', () => {
        expect(deadSessionFrom({}, { ...prev, last_written_at: 'nope' }, START, false).lastSeenAt).toBeNull();
    });
});
