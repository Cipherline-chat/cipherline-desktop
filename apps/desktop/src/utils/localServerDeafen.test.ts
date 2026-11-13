import { describe, it, expect, beforeEach } from 'vitest';
import {
    getLocalServerDeafened, setLocalServerDeafened, shouldSilenceMicAudio, shouldSilenceShareAudio,
    __resetLocalServerDeafened,
} from './localServerDeafen';

/**
 * Server deafen = "do not play other participants' MICROPHONES". It must not
 * silence screen-share audio (a deafened member still hears shares and sees
 * video), and it must not be confused with the member's own self-deafen, which
 * silences everything. These two predicates are what the audio chains use.
 */
describe('which remote audio a deafen silences', () => {
    const none = { isLocalMuted: false, isLocalDeafened: false, serverDeafened: false };

    it('negative control: nothing set -> microphones play', () => {
        expect(shouldSilenceMicAudio(none)).toBe(false);
    });

    it('SERVER deafen silences other participants\' microphones', () => {
        expect(shouldSilenceMicAudio({ ...none, serverDeafened: true })).toBe(true);
    });

    it('self-deafen and locally muting that person still silence their microphone', () => {
        expect(shouldSilenceMicAudio({ ...none, isLocalDeafened: true })).toBe(true);
        expect(shouldSilenceMicAudio({ ...none, isLocalMuted: true })).toBe(true);
    });

    it('SERVER deafen does NOT silence screen-share audio (the share chain has no server-deafen input at all)', () => {
        // The share predicate's inputs are only the user's own choices. A server
        // deafen cannot reach it - that is the point.
        expect(shouldSilenceShareAudio({ isLocalDeafened: false, isScreenShareMuted: false })).toBe(false);
        expect(shouldSilenceShareAudio.length).toBe(1);
    });

    it('self-deafen and muting the share still silence share audio', () => {
        expect(shouldSilenceShareAudio({ isLocalDeafened: true, isScreenShareMuted: false })).toBe(true);
        expect(shouldSilenceShareAudio({ isLocalDeafened: false, isScreenShareMuted: true })).toBe(true);
    });

    it('deafened by a moderator AND by themselves: microphones silent, and shares silent only because of the SELF deafen', () => {
        expect(shouldSilenceMicAudio({ isLocalMuted: false, isLocalDeafened: true, serverDeafened: true })).toBe(true);
        expect(shouldSilenceShareAudio({ isLocalDeafened: true, isScreenShareMuted: false })).toBe(true);
    });
});

describe('the local server-deafen flag store', () => {
    beforeEach(() => __resetLocalServerDeafened());

    it('defaults to false, sets, clears', () => {
        expect(getLocalServerDeafened()).toBe(false);
        setLocalServerDeafened(true);
        expect(getLocalServerDeafened()).toBe(true);
        setLocalServerDeafened(false);
        expect(getLocalServerDeafened()).toBe(false);
    });
});
