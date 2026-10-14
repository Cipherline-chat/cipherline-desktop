import { describe, it, expect } from 'vitest';
import {
    cleanExeName, cleanNativeForeground, describeForeground, sameMonitorRect, validateForegroundRequest,
    validateFindWindowRequest, pickWindowByExe, NOTIFICATION_STATES, MAX_WINDOW_SOURCE_IDS,
    type WindowCandidate,
} from './share-foreground';

const MONITOR = { x: 0, y: 0, width: 2560, height: 1440 };
const SECOND = { x: 2560, y: 0, width: 1920, height: 1080 };

/** What the addon's getForegroundInfo returns for a fullscreen game on MONITOR. */
const nativeGame = (over: Record<string, unknown> = {}) => ({
    notificationState: 'QUNS_RUNNING_D3D_FULL_SCREEN',
    fgExe: 'game.exe',
    fgCoversMonitor: true,
    fgIsCipherline: false,
    fgMonitor: MONITOR,
    ...over,
});

describe('cleanExeName', () => {
    it.each([
        ['game.exe', 'game.exe'],
        ['Cipherline.exe', 'Cipherline.exe'],
        ['My Game (x64).exe', 'My Game (x64).exe'],
        ['C:\\Games\\Steam\\game.exe', 'game.exe'],           // a path is cut down to its basename
        ['/usr/bin/thing', 'thing'],
    ])('%s -> %s', (raw, out) => expect(cleanExeName(raw)).toBe(out));

    it.each([[''], ['   '], [null], [undefined], [5], [{}], ['a'.repeat(49)], ['bad\u0000name.exe'], ['na<me>.exe'], ['game\n.exe'], ['C:\\dir\\']])(
        'rejects %j', (raw) => expect(cleanExeName(raw)).toBe(''));
});

describe('cleanNativeForeground', () => {
    it('passes a well-formed answer through, with the monitor rectangle', () => {
        expect(cleanNativeForeground(nativeGame())).toEqual({
            notificationState: 'QUNS_RUNNING_D3D_FULL_SCREEN', fgExe: 'game.exe', fgCoversMonitor: true, fgIsCipherline: false, monitor: MONITOR,
        });
    });

    it('an unknown notification state becomes QUNS_UNKNOWN (never an arbitrary string)', () => {
        expect(cleanNativeForeground(nativeGame({ notificationState: 'rm -rf' }))?.notificationState).toBe('QUNS_UNKNOWN');
        expect(cleanNativeForeground(nativeGame({ notificationState: 5 }))?.notificationState).toBe('QUNS_UNKNOWN');
        for (const s of NOTIFICATION_STATES) expect(cleanNativeForeground(nativeGame({ notificationState: s }))?.notificationState).toBe(s);
    });

    it('booleans must be real booleans; a bad monitor is null', () => {
        const r = cleanNativeForeground(nativeGame({ fgCoversMonitor: 'yes', fgIsCipherline: 1, fgMonitor: { x: 0 } }))!;
        expect(r.fgCoversMonitor).toBe(false);
        expect(r.fgIsCipherline).toBe(false);
        expect(r.monitor).toBeNull();
    });

    it.each([[null], [undefined], ['x'], [3]])('%j is unusable', (raw) => expect(cleanNativeForeground(raw)).toBeNull());

    it('never carries a window title or handle even if the addon sent one', () => {
        const r = cleanNativeForeground(nativeGame({ title: 'Secret Doc - Word', fgHwnd: '12345' }));
        expect(JSON.stringify(r)).not.toMatch(/Secret|12345|title|Hwnd/);
    });
});

describe('describeForeground: is the foreground window on the SHARED monitor?', () => {
    const base = { raw: nativeGame(), sourceId: 'screen:0:0', displayCount: 2 };

    it('equal rectangles -> on the shared screen', () => {
        expect(describeForeground({ ...base, sharedScreenRect: MONITOR })?.onSharedScreen).toBe(true);
    });

    it('a game on the OTHER monitor -> false', () => {
        expect(describeForeground({ ...base, sharedScreenRect: SECOND })?.onSharedScreen).toBe(false);
    });

    it('within 2 px tolerance still matches; beyond does not', () => {
        expect(sameMonitorRect(MONITOR, { ...MONITOR, width: 2562 })).toBe(true);
        expect(sameMonitorRect(MONITOR, { ...MONITOR, width: 2564 })).toBe(false);
    });

    it('no rectangle: a single display is unambiguous, several are "cannot tell" (null, never a guess)', () => {
        expect(describeForeground({ ...base, sharedScreenRect: null, displayCount: 1 })?.onSharedScreen).toBe(true);
        expect(describeForeground({ ...base, sharedScreenRect: null, displayCount: 3 })?.onSharedScreen).toBeNull();
    });

    it('a window share or no source id -> null', () => {
        expect(describeForeground({ ...base, sourceId: 'window:123:0', sharedScreenRect: MONITOR })?.onSharedScreen).toBeNull();
        expect(describeForeground({ ...base, sourceId: null, sharedScreenRect: MONITOR })?.onSharedScreen).toBeNull();
    });

    it('the renderer-facing object has exactly the documented fields (no rectangles)', () => {
        const d = describeForeground({ ...base, sharedScreenRect: MONITOR })!;
        expect(Object.keys(d).sort()).toEqual(['fgCoversMonitor', 'fgExe', 'fgIsCipherline', 'notificationState', 'onSharedScreen']);
        expect(d).toEqual({
            notificationState: 'QUNS_RUNNING_D3D_FULL_SCREEN', fgExe: 'game.exe', fgCoversMonitor: true, fgIsCipherline: false, onSharedScreen: true,
        });
    });

    it('unusable native answer -> null', () => {
        expect(describeForeground({ ...base, raw: null, sharedScreenRect: MONITOR })).toBeNull();
    });
});

describe('validateForegroundRequest (the IPC trust boundary)', () => {
    it('accepts no argument, or a screen:/window: capture source id', () => {
        expect(validateForegroundRequest(undefined)).toBeNull();
        expect(validateForegroundRequest(null)).toBeNull();
        expect(validateForegroundRequest('screen:1:0')).toBe('screen:1:0');
        expect(validateForegroundRequest('window:131346:0')).toBe('window:131346:0');
    });
    it.each([[5], [{}], ['screen:x:0'], ['file:///etc/passwd'], ['window:0:0'], ['a'.repeat(100)], [['screen:0:0']]])(
        'rejects %j (never coerced)', (v) => expect(() => validateForegroundRequest(v)).toThrow());
});

describe('validateFindWindowRequest', () => {
    it('accepts a program name and a list of window source ids', () => {
        expect(validateFindWindowRequest('game.exe', ['window:1:0', 'window:22:0'])).toEqual({ exe: 'game.exe', ids: ['window:1:0', 'window:22:0'] });
    });
    it.each([[''], [null], [5], ['a/../b<'], ['x'.repeat(60)]])('rejects the program name %j', (exe) => {
        expect(() => validateFindWindowRequest(exe, [])).toThrow();
    });
    it('rejects non-arrays, oversize lists, and any id that is not a window source id', () => {
        expect(() => validateFindWindowRequest('g.exe', 'window:1:0')).toThrow();
        expect(() => validateFindWindowRequest('g.exe', Array(MAX_WINDOW_SOURCE_IDS + 1).fill('window:1:0'))).toThrow();
        expect(() => validateFindWindowRequest('g.exe', ['screen:0:0'])).toThrow();
        expect(() => validateFindWindowRequest('g.exe', [5])).toThrow();
        expect(validateFindWindowRequest('g.exe', Array(MAX_WINDOW_SOURCE_IDS).fill('window:1:0')).ids).toHaveLength(MAX_WINDOW_SOURCE_IDS);
    });
});

describe('pickWindowByExe', () => {
    const c = (id: string, exe: string, area = 1000, usable = true): WindowCandidate => ({ id, exe, area, usable });

    it('matches the program name case-insensitively', () => {
        expect(pickWindowByExe([c('window:1:0', 'Game.EXE')], 'game.exe')).toBe('window:1:0');
    });

    it('the largest usable window of that program wins (a launcher is smaller)', () => {
        expect(pickWindowByExe([c('window:1:0', 'game.exe', 400 * 300), c('window:2:0', 'game.exe', 2560 * 1440), c('window:3:0', 'other.exe', 9e9)], 'game.exe'))
            .toBe('window:2:0');
    });

    it('a minimised / hidden window is not picked', () => {
        expect(pickWindowByExe([c('window:1:0', 'game.exe', 9e6, false)], 'game.exe')).toBeNull();
        expect(pickWindowByExe([c('window:1:0', 'game.exe', 9e6, false), c('window:2:0', 'game.exe', 10)], 'game.exe')).toBe('window:2:0');
    });

    it('no match / empty name -> null', () => {
        expect(pickWindowByExe([c('window:1:0', 'other.exe')], 'game.exe')).toBeNull();
        expect(pickWindowByExe([c('window:1:0', '')], 'game.exe')).toBeNull();
        expect(pickWindowByExe([c('window:1:0', 'game.exe')], '')).toBeNull();
        expect(pickWindowByExe([], 'game.exe')).toBeNull();
    });
});
