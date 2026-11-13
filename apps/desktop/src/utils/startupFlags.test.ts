import { describe, it, expect } from 'vitest';
import { parseStartupFlagsState, restartPending, gamingVideoRestartPending, linuxHwEncodeRestartPending, linuxHwEncodeStatusLine, linuxHwDecodeRestartPending, linuxHwDecodeStatusLine, type StartupFlagsState, type LinuxHwEncodeStatus } from './startupFlags';

const base = (over: Partial<StartupFlagsState> = {}): StartupFlagsState => ({
    platform: 'win32',
    saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true },
    active: { screenCapturer: 'auto', captureLog: false, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true },
    envOverride: { screenCapturer: false, captureLog: false, linuxHwEncode: false, linuxHwDecode: false },
    linuxHwEncode: null,
    linuxHwDecode: null,
    captureLogPath: 'C:\\Users\\u\\AppData\\Roaming\\Cipherline\\capture-debug.log',
    captureLogMaxBytes: 5 * 1024 * 1024,
    ...over,
});

describe('parseStartupFlagsState', () => {
    it('round-trips a well-formed reply', () => {
        const s = base({ saved: { screenCapturer: 'dxgi', captureLog: true, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true } });
        expect(parseStartupFlagsState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    });

    it('returns null for a missing or shapeless reply (older main process)', () => {
        expect(parseStartupFlagsState(undefined)).toBeNull();
        expect(parseStartupFlagsState(null)).toBeNull();
        expect(parseStartupFlagsState('x')).toBeNull();
        expect(parseStartupFlagsState({ saved: {} })).toBeNull();
    });

    it('narrows every field instead of trusting it', () => {
        const s = parseStartupFlagsState({
            platform: 7,
            saved: { screenCapturer: 'gdi', captureLog: 'yes' },
            active: { screenCapturer: 'WGC', captureLog: 1 },
            envOverride: { screenCapturer: 'true' },
            captureLogPath: '',
            captureLogMaxBytes: -1,
        })!;
        expect(s.platform).toBe('unknown');
        expect(s.saved).toEqual({ screenCapturer: 'auto', captureLog: false, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true });
        expect(s.active).toEqual({ screenCapturer: 'auto', captureLog: false, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true });
        expect(s.envOverride).toEqual({ screenCapturer: false, captureLog: false, linuxHwEncode: false, linuxHwDecode: false });
        expect(s.linuxHwEncode).toBeNull();
        expect(s.linuxHwDecode).toBeNull();
        expect(s.captureLogPath).toBeNull();
        expect(s.captureLogMaxBytes).toBeNull();
    });
});

describe('restartPending', () => {
    it('is false when saved matches active', () => {
        expect(restartPending(base())).toBe(false);
    });

    it('is true when a saved value differs from the running one', () => {
        expect(restartPending(base({ saved: { screenCapturer: 'wgc', captureLog: false, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true } }))).toBe(true);
        expect(restartPending(base({ saved: { screenCapturer: 'auto', captureLog: true, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true } }))).toBe(true);
    });

    it('is false when an env var overrides the difference — a restart would change nothing', () => {
        expect(restartPending(base({
            saved: { screenCapturer: 'wgc', captureLog: true, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true },
            envOverride: { screenCapturer: true, captureLog: true, linuxHwEncode: false, linuxHwDecode: false },
        }))).toBe(false);
    });

    it('ignores the capture method off Windows', () => {
        expect(restartPending(base({ platform: 'linux', saved: { screenCapturer: 'dxgi', captureLog: false, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true } }))).toBe(false);
        expect(restartPending(base({ platform: 'linux', saved: { screenCapturer: 'dxgi', captureLog: true, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true } }))).toBe(true);
    });
});

describe('gamingVideo', () => {
    it('reads as ON unless main says exactly false (default ON; a garbled value is the default)', () => {
        const s = parseStartupFlagsState({
            platform: 'win32',
            saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: 'false' },
            active: { screenCapturer: 'auto', captureLog: false },
            envOverride: {},
        })!;
        expect(s.saved.gamingVideo).toBe(true);
        expect(s.active.gamingVideo).toBe(true);
        expect(parseStartupFlagsState({ platform: 'win32', saved: { gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true }, active: { gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true } })!.saved.gamingVideo).toBe(false);
        expect(parseStartupFlagsState({ platform: 'win32', saved: { gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true }, active: {} })!.saved.gamingVideo).toBe(true);
    });

    it('has no separate screen-share flag any more', () => {
        const s = parseStartupFlagsState({ platform: 'win32', saved: { shareBoost: false }, active: {} })!;
        expect(Object.keys(s.saved).sort()).toEqual(['captureLog', 'gamingVideo', 'linuxHwDecode', 'linuxHwEncode', 'screenCapturer']);
    });

    it('needs a restart in BOTH directions, on every platform', () => {
        const on = base({ saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true } });
        expect(gamingVideoRestartPending(on)).toBe(true);
        expect(restartPending(on)).toBe(true);
        const off = base({ active: { screenCapturer: 'auto', captureLog: false, gamingVideo: true, linuxHwEncode: true, linuxHwDecode: true } });
        expect(gamingVideoRestartPending(off)).toBe(true);
        expect(restartPending({ ...off, platform: 'linux' })).toBe(true);
        expect(gamingVideoRestartPending(base())).toBe(false);
    });
});


describe('linuxHwEncode (Settings -> Advanced, Linux)', () => {
    const status = (over: Partial<LinuxHwEncodeStatus> = {}): LinuxHwEncodeStatus =>
        ({ active: true, reason: 'auto: on', lockedOut: false, lockoutCleared: false, failureThisLaunch: false, ...over });
    const lin = (over: Partial<StartupFlagsState> = {}) => base({ platform: 'linux', saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true }, active: { screenCapturer: 'auto', captureLog: false, gamingVideo: false, linuxHwEncode: true, linuxHwDecode: true }, linuxHwEncode: status(), ...over });

    it('narrows main\'s status field by field; an older main (none) is null', () => {
        const raw = { platform: 'linux', saved: {}, active: {}, linuxHwEncode: { active: true, reason: 'x'.repeat(500), lockedOut: 'yes', lockoutCleared: 1, failureThisLaunch: true } };
        const s = parseStartupFlagsState(raw)!;
        expect(s.linuxHwEncode).toEqual({ active: true, reason: 'x'.repeat(160), lockedOut: false, lockoutCleared: false, failureThisLaunch: true });
        expect(parseStartupFlagsState({ platform: 'linux', saved: {}, active: {} })!.linuxHwEncode).toBeNull();
        expect(parseStartupFlagsState({ platform: 'linux', saved: {}, active: {}, linuxHwEncode: { active: 'true' } })!.linuxHwEncode).toBeNull();
        expect(s.saved.linuxHwEncode).toBe(true);   // default ON: only an explicit false is off
        expect(parseStartupFlagsState({ platform: 'linux', saved: { linuxHwEncode: false }, active: {} })!.saved.linuxHwEncode).toBe(false);
        expect(parseStartupFlagsState({ platform: 'linux', saved: {}, active: {}, envOverride: { linuxHwEncode: true } })!.envOverride.linuxHwEncode).toBe(true);
    });

    it('restart is pending when the saved choice differs from the one this launch used - Linux only, and not under an env override', () => {
        expect(restartPending(lin())).toBe(false);
        const turnedOff = lin({ saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: false, linuxHwEncode: false, linuxHwDecode: true } });
        expect(linuxHwEncodeRestartPending(turnedOff)).toBe(true);
        expect(restartPending(turnedOff)).toBe(true);
        expect(restartPending({ ...turnedOff, platform: 'win32' })).toBe(false);
        expect(restartPending({ ...turnedOff, envOverride: { screenCapturer: false, captureLog: false, linuxHwEncode: true, linuxHwDecode: false } })).toBe(false);
        expect(restartPending({ ...turnedOff, linuxHwEncode: null })).toBe(false);
    });

    it('clearing a lockout (turning it back on) needs a restart to retry', () => {
        const locked = lin({ linuxHwEncode: status({ active: false, lockedOut: true, reason: 'stayed software: ...' }) });
        expect(linuxHwEncodeRestartPending(locked)).toBe(false);
        const cleared = lin({ linuxHwEncode: status({ active: false, lockedOut: true, lockoutCleared: true }) });
        expect(linuxHwEncodeRestartPending(cleared)).toBe(true);
    });

    it('the status line says what this launch is doing and why', () => {
        expect(linuxHwEncodeStatusLine(lin())).toBe('On in this session.');
        expect(linuxHwEncodeStatusLine(lin({ linuxHwEncode: status({ active: false }) }))).toBe('Off in this session.');
        expect(linuxHwEncodeStatusLine(lin({ linuxHwEncode: status({ failureThisLaunch: true }) }))).toMatch(/hardware encoder failed/);
        expect(linuxHwEncodeStatusLine(lin({ linuxHwEncode: status({ active: false, lockedOut: true }) }))).toMatch(/Turn it on to try again/);
        expect(linuxHwEncodeStatusLine(lin({ linuxHwEncode: status({ active: false, lockedOut: true, lockoutCleared: true }) }))).toMatch(/tried again after a restart/);
        expect(linuxHwEncodeStatusLine(base())).toBe('');
    });
});

describe('linuxHwDecode (Settings -> Advanced, Linux)', () => {
    const lin = (over: Partial<StartupFlagsState> = {}) => base({ platform: 'linux', ...over });
    const dec = (over: Partial<NonNullable<StartupFlagsState['linuxHwDecode']>> = {}) => ({
        active: true, reason: 'auto: on', nvidia: 'ready', gpus: 'nvidia:nvidia', lockedOut: false, lockoutCleared: false, failureThisLaunch: false, hint: null, ...over,
    });
    it('narrows main\'s reply and drops a malformed hint', () => {
        const raw = { platform: 'linux', saved: {}, active: {}, linuxHwDecode: { active: true, nvidia: 'missing_driver', hint: { kind: 'install_driver', pkg: 'libva-nvidia-driver', install: 'sudo pacman -S libva-nvidia-driver', text: 'Install it' } } };
        const s = parseStartupFlagsState(raw)!;
        expect(s.linuxHwDecode?.hint).toEqual({ kind: 'install_driver', pkg: 'libva-nvidia-driver', install: 'sudo pacman -S libva-nvidia-driver', text: 'Install it' });
        expect(parseStartupFlagsState({ ...raw, linuxHwDecode: { active: true, hint: { kind: 'bogus', text: 'x' } } })!.linuxHwDecode?.hint).toBeNull();
        expect(parseStartupFlagsState({ platform: 'linux', saved: {}, active: {} })!.linuxHwDecode).toBeNull();
        expect(s.saved.linuxHwDecode).toBe(true);
    });
    it('restart pending follows saved vs active, and not under an env override', () => {
        const off = lin({ saved: { ...base().saved, linuxHwDecode: false }, linuxHwDecode: dec() });
        expect(linuxHwDecodeRestartPending(off)).toBe(true);
        expect(linuxHwDecodeRestartPending({ ...off, envOverride: { ...off.envOverride, linuxHwDecode: true } })).toBe(false);
        expect(linuxHwDecodeRestartPending({ ...off, platform: 'win32' })).toBe(false);
    });
    it('status line carries the NVIDIA hint when the driver is missing', () => {
        const withHint = lin({ linuxHwDecode: dec({ nvidia: 'missing_driver', hint: { kind: 'install_driver', pkg: 'libva-nvidia-driver', install: 'x', text: 'Install the "libva-nvidia-driver" package' } }) });
        expect(linuxHwDecodeStatusLine(withHint)).toMatch(/libva-nvidia-driver/);
        expect(linuxHwDecodeStatusLine(lin({ linuxHwDecode: dec({ active: false, lockedOut: true }) }))).toMatch(/Turn it on to try again/);
        expect(linuxHwDecodeStatusLine(base())).toBe('');
    });
});
