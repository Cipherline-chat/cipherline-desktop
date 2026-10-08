import { describe, it, expect } from 'vitest';
import { parseStartupFlagsState, restartPending, gamingVideoRestartPending, type StartupFlagsState } from './startupFlags';

const base = (over: Partial<StartupFlagsState> = {}): StartupFlagsState => ({
    platform: 'win32',
    saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: false },
    active: { screenCapturer: 'auto', captureLog: false, gamingVideo: false },
    envOverride: { screenCapturer: false, captureLog: false },
    captureLogPath: 'C:\\Users\\u\\AppData\\Roaming\\Cipherline\\capture-debug.log',
    captureLogMaxBytes: 5 * 1024 * 1024,
    ...over,
});

describe('parseStartupFlagsState', () => {
    it('round-trips a well-formed reply', () => {
        const s = base({ saved: { screenCapturer: 'dxgi', captureLog: true, gamingVideo: false } });
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
        expect(s.saved).toEqual({ screenCapturer: 'auto', captureLog: false, gamingVideo: false });
        expect(s.active).toEqual({ screenCapturer: 'auto', captureLog: false, gamingVideo: false });
        expect(s.envOverride).toEqual({ screenCapturer: false, captureLog: false });
        expect(s.captureLogPath).toBeNull();
        expect(s.captureLogMaxBytes).toBeNull();
    });
});

describe('restartPending', () => {
    it('is false when saved matches active', () => {
        expect(restartPending(base())).toBe(false);
    });

    it('is true when a saved value differs from the running one', () => {
        expect(restartPending(base({ saved: { screenCapturer: 'wgc', captureLog: false, gamingVideo: false } }))).toBe(true);
        expect(restartPending(base({ saved: { screenCapturer: 'auto', captureLog: true, gamingVideo: false } }))).toBe(true);
    });

    it('is false when an env var overrides the difference — a restart would change nothing', () => {
        expect(restartPending(base({
            saved: { screenCapturer: 'wgc', captureLog: true, gamingVideo: false },
            envOverride: { screenCapturer: true, captureLog: true },
        }))).toBe(false);
    });

    it('ignores the capture method off Windows', () => {
        expect(restartPending(base({ platform: 'linux', saved: { screenCapturer: 'dxgi', captureLog: false, gamingVideo: false } }))).toBe(false);
        expect(restartPending(base({ platform: 'linux', saved: { screenCapturer: 'dxgi', captureLog: true, gamingVideo: false } }))).toBe(true);
    });
});

describe('gamingVideo', () => {
    it('narrows to a strict boolean (an older main without the field reads as off)', () => {
        const s = parseStartupFlagsState({
            platform: 'win32',
            saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: 'true' },
            active: { screenCapturer: 'auto', captureLog: false },
            envOverride: {},
        })!;
        expect(s.saved.gamingVideo).toBe(false);
        expect(s.active.gamingVideo).toBe(false);
        expect(parseStartupFlagsState({ platform: 'win32', saved: { gamingVideo: true }, active: {} })!.saved.gamingVideo).toBe(true);
    });

    it('needs a restart in BOTH directions, on every platform', () => {
        const on = base({ saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: true } });
        expect(gamingVideoRestartPending(on)).toBe(true);
        expect(restartPending(on)).toBe(true);
        const off = base({ active: { screenCapturer: 'auto', captureLog: false, gamingVideo: true } });
        expect(gamingVideoRestartPending(off)).toBe(true);
        expect(restartPending({ ...off, platform: 'linux' })).toBe(true);
        expect(gamingVideoRestartPending(base())).toBe(false);
    });
});
