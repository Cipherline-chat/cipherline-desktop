import { describe, it, expect, afterEach } from 'vitest';
import {
    LEVEL_STALE_MS,
    boostNeedsWebAudio,
    isIncomingLevelerEnabled,
    pickRtpLevel,
    setIncomingLevelerEnabled,
    subscribeIncomingLeveler,
} from './incomingLeveler';

describe('pickRtpLevel', () => {
    const now = 10_000;

    it('returns the level of a fresh reading', () => {
        expect(pickRtpLevel([{ timestamp: now - 20, audioLevel: 0.05 }], now)).toBe(0.05);
    });

    it('is undefined when there are no sources (nothing received yet / talker silent)', () => {
        expect(pickRtpLevel([], now)).toBeUndefined();
        expect(pickRtpLevel(undefined, now)).toBeUndefined();
    });

    it('is undefined for a stale reading: no packets lately is a pause, not the last level held forever', () => {
        expect(pickRtpLevel([{ timestamp: now - LEVEL_STALE_MS - 1, audioLevel: 0.2 }], now)).toBeUndefined();
        // control: right at the edge still counts
        expect(pickRtpLevel([{ timestamp: now - LEVEL_STALE_MS, audioLevel: 0.2 }], now)).toBe(0.2);
    });

    it('is undefined when the extension is absent (no audioLevel): the leveler then stays out of it', () => {
        expect(pickRtpLevel([{ timestamp: now - 10 }], now)).toBeUndefined();
        expect(pickRtpLevel([{ timestamp: now - 10, audioLevel: Number.NaN }], now)).toBeUndefined();
    });

    it('ignores entries without a timestamp (cannot be judged fresh)', () => {
        expect(pickRtpLevel([{ audioLevel: 0.3 }], now)).toBeUndefined();
    });

    it('takes the freshest of several sources', () => {
        expect(
            pickRtpLevel([
                { timestamp: now - 300, audioLevel: 0.9 },
                { timestamp: now - 10, audioLevel: 0.1 },
                { timestamp: now - 150, audioLevel: 0.5 },
            ], now),
        ).toBe(0.1);
    });

    it('treats a digital-silence level of 0 as a real reading (the leveler decides it is a pause)', () => {
        expect(pickRtpLevel([{ timestamp: now - 10, audioLevel: 0 }], now)).toBe(0);
    });
});

describe('boostNeedsWebAudio — only a boost the <audio> element cannot play leaves the element path', () => {
    it('a cut never needs Web Audio', () => {
        expect(boostNeedsWebAudio(1, 1, -6)).toBe(false);
        expect(boostNeedsWebAudio(2, 1, -9)).toBe(false);
    });

    it('no boost, or a hair of boost, never does either', () => {
        expect(boostNeedsWebAudio(1, 1, 0)).toBe(false);
        expect(boostNeedsWebAudio(1, 1, 0.5)).toBe(false);
    });

    it('a real boost on top of unity per-user x master does', () => {
        expect(boostNeedsWebAudio(1, 1, 3)).toBe(true);
        expect(boostNeedsWebAudio(1, 1, 6)).toBe(true);
    });

    it('a boost that fits under the user\'s own headroom stays on the element', () => {
        // user turned this person down to 0.5: +3 dB (x1.41) -> 0.71 <= 1
        expect(boostNeedsWebAudio(0.5, 1, 3)).toBe(false);
        // ...but +6.1 dB (x2.02) on 0.5 -> 1.01 > 1
        expect(boostNeedsWebAudio(0.5, 1, 6.1)).toBe(true);
        // master at 50 % gives the same headroom
        expect(boostNeedsWebAudio(1, 0.5, 3)).toBe(false);
    });

    it('garbage gain is not a reason to switch path', () => {
        expect(boostNeedsWebAudio(Number.NaN, 1, 3)).toBe(false);
        expect(boostNeedsWebAudio(1, 1, Number.NaN)).toBe(false);
    });
});

describe('the Normalize voice volume switch', () => {
    afterEach(() => setIncomingLevelerEnabled(true));

    it('defaults to ON', () => {
        expect(isIncomingLevelerEnabled()).toBe(true);
    });

    it('notifies subscribers only on a real change, and stops after unsubscribe', () => {
        let calls = 0;
        const off = subscribeIncomingLeveler(() => { calls++; });
        setIncomingLevelerEnabled(true); // no change
        expect(calls).toBe(0);
        setIncomingLevelerEnabled(false);
        expect(isIncomingLevelerEnabled()).toBe(false);
        expect(calls).toBe(1);
        setIncomingLevelerEnabled(true);
        expect(calls).toBe(2);
        off();
        setIncomingLevelerEnabled(false);
        expect(calls).toBe(2);
    });

    it('a throwing subscriber does not stop the others or the switch', () => {
        let ok = 0;
        const a = subscribeIncomingLeveler(() => { throw new Error('boom'); });
        const b = subscribeIncomingLeveler(() => { ok++; });
        setIncomingLevelerEnabled(false);
        expect(isIncomingLevelerEnabled()).toBe(false);
        expect(ok).toBe(1);
        a(); b();
    });
});
