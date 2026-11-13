import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The one-time "screen sharing on Linux is new" card: who gets it, when the device flag is written, and that it is
 * said once. (The card itself and its focus gating: components/diagnostics/LinuxShareIntroCard.test.ts.)
 */
const h = vi.hoisted(() => ({ kv: new Map<string, string>(), writes: [] as Array<[string, string]> }));
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => h.kv.get(k) ?? null,
        setItem: (k: string, v: string) => { h.writes.push([k, v]); h.kv.set(k, v); },
    },
}));

import {
    LINUX_SHARE_INTRO_KEY, backendFromEncoder, shouldOfferLinuxShareIntro, noteScreenShareStarted, revealLinuxShareIntro,
    dismissLinuxShareIntro, hasSeenLinuxShareIntro, getLinuxShareIntroState, __resetLinuxShareIntroForTests,
} from './linuxShareIntro';
beforeEach(() => {
    h.kv.clear();
    h.writes.length = 0;
    __resetLinuxShareIntroForTests();
});

describe('shouldOfferLinuxShareIntro (decision table)', () => {
    it.each([
        ['linux', false, false, true],
        ['linux', true, false, false],     // already shown on this device
        ['linux', false, true, false],     // already pending / on screen this session
        ['win32', false, false, false],
        ['darwin', false, false, false],
        [undefined, false, false, false],  // website / no bridge
    ] as const)('platform=%s seen=%s offered=%s -> %s', (platform, seen, offered, want) => {
        expect(shouldOfferLinuxShareIntro(platform, seen, offered)).toBe(want);
    });
});

describe('backendFromEncoder', () => {
    it('maps the native helper encoder names; anything else is the normal share', () => {
        expect(backendFromEncoder('nvenc')).toBe('nvenc');
        expect(backendFromEncoder('vaapi')).toBe('vaapi');
        expect(backendFromEncoder(undefined)).toBe('normal');
        expect(backendFromEncoder(null)).toBe('normal');
        expect(backendFromEncoder('')).toBe('normal');
        expect(backendFromEncoder('NVENC')).toBe('normal');
    });
});

describe('the once-per-device flag', () => {
    it('a first Linux share makes the card pending but writes NOTHING until it is shown', () => {
        noteScreenShareStarted('vaapi', 'linux');
        expect(getLinuxShareIntroState()).toEqual({ backend: 'vaapi', shown: false });
        expect(h.writes).toEqual([]);
        expect(hasSeenLinuxShareIntro()).toBe(false);
        revealLinuxShareIntro();
        expect(getLinuxShareIntroState()).toEqual({ backend: 'vaapi', shown: true });
        expect(h.writes).toEqual([[LINUX_SHARE_INTRO_KEY, '1']]);
        expect(hasSeenLinuxShareIntro()).toBe(true);
    });

    it('reveal without a pending card writes nothing (the flag means "was on screen")', () => {
        revealLinuxShareIntro();
        expect(h.writes).toEqual([]);
    });

    it('is not offered on Windows or macOS', () => {
        noteScreenShareStarted('normal', 'win32');
        noteScreenShareStarted('normal', 'darwin');
        expect(getLinuxShareIntroState()).toBeNull();
        revealLinuxShareIntro();
        expect(h.writes).toEqual([]);
    });

    it('is not offered when the flag is already set', () => {
        h.kv.set(LINUX_SHARE_INTRO_KEY, '1');
        noteScreenShareStarted('nvenc', 'linux');
        expect(getLinuxShareIntroState()).toBeNull();
        revealLinuxShareIntro();
        expect(h.writes).toEqual([]);
    });

    it('says it once: after it was shown and dismissed, the next share does not bring it back', () => {
        noteScreenShareStarted('nvenc', 'linux');
        revealLinuxShareIntro();
        dismissLinuxShareIntro();
        h.writes.length = 0;
        noteScreenShareStarted('nvenc', 'linux');
        expect(getLinuxShareIntroState()).toBeNull();
        revealLinuxShareIntro();
        expect(h.writes).toEqual([]);
    });

    it('a second share while the first card is pending keeps the first (no double card, backend of the first share)', () => {
        noteScreenShareStarted('nvenc', 'linux');
        noteScreenShareStarted('normal', 'linux');
        expect(getLinuxShareIntroState()).toEqual({ backend: 'nvenc', shown: false });
    });

    it('reveal is idempotent: one write however often the card re-renders', () => {
        noteScreenShareStarted('normal', 'linux');
        revealLinuxShareIntro();
        revealLinuxShareIntro();
        expect(h.writes).toHaveLength(1);
    });

    it('a card that never reached the screen (app quit while unfocused) is offered again next launch', () => {
        noteScreenShareStarted('vaapi', 'linux');
        __resetLinuxShareIntroForTests();          // relaunch: module state gone, nothing was persisted
        expect(hasSeenLinuxShareIntro()).toBe(false);
        noteScreenShareStarted('vaapi', 'linux');
        revealLinuxShareIntro();
        expect(h.writes).toEqual([[LINUX_SHARE_INTRO_KEY, '1']]);
    });
});
