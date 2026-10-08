import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    default: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    },
}));

import {
    parsePerfOfferState, canOfferPerf, answerPerfOffer, readPerfOfferState, writePerfOfferState,
    acquireCallOfferSlot, releaseCallOfferSlot, callOfferSlotHolder, __resetCallOfferSlotForTests,
    PERF_OFFER_KEY, SNOOZE_MS, DEFAULT_PERF_OFFER_STATE, PERF_OFFER_COPY,
    choosePerfOffer, perfOfferCopy, perfOfferEffects,
    CALL_OFFER_WRAPPER_CLASS, CALL_OFFER_FALLBACK_CLASS, CALL_OFFER_ENTER_CLASS, callOfferPosition,
} from './performanceOffer';

const NOW = 1_800_000_000_000;
const base = { state: { ...DEFAULT_PERF_OFFER_STATE }, now: NOW, shownThisCall: false, cameraHeight: 1080 };

beforeEach(() => { store.clear(); __resetCallOfferSlotForTests(); });

describe('parsePerfOfferState', () => {
    it.each([
        [null], [undefined], [''], ['not json'], ['[]'], ['null'], ['"x"'], ['x'.repeat(300)],
    ])('malformed %s → default (ask again)', raw => {
        expect(parsePerfOfferState(raw as string | null | undefined)).toEqual(DEFAULT_PERF_OFFER_STATE);
    });
    it('reads valid fields and sanitises bad ones', () => {
        expect(parsePerfOfferState(JSON.stringify({ snoozedUntil: 5, never: true }))).toEqual({ snoozedUntil: 5, never: true });
        expect(parsePerfOfferState(JSON.stringify({ snoozedUntil: -1, never: 'yes' }))).toEqual({ snoozedUntil: 0, never: false });
        expect(parsePerfOfferState(JSON.stringify({ snoozedUntil: Infinity }))).toEqual({ snoozedUntil: 0, never: false });
    });
});

describe('canOfferPerf — rate limits', () => {
    it('offers when nothing blocks it', () => {
        expect(canOfferPerf(base)).toBe(true);
    });
    it('at most once per call', () => {
        expect(canOfferPerf({ ...base, shownThisCall: true })).toBe(false);
    });
    it('only while the camera is ABOVE 720p (that is what "Lower" changes)', () => {
        expect(canOfferPerf({ ...base, cameraHeight: 720 })).toBe(false);
        expect(canOfferPerf({ ...base, cameraHeight: 0 })).toBe(false);
        expect(canOfferPerf({ ...base, cameraHeight: 1440 })).toBe(true);
    });
    it('"Not now" snoozes 24 h, then asks again', () => {
        const s = answerPerfOffer(DEFAULT_PERF_OFFER_STATE, 'not-now', NOW);
        expect(s.snoozedUntil).toBe(NOW + SNOOZE_MS);
        expect(canOfferPerf({ ...base, state: s, now: NOW + SNOOZE_MS - 1 })).toBe(false);
        expect(canOfferPerf({ ...base, state: s, now: NOW + SNOOZE_MS })).toBe(true);
    });
    it('a snooze far in the future (clock moved back) is not honoured forever', () => {
        expect(canOfferPerf({ ...base, state: { snoozedUntil: NOW + 30 * SNOOZE_MS, never: false } })).toBe(true);
    });
    it('"Don\'t ask again" is permanent', () => {
        const s = answerPerfOffer(DEFAULT_PERF_OFFER_STATE, 'never', NOW);
        expect(canOfferPerf({ ...base, state: s, now: NOW + 365 * SNOOZE_MS })).toBe(false);
    });
    it('"Lower" clears a snooze (the camera at 720p then stops further offers by itself)', () => {
        const s = answerPerfOffer({ snoozedUntil: NOW + 5, never: false }, 'lower', NOW);
        expect(s.snoozedUntil).toBe(0);
        expect(canOfferPerf({ ...base, state: s, cameraHeight: 720 })).toBe(false);
    });
});

describe('persistence', () => {
    it('round-trips through secureLocalStore under the registered key, two fields only', () => {
        writePerfOfferState({ snoozedUntil: 123, never: true });
        expect(JSON.parse(store.get(PERF_OFFER_KEY)!)).toEqual({ snoozedUntil: 123, never: true });
        expect(readPerfOfferState()).toEqual({ snoozedUntil: 123, never: true });
    });
});

describe('the shared in-call offer slot — never two prompts at once', () => {
    it('one holder at a time; the same holder may re-acquire', () => {
        expect(acquireCallOfferSlot('performance')).toBe(true);
        expect(acquireCallOfferSlot('gaming')).toBe(false);
        expect(acquireCallOfferSlot('performance')).toBe(true);
        expect(callOfferSlotHolder()).toBe('performance');
    });
    it('releasing frees it; a stranger cannot release someone else\'s slot', () => {
        acquireCallOfferSlot('gaming');
        releaseCallOfferSlot('performance');
        expect(callOfferSlotHolder()).toBe('gaming');
        releaseCallOfferSlot('gaming');
        expect(acquireCallOfferSlot('performance')).toBe(true);
    });
});

describe('copy', () => {
    it('says what happens and where to undo it', () => {
        expect(PERF_OFFER_COPY.title).toBe('Your PC is struggling to keep up');
        expect(PERF_OFFER_COPY.body).toMatch(/720p/);
        expect(PERF_OFFER_COPY.body).toMatch(/Voice & Video/);
        expect([PERF_OFFER_COPY.accept, PERF_OFFER_COPY.decline, PERF_OFFER_COPY.never]).toEqual(['Lower to 720p', 'Not now', 'Don’t ask again']);
    });
});

describe('choosePerfOffer — offer what is actually expensive', () => {
    const base = { encodeStrained: false, decodeStrained: false, cameraHeight: 1080, incomingMode: 'auto' as const, remoteVideoCount: 6 };
    it.each([
        // encode, decode, camH, mode, remotes, expected
        [true, false, 1080, 'auto', 6, 'camera'],
        [false, true, 1080, 'auto', 6, 'incoming'],
        [true, true, 1080, 'auto', 6, 'both'],
        [true, true, 720, 'auto', 6, 'incoming'],     // camera already at 720p: nothing to lower there
        [true, true, 1080, 'reduced', 6, 'camera'],   // incoming already reduced
        [false, true, 1080, 'datasaver', 6, null],
        [false, true, 0, 'auto', 1, null],            // one remote camera is not "lots of video"
        [true, false, 720, 'auto', 6, null],
        [false, false, 1440, 'auto', 12, null],
    ] as const)('encode=%s decode=%s cam=%d mode=%s remotes=%d → %s', (e, d, h, mode, n, want) => {
        expect(choosePerfOffer({ ...base, encodeStrained: e, decodeStrained: d, cameraHeight: h, incomingMode: mode, remoteVideoCount: n })).toBe(want);
    });

    it('copy and effects per offer', () => {
        expect(perfOfferCopy('camera')).toEqual({ ...PERF_OFFER_COPY });
        expect(perfOfferCopy('incoming').title).toBe('Lots of video in this call is slowing your PC');
        expect(perfOfferCopy('incoming').body).toMatch(/^Show other people’s cameras in lower quality\?/);
        expect(perfOfferCopy('incoming').accept).toBe('Lower');
        expect(perfOfferCopy('both').accept).toBe('Lower both');
        for (const k of ['camera', 'incoming', 'both'] as const) {
            expect(perfOfferCopy(k).decline).toBe('Not now');
            expect(perfOfferCopy(k).never).toBe('Don’t ask again');
        }
        expect(perfOfferEffects('camera')).toEqual({ cameraTier: '720p' });
        expect(perfOfferEffects('incoming')).toEqual({ incomingMode: 'reduced' });
        expect(perfOfferEffects('both')).toEqual({ cameraTier: '720p', incomingMode: 'reduced' });
    });

    it('the gate allows a receive-side offer with the camera off, but not once incoming is already reduced', () => {
        const g = { state: { ...DEFAULT_PERF_OFFER_STATE }, now: NOW, shownThisCall: false };
        expect(canOfferPerf({ ...g, cameraHeight: 0, incomingAdjustable: true })).toBe(true);
        expect(canOfferPerf({ ...g, cameraHeight: 0, incomingAdjustable: false })).toBe(false);
        expect(canOfferPerf({ ...g, cameraHeight: 0, incomingAdjustable: true, shownThisCall: true })).toBe(false);
    });
});

describe('in-call offer card placement', () => {
    const vp = { width: 1280, height: 720 };
    // Pane 3 as it sits with a 72px rail + 300px sidebar, under the 34px titlebar.
    const pane = { left: 380, top: 40, width: 880, height: 670 };

    it('wrapper class is position-agnostic: fixed, no left/right/top offsets of its own', () => {
        const cls = CALL_OFFER_WRAPPER_CLASS.split(/\s+/);
        expect(cls).toContain('fixed');
        expect(cls).toContain('pointer-events-none');
        expect(cls.some(c => /^(left|right|top|bottom|inset)-/.test(c))).toBe(false);
    });
    it('fallback is top-left clear of the titlebar and the 72px rail', () => {
        expect(CALL_OFFER_FALLBACK_CLASS).toBe('top-14 left-[88px]');
    });
    it('anchors to the main pane top-left, below its 54px header', () => {
        expect(callOfferPosition(pane, vp)).toEqual({ left: 396, top: 102 });
    });
    it('tracks the pane when the sidebar is resized or collapsed', () => {
        expect(callOfferPosition({ ...pane, left: 90, width: 1170 }, vp)).toEqual({ left: 106, top: 102 });
    });
    it('follows the pane down when a focused stream sits above it', () => {
        expect(callOfferPosition({ ...pane, top: 340, height: 370 }, vp)).toEqual({ left: 396, top: 402 });
    });
    it('no pane / hidden pane → null (use the fallback class)', () => {
        expect(callOfferPosition(null, vp)).toBeNull();
        expect(callOfferPosition({ ...pane, width: 0 }, vp)).toBeNull();
        expect(callOfferPosition({ ...pane, height: 0 }, vp)).toBeNull();
    });
    it('stays fully on screen in a narrow or short window', () => {
        expect(callOfferPosition({ ...pane, left: 1000 }, vp)?.left).toBe(1280 - 340 - 16);
        expect(callOfferPosition({ ...pane, left: -50 }, vp)?.left).toBe(16);
        expect(callOfferPosition({ ...pane, top: 900 }, vp)?.top).toBe(720 - 140);
    });
    it('enters from the left edge', () => {
        expect(CALL_OFFER_ENTER_CLASS).toBe('fade-slide-left-enter');
    });
});
