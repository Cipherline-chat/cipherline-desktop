import { describe, it, expect, beforeEach } from 'vitest';
import {
    classifyCameraStop, classifyShareEnd, noteUserCameraAction, userCameraActionRecent, noteDeliberateShareChange,
    deliberateShareChangeRecent, cameraStopNotice, shareEndNotice, __resetMediaSelfStopForTests,
    USER_INTENT_WINDOW_MS, ENDED_CAUSE_WINDOW_MS, DELIBERATE_SHARE_WINDOW_MS,
} from './mediaSelfStop';

beforeEach(() => __resetMediaSelfStopForTests());

const cam = (o: Partial<Parameters<typeof classifyCameraStop>[0]> = {}) => classifyCameraStop({
    event: 'muted', userRecent: false, republishing: false, sinceEndedMs: null, roomConnected: true, ...o,
});

describe('classifyCameraStop', () => {
    it('a mute with no press is an unprompted stop', () => expect(cam()).toBe('muted_unprompted'));
    it('a press just before explains the mute', () => expect(cam({ userRecent: true })).toBeNull());
    it('a track `ended` shortly before the mute names the device as the cause', () => {
        expect(cam({ sinceEndedMs: 800 })).toBe('device_ended');
        expect(cam({ sinceEndedMs: ENDED_CAUSE_WINDOW_MS - 1 })).toBe('device_ended');
    });
    it('an `ended` long ago is not the cause', () => expect(cam({ sinceEndedMs: ENDED_CAUSE_WINDOW_MS })).toBe('muted_unprompted'));
    it('nothing is a self-stop once the room is gone (a leave unpublishes everything)', () => {
        expect(cam({ roomConnected: false })).toBeNull();
        expect(cam({ event: 'unpublished', roomConnected: false })).toBeNull();
    });
    it('an unpublish with a replacement or a republish in flight is not a stop', () => {
        expect(cam({ event: 'unpublished', replacementPresent: true })).toBeNull();
        expect(cam({ event: 'unpublished', republishing: true })).toBeNull();
    });
    it('an unpublish with nothing following is a stop', () => expect(cam({ event: 'unpublished', replacementPresent: false })).toBe('unpublished_unprompted'));
    it('a mute during a make-before-break republish is still a stop (republish never mutes)', () => expect(cam({ republishing: true })).toBe('muted_unprompted'));
});

describe('classifyShareEnd', () => {
    const f = (o: Partial<Parameters<typeof classifyShareEnd>[0]> = {}) => classifyShareEnd({
        roomConnected: true, deliberate: false, replacementPresent: false, sinceEndedMs: null, ...o,
    });
    it('an unpublish nobody asked for is a self-end', () => expect(f()).toBe('unpublished_unprompted'));
    it('a capture `ended` just before names the capture', () => expect(f({ sinceEndedMs: 50 })).toBe('capture_ended'));
    it('a deliberate stop / restart, a landed swap and a leave are not self-ends', () => {
        expect(f({ deliberate: true })).toBeNull();
        expect(f({ replacementPresent: true })).toBeNull();
        expect(f({ roomConnected: false })).toBeNull();
    });
});

describe('user-intent windows', () => {
    it('a press is recent only inside the window', () => {
        noteUserCameraAction(10_000);
        expect(userCameraActionRecent(10_000 + USER_INTENT_WINDOW_MS - 1)).toBe(true);
        expect(userCameraActionRecent(10_000 + USER_INTENT_WINDOW_MS)).toBe(false);
        expect(userCameraActionRecent(9_999)).toBe(false);
    });
    it('no press yet is never recent', () => expect(userCameraActionRecent(1)).toBe(false));
    it('a deliberate share change is recent only inside its window', () => {
        noteDeliberateShareChange(5_000);
        expect(deliberateShareChangeRecent(5_000 + DELIBERATE_SHARE_WINDOW_MS - 1)).toBe(true);
        expect(deliberateShareChangeRecent(5_000 + DELIBERATE_SHARE_WINDOW_MS)).toBe(false);
    });
});

describe('notices', () => {
    it('differ by cause and say something', () => {
        for (const t of [cameraStopNotice('device_ended'), cameraStopNotice('muted_unprompted'), shareEndNotice('capture_ended'), shareEndNotice('unpublished_unprompted')]) {
            expect(t.length).toBeGreaterThan(20);
        }
        expect(cameraStopNotice('device_ended')).not.toBe(cameraStopNotice('muted_unprompted'));
    });
});
