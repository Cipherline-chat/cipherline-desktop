import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./secureLocalStore', () => ({ default: { getItem: () => null, setItem: () => {} } }));

import {
    CALL_NOTICE_Z, CALL_FULLSCREEN_Z, CALL_PROMPT_Z, CALL_REQUESTS_DOCK_Z, CALL_PROMPT_OVERLAY_STYLE,
    holdCallNotices, callNoticesHeld, subscribeCallNoticeHold, callOfferWrapper, __resetCallNoticeHoldsForTests,
} from './callNoticeLayer';
import {
    acquireCallOfferSlot, releaseCallOfferSlot, callOfferSlotHolder, waitForCallOfferSlot, __resetCallOfferSlotForTests,
    CALL_OFFER_WRAPPER_CLASS, CALL_OFFER_FALLBACK_CLASS,
} from './performanceOffer';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

beforeEach(() => { __resetCallNoticeHoldsForTests(); __resetCallOfferSlotForTests(); });

describe('stacking order: an actionable prompt is never under a notice', () => {
    it('notice < fullscreen call < prompt < requests dock', () => {
        expect(CALL_NOTICE_Z).toBeLessThan(CALL_FULLSCREEN_Z);
        expect(CALL_FULLSCREEN_Z).toBeLessThan(CALL_PROMPT_Z);
        expect(CALL_PROMPT_Z).toBeLessThan(CALL_REQUESTS_DOCK_Z);
    });

    it('the prompt is above a plain ClModal too (the .mod z-index the screen chooser used to have)', () => {
        const css = read('styles/cl-kit-ext.css');
        const m = /\.mod\{z-index:(\d+)\}/.exec(css);
        expect(m).not.toBeNull();
        // The bug: notices at 9500 over a modal at 1000.
        expect(Number(m![1])).toBeLessThan(CALL_NOTICE_Z);
        expect(CALL_PROMPT_OVERLAY_STYLE.zIndex).toBe(CALL_PROMPT_Z);
    });

    it('the listed values are the real ones (fullscreen overlay, requests dock)', () => {
        expect(read('components/call/FullscreenOverlay.tsx')).toContain(`fixed inset-0 z-[${CALL_FULLSCREEN_Z}]`);
        expect(read('components/call/AnnotationRequestsDock.tsx')).toContain(`z-[${CALL_REQUESTS_DOCK_Z}]`);
    });

    it('the notice wrapper class carries no z-index of its own (one source: CALL_NOTICE_Z)', () => {
        expect(CALL_OFFER_WRAPPER_CLASS).not.toMatch(/\bz-/);
    });
});

describe('holds: open prompts hold the notices back', () => {
    it('held while any prompt holds; free again when the LAST one lets go', () => {
        expect(callNoticesHeld()).toBe(false);
        const a = holdCallNotices('a');
        const b = holdCallNotices('b');
        expect(callNoticesHeld()).toBe(true);
        a();
        expect(callNoticesHeld()).toBe(true);
        b();
        expect(callNoticesHeld()).toBe(false);
    });

    it('notifies only on the held/free edges; releasing twice is harmless', () => {
        const cb = vi.fn();
        const off = subscribeCallNoticeHold(cb);
        const a = holdCallNotices('a');
        const b = holdCallNotices('b');
        expect(cb).toHaveBeenCalledTimes(1);
        a(); a();
        expect(cb).toHaveBeenCalledTimes(1);
        b();
        expect(cb).toHaveBeenCalledTimes(2);
        off();
        holdCallNotices('c');
        expect(cb).toHaveBeenCalledTimes(2);
    });

    it('a stale release of an id another holder re-took does not free the notices early', () => {
        const first = holdCallNotices('screen-choice');
        first();
        const second = holdCallNotices('screen-choice');
        first();                                   // already released: no effect
        expect(callNoticesHeld()).toBe(true);
        second();
        expect(callNoticesHeld()).toBe(false);
    });
});

describe('callOfferWrapper: where a notice card renders', () => {
    it('measured: at the anchor, on the notice layer, shown', () => {
        expect(callOfferWrapper({ top: 102, left: 396 }, false)).toEqual({
            className: CALL_OFFER_WRAPPER_CLASS,
            style: { zIndex: CALL_NOTICE_Z, top: 102, left: 396 },
            held: false,
        });
    });
    it('not measured yet: the fallback offsets, still on the notice layer', () => {
        const w = callOfferWrapper(null, false);
        expect(w.className).toBe(`${CALL_OFFER_WRAPPER_CLASS} ${CALL_OFFER_FALLBACK_CLASS}`);
        expect(w.style).toEqual({ zIndex: CALL_NOTICE_Z });
    });
    it('held: taken out of the layout entirely (display:none, so no clicks, no focus, no half-visible card)', () => {
        expect(callOfferWrapper({ top: 1, left: 2 }, true).style.display).toBe('none');
        expect(callOfferWrapper(null, true)).toMatchObject({ held: true, style: { display: 'none' } });
    });
});

describe('waitForCallOfferSlot: a one-shot notice queues instead of being dropped', () => {
    it('free slot: granted at once', () => {
        const got = vi.fn();
        const cancel = waitForCallOfferSlot('note', got);
        expect(got).toHaveBeenCalledTimes(1);
        expect(callOfferSlotHolder()).toBe('note');
        cancel();
        expect(callOfferSlotHolder()).toBeNull();
    });

    it('taken slot: waits, and is granted exactly once when the card in it closes', () => {
        expect(acquireCallOfferSlot('share-overload')).toBe(true);
        const got = vi.fn();
        waitForCallOfferSlot('note', got);
        expect(got).not.toHaveBeenCalled();
        expect(callOfferSlotHolder()).toBe('share-overload');
        releaseCallOfferSlot('share-overload');
        expect(got).toHaveBeenCalledTimes(1);
        expect(callOfferSlotHolder()).toBe('note');
        // While it is up, a detection-style offer finds the slot taken (and stays eligible).
        expect(acquireCallOfferSlot('share-overload')).toBe(false);
    });

    it('cancelled while waiting: never granted, never takes the slot', () => {
        acquireCallOfferSlot('gaming');
        const got = vi.fn();
        const cancel = waitForCallOfferSlot('note', got);
        cancel();
        releaseCallOfferSlot('gaming');
        expect(got).not.toHaveBeenCalled();
        expect(callOfferSlotHolder()).toBeNull();
    });

    it('two waiters: one at a time, in turn', () => {
        acquireCallOfferSlot('perf');
        const a = vi.fn();
        const b = vi.fn();
        const cancelA = waitForCallOfferSlot('a', a);
        waitForCallOfferSlot('b', b);
        releaseCallOfferSlot('perf');
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
        cancelA();
        expect(b).toHaveBeenCalledTimes(1);
        expect(callOfferSlotHolder()).toBe('b');
    });
});
