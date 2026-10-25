import { describe, it, expect } from 'vitest';
import {
    FOREGROUND_TTL_MS, createQuickShareForegroundStore, hasForegroundCandidate, readNativeForegroundWindow, resolveForegroundSource,
} from './quick-share-foreground';

const WINDOWS = [
    { id: 'window:1111:0', name: 'Cipherline' },
    { id: 'window:2222:0', name: 'Some Editor' },
    { id: 'window:3333:0', name: 'Browser' },
];
const SCREEN = { id: 'screen:0:0', name: 'Screen 1' };

describe('readNativeForegroundWindow (the addon answer, validated)', () => {
    it('reads the decimal root handle and the Cipherline flag', () => {
        expect(readNativeForegroundWindow({ fgWindow: '2222', fgIsCipherline: false })).toEqual({ hwnd: '2222', isCipherline: false });
        expect(readNativeForegroundWindow({ fgWindow: '1111', fgIsCipherline: true })).toEqual({ hwnd: '1111', isCipherline: true });
    });
    it('an addon built before fgWindow existed -> unknown window (caller falls back)', () => {
        expect(readNativeForegroundWindow({ notificationState: 'QUNS_BUSY', fgExe: 'a.exe', fgIsCipherline: false })).toEqual({ hwnd: null, isCipherline: false });
    });
    it('empty (desktop / shell / none), zero, non-numeric and oversized handles are unknown', () => {
        for (const fgWindow of ['', '0', '000', 'abc', '12 3', '-5', '1e5', '99999999999999999999', '123456789012345678901', 5, null, undefined, {}]) {
            expect(readNativeForegroundWindow({ fgWindow })).toEqual({ hwnd: null, isCipherline: false });
        }
    });
    it('anything that is not an object is unusable', () => {
        for (const raw of [null, undefined, 'x', 7, true]) expect(readNativeForegroundWindow(raw)).toBeNull();
    });
    it('fgIsCipherline is only ever true for a real true', () => {
        expect(readNativeForegroundWindow({ fgWindow: '5', fgIsCipherline: 'true' })?.isCipherline).toBe(false);
    });
});

describe('resolveForegroundSource (validated against main\'s own source list)', () => {
    const fg = (hwnd: string | null, isCipherline = false) => ({ hwnd, isCipherline });

    it('another app\'s window that is in the list -> that source id', () => {
        expect(resolveForegroundSource(fg('2222'), [...WINDOWS, SCREEN])).toBe('window:2222:0');
    });
    it('matches by handle, not by id spelling (leading zeros, any suffix)', () => {
        expect(resolveForegroundSource(fg('2222'), [{ id: 'window:002222:1' }])).toBe('window:002222:1');
    });
    it('Cipherline itself -> fallback, even though its window is in the list', () => {
        expect(resolveForegroundSource(fg('1111', true), WINDOWS)).toBeNull();
        expect(resolveForegroundSource(fg('1111', false), WINDOWS)).toBe('window:1111:0'); // control: only the flag excludes it
    });
    it('unknown foreground (no handle, or nothing captured) -> fallback', () => {
        expect(resolveForegroundSource(fg(null), WINDOWS)).toBeNull();
        expect(resolveForegroundSource(null, WINDOWS)).toBeNull();
    });
    it('a foreground window that is not in the list -> fallback', () => {
        expect(resolveForegroundSource(fg('9999'), WINDOWS)).toBeNull();
        expect(resolveForegroundSource(fg('2222'), [])).toBeNull();
    });
    it('only window sources can match (a screen id with the same number does not)', () => {
        expect(resolveForegroundSource(fg('2222'), [{ id: 'screen:2222:0' }])).toBeNull();
    });
    it('hasForegroundCandidate gates the (slow) window enumeration', () => {
        expect(hasForegroundCandidate(fg('2222'))).toBe(true);
        expect(hasForegroundCandidate(fg('2222', true))).toBe(false);
        expect(hasForegroundCandidate(fg(null))).toBe(false);
        expect(hasForegroundCandidate(null)).toBe(false);
    });
});

describe('the store (captured at the key press, single use, short lived)', () => {
    function mk() {
        let t = 5_000;
        const s = createQuickShareForegroundStore({ now: () => t });
        return { s, advance: (ms: number) => { t += ms; } };
    }
    it('hands the capture out once', () => {
        const { s } = mk();
        s.capture({ fgWindow: '2222', fgIsCipherline: false });
        expect(s.take()).toEqual({ hwnd: '2222', isCipherline: false });
        expect(s.take()).toBeNull();
    });
    it('expires after the TTL (at the TTL still valid, one ms later not)', () => {
        const a = mk();
        a.s.capture({ fgWindow: '2222' });
        a.advance(FOREGROUND_TTL_MS);
        expect(a.s.take()).not.toBeNull();
        const b = mk();
        b.s.capture({ fgWindow: '2222' });
        b.advance(FOREGROUND_TTL_MS + 1);
        expect(b.s.take()).toBeNull();
    });
    it('nothing captured -> null', () => {
        expect(mk().s.take()).toBeNull();
    });
    it('a newer press replaces the older one, including an UNREADABLE newer press (no stale window reused)', () => {
        const { s } = mk();
        s.capture({ fgWindow: '2222' });
        s.capture({ fgWindow: '3333' });
        expect(s.take()?.hwnd).toBe('3333');
        s.capture({ fgWindow: '2222' });
        s.capture(null);            // addon missing / threw
        expect(s.take()).toBeNull();
    });
});
