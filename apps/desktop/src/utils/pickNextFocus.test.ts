import { describe, it, expect } from 'vitest';
import { Track } from 'livekit-client';
import {
    pickNextFocus,
    collectFocusCandidates,
    isStreamLive,
    PublishOrder,
    focusKey,
    type FocusCandidate,
    type ParticipantLike,
    type PublicationLike,
} from './pickNextFocus';

const CAM = Track.Source.Camera;
const SS = Track.Source.ScreenShare;

/** Build a candidate without repeating the boilerplate at every call site. */
const cand = (
    identity: string,
    source: typeof CAM | typeof SS,
    publishedAt: number,
    isLocal = false,
): FocusCandidate => ({ identity, source, publishedAt, isLocal });

/** A fake participant whose publications are described declaratively. */
function participant(
    identity: string,
    pubs: Partial<Record<typeof CAM | typeof SS, PublicationLike | undefined>>,
    opts: { isLocal?: boolean; isCameraEnabled?: boolean } = {},
): ParticipantLike {
    return {
        identity,
        isLocal: opts.isLocal ?? false,
        isCameraEnabled: opts.isCameraEnabled,
        getTrackPublication: (source) => pubs[source],
    };
}

const livePub: PublicationLike = { isMuted: false, track: {} };
const mutedPub: PublicationLike = { isMuted: true, track: {} };
const tracklessPub: PublicationLike = { isMuted: false };

describe('pickNextFocus', () => {
    it('returns null when nothing else is publishing — focus closes, chat comes back', () => {
        expect(pickNextFocus([], { identity: 'alice', source: SS })).toBeNull();
    });

    it('never re-picks the stream that just ended', () => {
        const losing = { identity: 'alice', source: SS } as const;
        // The room ledger can still list it for a frame after the unpublish.
        expect(pickNextFocus([cand('alice', SS, 1)], losing)).toBeNull();
    });

    it('focuses the one other video member when there is exactly one', () => {
        const next = pickNextFocus(
            [cand('alice', SS, 1), cand('bob', CAM, 2)],
            { identity: 'alice', source: SS },
        );
        expect(next).toMatchObject({ identity: 'bob', source: CAM });
    });

    it('prefers a screen share over a camera even when the camera is newer', () => {
        const next = pickNextFocus(
            [cand('bob', CAM, 99), cand('carol', SS, 2)],
            { identity: 'alice', source: SS },
        );
        expect(next).toMatchObject({ identity: 'carol', source: SS });
    });

    it('within one tier, takes the most recently published', () => {
        const next = pickNextFocus(
            [cand('bob', CAM, 3), cand('carol', CAM, 7), cand('dave', CAM, 5)],
            { identity: 'alice', source: CAM },
        );
        expect(next).toMatchObject({ identity: 'carol' });
    });

    it('prefers the newest screen share when several people are sharing', () => {
        const next = pickNextFocus(
            [cand('bob', SS, 4), cand('carol', SS, 9), cand('dave', CAM, 20)],
            { identity: 'alice', source: SS },
        );
        expect(next).toMatchObject({ identity: 'carol', source: SS });
    });

    it('breaks ties on identity so the choice is deterministic', () => {
        const forwards = pickNextFocus([cand('zoe', CAM, 4), cand('bob', CAM, 4)], null);
        const backwards = pickNextFocus([cand('bob', CAM, 4), cand('zoe', CAM, 4)], null);
        expect(forwards).toMatchObject({ identity: 'bob' });
        expect(backwards).toMatchObject({ identity: 'bob' });
    });

    it('ignores the local user\'s own streams — your own preview is not "another video member"', () => {
        const next = pickNextFocus(
            [cand('me', CAM, 10, true), cand('me', SS, 11, true)],
            { identity: 'alice', source: SS },
        );
        expect(next).toBeNull();
    });

    it('picks a remote camera over the local screen share', () => {
        const next = pickNextFocus(
            [cand('me', SS, 10, true), cand('bob', CAM, 2)],
            { identity: 'alice', source: SS },
        );
        expect(next).toMatchObject({ identity: 'bob', source: CAM });
    });

    it('handles the local user ending their own share: hands over to a remote', () => {
        const next = pickNextFocus(
            [cand('me', CAM, 8, true), cand('bob', SS, 3)],
            { identity: 'me', source: SS },
        );
        expect(next).toMatchObject({ identity: 'bob', source: SS });
    });

    it('handles the local user ending their own share with nobody else on video', () => {
        const next = pickNextFocus(
            [cand('me', CAM, 8, true)],
            { identity: 'me', source: SS },
        );
        expect(next).toBeNull();
    });

    it('can pick a different source from the same participant', () => {
        // Bob stops sharing his screen but still has his camera on.
        const next = pickNextFocus(
            [cand('bob', CAM, 5)],
            { identity: 'bob', source: SS },
        );
        expect(next).toMatchObject({ identity: 'bob', source: CAM });
    });

    it('accepts a null losing stream (nothing was focused)', () => {
        expect(pickNextFocus([cand('bob', CAM, 1)], null)).toMatchObject({ identity: 'bob' });
    });
});

describe('isStreamLive', () => {
    it('is false with no publication', () => {
        expect(isStreamLive(participant('bob', {}), CAM)).toBe(false);
    });

    it('is true for a published, unmuted track', () => {
        expect(isStreamLive(participant('bob', { [CAM]: livePub }), CAM)).toBe(true);
    });

    it('treats a muted camera as gone — this is "they turned their video off"', () => {
        expect(isStreamLive(participant('bob', { [CAM]: mutedPub }), CAM)).toBe(false);
    });

    it('treats a muted screen share as gone', () => {
        expect(isStreamLive(participant('bob', { [SS]: mutedPub }), SS)).toBe(false);
    });

    it('keeps a trackless camera alive while the participant still reports it enabled', () => {
        // The hole during a camera device switch — tearing focus down here
        // would be a pointless flicker.
        const p = participant('bob', { [CAM]: tracklessPub }, { isCameraEnabled: true });
        expect(isStreamLive(p, CAM)).toBe(true);
    });

    it('drops a trackless camera once the participant reports it disabled', () => {
        const p = participant('bob', { [CAM]: tracklessPub }, { isCameraEnabled: false });
        expect(isStreamLive(p, CAM)).toBe(false);
    });

    it('gives a trackless screen share no such grace', () => {
        const p = participant('bob', { [SS]: tracklessPub }, { isCameraEnabled: true });
        expect(isStreamLive(p, SS)).toBe(false);
    });
});

describe('PublishOrder', () => {
    it('assigns increasing sequences in the order streams are first seen', () => {
        const order = new PublishOrder();
        order.observe(['a']);
        order.observe(['a', 'b']);
        expect(order.get('a')).toBeLessThan(order.get('b'));
    });

    it('is stable for a stream that stays live', () => {
        const order = new PublishOrder();
        order.observe(['a']);
        const first = order.get('a');
        order.observe(['a', 'b']);
        order.observe(['a', 'b', 'c']);
        expect(order.get('a')).toBe(first);
    });

    it('forgets a stream that ends, so a re-publish reads as new', () => {
        const order = new PublishOrder();
        order.observe(['a', 'b']);
        const bBefore = order.get('b');
        order.observe(['b']);          // a ends
        order.observe(['a', 'b']);     // a comes back
        expect(order.get('a')).toBeGreaterThan(bBefore);
    });

    it('reports 0 for a stream it has never seen', () => {
        expect(new PublishOrder().get('nope')).toBe(0);
    });
});

describe('collectFocusCandidates', () => {
    const order = () => new PublishOrder();

    it('collects every live publication across the room', () => {
        const cands = collectFocusCandidates([
            participant('bob', { [CAM]: livePub, [SS]: livePub }),
            participant('carol', { [CAM]: livePub }),
        ], order());
        expect(cands.map(c => focusKey(c.identity, c.source)).sort()).toEqual([
            focusKey('bob', CAM),
            focusKey('bob', SS),
            focusKey('carol', CAM),
        ].sort());
    });

    it('skips dead publications', () => {
        const cands = collectFocusCandidates([
            participant('bob', { [CAM]: mutedPub }),
            participant('carol', {}),
        ], order());
        expect(cands).toEqual([]);
    });

    it('marks the local participant', () => {
        const cands = collectFocusCandidates([
            participant('me', { [CAM]: livePub }, { isLocal: true }),
        ], order());
        expect(cands[0].isLocal).toBe(true);
    });

    it('excludes streams the viewer has hidden', () => {
        const cands = collectFocusCandidates([
            participant('bob', { [CAM]: livePub }),
            participant('carol', { [SS]: livePub }),
        ], order(), { video: new Set(['bob']), screenShare: new Set(['carol']) });
        expect(cands).toEqual([]);
    });

    it('still ledgers a hidden stream, so un-hiding does not make it look brand new', () => {
        const o = order();
        const room = [
            participant('bob', { [CAM]: livePub }),
            participant('carol', { [CAM]: livePub }),
        ];
        collectFocusCandidates(room, o, { video: new Set(['bob']), screenShare: new Set() });
        const bobSeq = o.get(focusKey('bob', CAM));
        const carolSeq = o.get(focusKey('carol', CAM));
        expect(bobSeq).toBeGreaterThan(0);
        expect(bobSeq).toBeLessThan(carolSeq);
    });

    it('feeds pickNextFocus end to end: share stops, newest remaining camera wins', () => {
        const o = order();
        const withShare = [
            participant('me', { [CAM]: livePub }, { isLocal: true }),
            participant('alice', { [SS]: livePub }),
            participant('bob', { [CAM]: livePub }),
        ];
        collectFocusCandidates(withShare, o);
        // Carol turns her camera on after everyone else.
        const withCarol = [...withShare, participant('carol', { [CAM]: livePub })];
        collectFocusCandidates(withCarol, o);
        // Alice stops sharing.
        const afterShareEnds = [
            participant('me', { [CAM]: livePub }, { isLocal: true }),
            participant('alice', {}),
            participant('bob', { [CAM]: livePub }),
            participant('carol', { [CAM]: livePub }),
        ];
        const cands = collectFocusCandidates(afterShareEnds, o);
        const next = pickNextFocus(cands, { identity: 'alice', source: SS });
        expect(next).toMatchObject({ identity: 'carol', source: CAM });
    });

    it('feeds pickNextFocus end to end: last video ends, focus closes', () => {
        const o = order();
        collectFocusCandidates([
            participant('me', { [CAM]: livePub }, { isLocal: true }),
            participant('alice', { [SS]: livePub }),
        ], o);
        const cands = collectFocusCandidates([
            participant('me', { [CAM]: livePub }, { isLocal: true }),
            participant('alice', {}),
        ], o);
        expect(pickNextFocus(cands, { identity: 'alice', source: SS })).toBeNull();
    });
});
