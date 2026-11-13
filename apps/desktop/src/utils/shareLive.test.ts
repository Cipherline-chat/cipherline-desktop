import { describe, it, expect } from 'vitest';
import { Track } from 'livekit-client';
import { localShareLive, localCameraLive } from './shareLive';

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

describe('localCameraLive (what ShareBoostGuard tells main about OUR camera)', () => {
    const room = (pubs: Array<{ source: Track.Source; isMuted?: boolean }>) => ({
        localParticipant: { getTrackPublications: () => pubs, getTrackPublication: () => undefined },
    });
    it('true for a published, un-muted camera', () => {
        expect(localCameraLive(room([{ source: Track.Source.Camera, isMuted: false }]))).toBe(true);
    });
    it('false when the camera is muted (switched off), absent, or only a mic / share exists', () => {
        expect(localCameraLive(room([{ source: Track.Source.Camera, isMuted: true }]))).toBe(false);
        expect(localCameraLive(room([]))).toBe(false);
        expect(localCameraLive(room([{ source: Track.Source.Microphone }, { source: Track.Source.ScreenShare }]))).toBe(false);
        expect(localCameraLive(null)).toBe(false);
    });
    it('a make-before-break republish (old muted/new live or both live) counts as live', () => {
        expect(localCameraLive(room([{ source: Track.Source.Camera, isMuted: true }, { source: Track.Source.Camera, isMuted: false }]))).toBe(true);
    });
    it('falls back to getTrackPublication, and a throwing room is "not live"', () => {
        expect(localCameraLive({ localParticipant: { getTrackPublication: () => ({ isMuted: false }) } })).toBe(true);
        expect(localCameraLive({ localParticipant: { getTrackPublication: () => ({ isMuted: true }) } })).toBe(false);
        expect(localCameraLive({ localParticipant: { getTrackPublication: () => { throw new Error('x'); } } })).toBe(false);
    });
});
