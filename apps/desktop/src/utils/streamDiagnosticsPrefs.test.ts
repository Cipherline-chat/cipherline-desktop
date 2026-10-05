import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    },
}));

import {
    parseCodecPref,
    getScreenShareCodecPref, setScreenShareCodecPref,
    getStreamStatsHudEnabled, setStreamStatsHudEnabled,
} from './streamDiagnosticsPrefs';

describe('streamDiagnosticsPrefs', () => {
    beforeEach(() => store.clear());

    it.each([
        ['auto', 'auto'], ['h264', 'h264'], ['vp9', 'vp9'], ['vp8', 'vp8'],
        // Anything else — including AV1, which E2EE cannot carry — reads as auto.
        ['av1', 'auto'], ['', 'auto'], [null, 'auto'], [undefined, 'auto'], ['H264', 'auto'],
    ] as const)('parseCodecPref(%s) → %s', (raw, expected) => {
        expect(parseCodecPref(raw)).toBe(expected);
    });

    it('defaults: overlay off, codec auto', () => {
        expect(getStreamStatsHudEnabled()).toBe(false);
        expect(getScreenShareCodecPref()).toBe('auto');
    });

    it('round-trips both preferences through the store', () => {
        setStreamStatsHudEnabled(true);
        setScreenShareCodecPref('vp9');
        expect(getStreamStatsHudEnabled()).toBe(true);
        expect(getScreenShareCodecPref()).toBe('vp9');
        setStreamStatsHudEnabled(false);
        expect(getStreamStatsHudEnabled()).toBe(false);
    });

    it('ignores a tampered stored codec value', () => {
        store.set('cipherline_screenshare_codec', 'av1');
        expect(getScreenShareCodecPref()).toBe('auto');
    });
});
