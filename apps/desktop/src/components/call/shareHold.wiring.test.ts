import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SidebarConference and CallPane need a live room to render, so where the hold is
 * wired into them is pinned at the source level, in the style of the other call
 * wiring tests. Each of these is an ordering the behaviour depends on.
 */
const conference = readFileSync(join(__dirname, '..', 'SidebarConference.tsx'), 'utf8');
const pane = readFileSync(join(__dirname, '..', 'CallPane.tsx'), 'utf8');
const banner = readFileSync(join(__dirname, 'FocusedStreamBanner.tsx'), 'utf8');

const at = (src: string, needle: string): number => {
    const i = src.indexOf(needle);
    expect(i, `"${needle}" not found`).toBeGreaterThanOrEqual(0);
    return i;
};

describe('a codec swap is announced and subscribed ahead of the switch', () => {
    it('every swap of the share announces, so a viewer holds through the old track going', () => {
        const calls = conference.split('await swapShareCodec(').slice(1);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const call of calls) expect(call.slice(0, call.indexOf('});'))).toContain('announce: () => announceShareSwap(');
    });

    it('a watcher subscribes to every share publication, not only the one getTrackPublication returns', () => {
        const effect = conference.slice(at(conference, '// Auto-resubscribe effect'), at(conference, '// Clear the "hidden screenshare" flag'));
        expect(effect).toContain('sharePublications(p');
    });
});

describe('the publisher only announces a republish that will really unpublish', () => {
    const start = conference.slice(at(conference, 'const startScreenShareFrom = async'));
    const begin = at(start, 'shareRepublishSignal.begin(localParticipant)');

    it('announces after every route that leaves the track alone, so those stay non-events', () => {
        // The audio-only change, the in-place retune and the hot swap all return first.
        expect(at(start, 'await applyAudioOnlyChange(options')).toBeLessThan(begin);
        expect(at(start, 'await applyLiveSelection(liveShareApplier()')).toBeLessThan(begin);
        expect(at(start, 'await tryHotSwapScreenShare(options')).toBeLessThan(begin);
        // A source that will not open is found out here, with the running share untouched.
        expect(at(start, 'await probeShareSource(')).toBeLessThan(begin);
    });

    it('announces, and waits, before anything is torn down', () => {
        expect(begin).toBeLessThan(at(start, 'await stopNativeWindowAudio();\n            const tAudioStopped'));
        expect(begin).toBeLessThan(at(start, 'await localParticipant.unpublishTrack(ssPub.track, true)'));
        expect(start.slice(begin - 20, begin)).toContain('await');
    });

    it('takes the flag back on every way out of a republish', () => {
        const handler = conference.slice(at(conference, 'const handleScreenShareSelect = async'));
        const body = handler.slice(0, at(handler, 'A capture or publish error'));
        expect(body.indexOf('shareRepublishSignal.end(localParticipant, republishRun.seq, outcome)'))
            .toBeGreaterThan(at(body, '} finally {'));
    });

    it('a real stop takes any flag back before it unpublishes', () => {
        const toggle = conference.slice(at(conference, 'const toggleScreenshare = () =>'));
        expect(at(toggle, 'shareRepublishSignal.cancel(localParticipant)'))
            .toBeLessThan(at(toggle, 'localParticipant.setScreenShareEnabled(false)'));
        const keybind = conference.slice(at(conference, "'keybind:quick-screenshare'"));
        expect(at(keybind, 'shareRepublishSignal.cancel(localParticipant)'))
            .toBeLessThan(at(keybind, 'localParticipant.setScreenShareEnabled(false)'));
    });
});

describe('the viewer', () => {
    it('keeps a held share in the same list every share surface is built from', () => {
        const list = conference.slice(at(conference, 'const screenShareParticipants ='), at(conference, 'const activeScreenShareIds'));
        expect(list).toContain('heldShareIds.has(p.identity)');
    });

    it('registers the tracker after the cue listeners, which must see the state from before each event', () => {
        expect(at(pane, 'attachShareHoldToRoom(room')).toBeGreaterThan(at(pane, 'room.on(RoomEvent.TrackUnpublished, onTrackUnpublished)'));
        expect(at(pane, 'attachShareHoldToRoom(room')).toBeGreaterThan(at(pane, 'room.on(RoomEvent.TrackPublished,   onTrackPublished)'));
    });

    it('the focused view only stays put on a hold, and leaving the room still closes it first', () => {
        const eff = banner.slice(at(banner, 'const advance = () =>'));
        expect(at(eff, 'if (!focusedParticipantLive) {')).toBeLessThan(at(eff, "if (focusHold !== 'idle') return;"));
    });

    it('nothing on the viewer side schedules a wait on an unpublish', () => {
        // Holding is decided by state set before the unpublish. A timer here would be
        // exactly the delay on every real stop the owner ruled out.
        const src = readFileSync(join(__dirname, '..', '..', 'utils', 'shareHold.ts'), 'utf8');
        const onUnpublished = src.slice(at(src, 'const onUnpublished ='), at(src, 'const onPublished ='));
        expect(onUnpublished).not.toMatch(/setTimeout|queueMicrotask|setTimer/);
    });
});
