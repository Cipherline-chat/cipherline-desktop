import { describe, it, expect } from 'vitest';
import { decideCameraHold, cameraHoldClears, cameraHoldRemainingMs, CAMERA_HOLD_MAX_MS, CAMERA_HOLD_GRACE_MS } from './cameraSwapHold';
import { RemoteCameraGapTracker, GAP_MAX_LOG_MS, type GapEvent } from './remoteCameraGap';

const live = { sameTile: true, alreadyHeld: false, readyState: 4, videoWidth: 1280, videoHeight: 720, muted: false, replacementKnown: true };

describe('decideCameraHold', () => {
    it('swap (replacement known) -> show', () => { expect(decideCameraHold(live)).toBe('show'); });
    it('no replacement yet -> pending (frame hidden, placeholder shows)', () => {
        expect(decideCameraHold({ ...live, replacementKnown: false })).toBe('pending');
    });
    it('muted = camera off -> no frame at all, replacement or not', () => {
        expect(decideCameraHold({ ...live, muted: true })).toBe('none');
        expect(decideCameraHold({ ...live, muted: true, replacementKnown: false })).toBe('none');
    });
    it('never from an element with no frame or the SFU\'s blank 8x8 burst', () => {
        expect(decideCameraHold({ ...live, readyState: 1 })).toBe('none');
        expect(decideCameraHold({ ...live, videoWidth: 8, videoHeight: 8 })).toBe('none');
        expect(decideCameraHold({ ...live, videoWidth: 0, videoHeight: 0 })).toBe('none');
    });
    it('keeps the older real picture across a second swap; never for a recycled tile', () => {
        expect(decideCameraHold({ ...live, alreadyHeld: true })).toBe('none');
        expect(decideCameraHold({ ...live, sameTile: false })).toBe('none');
    });
});

describe('cameraHoldClears', () => {
    it('mute and disconnect clear immediately', () => {
        expect(cameraHoldClears({ type: 'muted' })).toBe(true);
        expect(cameraHoldClears({ type: 'disconnected' })).toBe(true);
    });
    it('unpublish clears unless a replacement exists', () => {
        expect(cameraHoldClears({ type: 'unpublished', replacementExists: false })).toBe(true);
        expect(cameraHoldClears({ type: 'unpublished', replacementExists: true })).toBe(false);
    });
    it('grace expiry clears unless the replacement arrived', () => {
        expect(cameraHoldClears({ type: 'grace_expired', replacementArrived: false })).toBe(true);
        expect(cameraHoldClears({ type: 'grace_expired', replacementArrived: true })).toBe(false);
    });
    it('the grace is at most 250 ms', () => { expect(CAMERA_HOLD_GRACE_MS).toBeLessThanOrEqual(250); });
});

describe('cameraHoldRemainingMs', () => {
    it('counts down from the cap and floors at 0', () => {
        expect(cameraHoldRemainingMs(1_000, 1_000)).toBe(CAMERA_HOLD_MAX_MS);
        expect(cameraHoldRemainingMs(1_000, 3_000)).toBe(CAMERA_HOLD_MAX_MS - 2_000);
        expect(cameraHoldRemainingMs(1_000, 99_000)).toBe(0);
    });
    it('covers the measured drift gap (5.5 s) with room for the next keyframe', () => {
        expect(CAMERA_HOLD_MAX_MS).toBeGreaterThanOrEqual(5_500 + 1_500);
    });
});

describe('RemoteCameraGapTracker', () => {
    const mk = () => {
        let t = 0; const out: GapEvent[] = [];
        const tr = new RemoteCameraGapTracker(() => t, e => out.push(e));
        return { tr, out, at: (n: number) => { t = n; } };
    };
    it('logs one gap with the first reason and its length', () => {
        const { tr, out, at } = mk();
        at(1_000); tr.lost('a', 'unpublished', 'remote-video-1');
        at(1_100); tr.lost('a', 'unsubscribed', 'remote-video-1');
        at(1_900); tr.back('a');
        expect(out).toEqual([{ track: 'remote-video-1', reason: 'unpublished', ms: 900 }]);
    });
    it('a back with nothing open logs nothing; a gap is logged once', () => {
        const { tr, out } = mk();
        tr.back('a');
        tr.lost('a', 'muted', 'remote-video-2'); tr.back('a'); tr.back('a');
        expect(out).toHaveLength(1);
    });
    it('a long absence is a deliberate camera-off, not a glitch', () => {
        const { tr, out, at } = mk();
        tr.lost('a', 'muted', 'remote-video-1');
        at(GAP_MAX_LOG_MS + 1); tr.back('a');
        expect(out).toEqual([]);
    });
    it('participants are independent; a leaver\'s open gap is dropped', () => {
        const { tr, out, at } = mk();
        tr.lost('a', 'muted', 'remote-video-1'); tr.lost('b', 'unpublished', 'remote-video-2');
        tr.drop('a'); at(500); tr.back('a'); tr.back('b');
        expect(out).toEqual([{ track: 'remote-video-2', reason: 'unpublished', ms: 500 }]);
    });
});
