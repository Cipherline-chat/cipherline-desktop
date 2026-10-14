import { describe, it, expect } from 'vitest';
import { localShareLive } from './shareLive';

describe('localShareLive (what ShareBoostGuard tells main)', () => {
    it('true only while a screen-share video publication exists', () => {
        const room = (pub: unknown) => ({ localParticipant: { getTrackPublication: () => pub } });
        expect(localShareLive(room({ trackSid: 'TR_1' }))).toBe(true);
        expect(localShareLive(room(undefined))).toBe(false);
        expect(localShareLive(null)).toBe(false);
        expect(localShareLive(undefined)).toBe(false);
        expect(localShareLive({ localParticipant: { getTrackPublication: () => { throw new Error('disconnected'); } } })).toBe(false);
    });
});
