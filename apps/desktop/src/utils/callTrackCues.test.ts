import { describe, it, expect } from 'vitest';
import { cameraCueForEvent } from './callTrackCues';

describe('cameraCueForEvent', () => {
    it('maps a first-ever publish to camera_on when ready', () => {
        expect(cameraCueForEvent('published', true)).toBe('camera_on');
    });

    it('maps unmute to camera_on when ready', () => {
        expect(cameraCueForEvent('unmuted', true)).toBe('camera_on');
    });

    it('maps mute to camera_off when ready', () => {
        expect(cameraCueForEvent('muted', true)).toBe('camera_off');
    });

    it('suppresses every event type when not ready (join-storm / reconnect-resync gate)', () => {
        expect(cameraCueForEvent('published', false)).toBeNull();
        expect(cameraCueForEvent('unmuted', false)).toBeNull();
        expect(cameraCueForEvent('muted', false)).toBeNull();
    });

    it('never maps an unpublish event to a cue, ready or not — that path is participant-departure teardown, already covered by the leave cue', () => {
        // @ts-expect-error — 'unpublished' is deliberately not part of CameraTrackEvent;
        // verifying the runtime default branch is still safe if a caller widens the type.
        expect(cameraCueForEvent('unpublished', true)).toBeNull();
    });
});
