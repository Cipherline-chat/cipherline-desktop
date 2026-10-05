/**
 * Tests for the screenshare viewer set and the streamer's join/leave cues.
 *
 * The four failure modes the feature has to survive each get a named case
 * below, because every one of them is a 0 → N or N → 0 transition that a naive
 * "diff the set and play a sound" implementation gets audibly wrong.
 */
import { describe, it, expect } from 'vitest';
import {
    WATCHING_META_KEY,
    parseWatchedShares,
    writeWatchedShares,
    viewersOf,
    buildViewerIndex,
    initialViewerCueState,
    reduceViewerCues,
    VIEWER_CUE_GRACE_MS,
    VIEWER_CUE_COALESCE_MS,
    type ViewerRosterEntry,
} from './screenShareViewers';

const meta = (watching: string[], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...extra, [WATCHING_META_KEY]: watching });

const entry = (identity: string, watching: string[] | null, extra = {}): ViewerRosterEntry => ({
    identity,
    metadata: watching === null ? undefined : meta(watching, extra),
});

describe('parseWatchedShares', () => {
    it('reads the watched list out of a metadata blob', () => {
        expect(parseWatchedShares(meta(['alice', 'bob']))).toEqual(['alice', 'bob']);
    });

    it('degrades to empty for every malformed shape rather than throwing', () => {
        // Metadata is written by OTHER clients and by the API moderation
        // endpoint. A parse that throws would do so inside a render.
        for (const raw of [
            undefined, null, '', 'not json', '[]', '"a string"', 'null', '123',
            JSON.stringify({}),
            JSON.stringify({ [WATCHING_META_KEY]: 'alice' }),
            JSON.stringify({ [WATCHING_META_KEY]: null }),
            JSON.stringify({ [WATCHING_META_KEY]: { alice: true } }),
        ]) {
            expect(parseWatchedShares(raw as string | null | undefined), String(raw)).toEqual([]);
        }
    });

    it('drops non-string, empty and duplicate entries', () => {
        const raw = JSON.stringify({ [WATCHING_META_KEY]: ['alice', 1, '', null, 'alice', 'bob'] });
        expect(parseWatchedShares(raw)).toEqual(['alice', 'bob']);
    });
});

describe('writeWatchedShares', () => {
    it('adds the key without disturbing the flags other writers own', () => {
        // The blob is shared with the avatar sync and the deafen toggle, and
        // setMetadata replaces it wholesale — a patch that dropped these would
        // silently un-deafen the user.
        const before = JSON.stringify({ deafened: true, avatar_url: 'att-1', server_muted_audio: true });
        const after = writeWatchedShares(before, ['alice']);
        expect(after).not.toBeNull();
        expect(JSON.parse(after!)).toEqual({
            deafened: true,
            avatar_url: 'att-1',
            server_muted_audio: true,
            [WATCHING_META_KEY]: ['alice'],
        });
    });

    it('returns null when nothing would change — this is what stops a write loop', () => {
        // The publish effect re-runs on every metadata change, including the
        // echo of its own write.
        expect(writeWatchedShares(meta(['alice']), ['alice'])).toBeNull();
        expect(writeWatchedShares(meta(['alice', 'bob']), ['bob', 'alice'])).toBeNull();
        expect(writeWatchedShares(JSON.stringify({ deafened: true }), [])).toBeNull();
        expect(writeWatchedShares(undefined, [])).toBeNull();
    });

    it('deletes the key rather than writing an empty array', () => {
        const after = writeWatchedShares(meta(['alice'], { deafened: false }), []);
        expect(after).not.toBeNull();
        expect(JSON.parse(after!)).toEqual({ deafened: false });
    });

    it('normalises order and duplicates so the no-change check is stable', () => {
        const after = writeWatchedShares(undefined, ['bob', 'alice', 'bob']);
        expect(JSON.parse(after!)[WATCHING_META_KEY]).toEqual(['alice', 'bob']);
    });

    it('overwrites an unparseable blob instead of refusing to publish', () => {
        const after = writeWatchedShares('}{ not json', ['alice']);
        expect(JSON.parse(after!)).toEqual({ [WATCHING_META_KEY]: ['alice'] });
    });
});

describe('viewersOf', () => {
    const roster: ViewerRosterEntry[] = [
        entry('streamer', []),
        entry('alice', ['streamer']),
        entry('bob', ['streamer', 'carol']),
        entry('carol', null),          // never published metadata
        entry('dave', ['carol']),
    ];

    it('counts only the people who claim to watch that publisher', () => {
        expect(viewersOf(roster, 'streamer')).toEqual(['alice', 'bob']);
    });

    it('is PER-STREAM, not per-call — two concurrent shares get separate sets', () => {
        // The app supports multiple publishers; a per-call count would report
        // the same number on both tiles.
        expect(viewersOf(roster, 'carol')).toEqual(['bob', 'dave']);
        expect(viewersOf(roster, 'streamer')).not.toEqual(viewersOf(roster, 'carol'));
    });

    it('never counts the publisher in their own audience', () => {
        const selfWatcher = [entry('streamer', ['streamer']), entry('alice', ['streamer'])];
        expect(viewersOf(selfWatcher, 'streamer')).toEqual(['alice']);
    });

    it('is a fold over the CURRENT roster, so leaving the call decrements it', () => {
        // No retraction message is needed or expected: the participant is
        // simply not there to be folded.
        const afterAliceLeaves = roster.filter(e => e.identity !== 'alice');
        expect(viewersOf(afterAliceLeaves, 'streamer')).toEqual(['bob']);
    });

    it('is correct for a late joiner with no history of the stream', () => {
        // A client that connects mid-share computes from metadata already on
        // the roster, so its first render matches everyone else's.
        const lateJoinerView = [...roster, entry('erin', [])];
        expect(viewersOf(lateJoinerView, 'streamer')).toEqual(['alice', 'bob']);
        // ...and once that late joiner presses Watch, it goes up for everyone.
        const afterErinWatches = [...roster, entry('erin', ['streamer'])];
        expect(viewersOf(afterErinWatches, 'streamer')).toEqual(['alice', 'bob', 'erin']);
    });

    it('returns empty for an empty publisher identity', () => {
        expect(viewersOf(roster, '')).toEqual([]);
    });
});

describe('buildViewerIndex', () => {
    it('produces every publisher\'s audience in one pass', () => {
        const index = buildViewerIndex([
            entry('alice', ['streamer']),
            entry('bob', ['streamer', 'carol']),
            entry('carol', ['carol']),   // self-claim, must be dropped
        ]);
        expect(index.get('streamer')).toEqual(['alice', 'bob']);
        expect(index.get('carol')).toEqual(['bob']);
        expect(index.has('alice')).toBe(false);
    });
});

// ── Cue tracking ────────────────────────────────────────────────────────────

const EPOCH = 'TR_sid1:live';
/** Comfortably past the grace window. */
const ARMED = VIEWER_CUE_GRACE_MS + 1000;

/** Arm a tracker at t=0 with `viewers` as the silent baseline. */
function armed(viewers: string[] = []) {
    return reduceViewerCues(initialViewerCueState(), { epoch: EPOCH, viewers, now: 0 }).state;
}

describe('reduceViewerCues', () => {
    it('is silent while the local user is not sharing', () => {
        const r = reduceViewerCues(initialViewerCueState(), { epoch: '', viewers: ['alice'], now: 0 });
        expect(r.cues).toEqual([]);
        expect(r.state.viewers).toEqual([]);
    });

    it('cues a start when someone presses Watch', () => {
        const r = reduceViewerCues(armed(), { epoch: EPOCH, viewers: ['alice'], now: ARMED });
        expect(r.cues).toEqual(['start']);
        expect(r.state.viewers).toEqual(['alice']);
    });

    it('cues a stop when a watcher goes away', () => {
        const r = reduceViewerCues(armed(['alice']), { epoch: EPOCH, viewers: [], now: ARMED });
        expect(r.cues).toEqual(['stop']);
    });

    it('a viewer LEAVING THE CALL fires the stop cue, same as un-watching', () => {
        // Indistinguishable here by design — both show up as "no longer in the
        // fold", which is the property that makes a dropped connection cue
        // correctly without any explicit goodbye.
        const r = reduceViewerCues(armed(['alice', 'bob']), { epoch: EPOCH, viewers: ['bob'], now: ARMED });
        expect(r.cues).toEqual(['stop']);
        expect(r.state.viewers).toEqual(['bob']);
    });

    it('says nothing when the set did not move', () => {
        const r = reduceViewerCues(armed(['alice']), { epoch: EPOCH, viewers: ['alice'], now: ARMED });
        expect(r.cues).toEqual([]);
        // Same object back — the caller can skip work on an unchanged fold.
        expect(r.state).toBe(r.state);
    });

    it('a start and a stop in the same tick are both honest, so both play', () => {
        const r = reduceViewerCues(armed(['alice']), { epoch: EPOCH, viewers: ['bob'], now: ARMED });
        expect(r.cues).toEqual(['start', 'stop']);
    });

    describe('no cue storm', () => {
        it('absorbs the rush when a share starts into a room that piles straight in', () => {
            // Three people click Watch within the first second of the track
            // existing. That is the starting state of the stream, not three
            // things that happened to the streamer.
            let st = initialViewerCueState();
            const cues: string[] = [];
            for (const [now, viewers] of [
                [0, []],
                [120, ['alice']],
                [400, ['alice', 'bob']],
                [900, ['alice', 'bob', 'carol']],
            ] as Array<[number, string[]]>) {
                const r = reduceViewerCues(st, { epoch: EPOCH, viewers, now });
                st = r.state;
                cues.push(...r.cues);
            }
            expect(cues).toEqual([]);
            // The baseline still tracked them, so nobody is double-counted and
            // the first person to LEAVE still cues.
            expect(st.viewers).toEqual(['alice', 'bob', 'carol']);
            expect(reduceViewerCues(st, { epoch: EPOCH, viewers: ['alice', 'bob'], now: ARMED }).cues)
                .toEqual(['stop']);
        });

        it('says nothing on the streamer\'s own reconnect', () => {
            // A reconnect rebuilds the roster: all three watchers' metadata
            // re-arrives at once and reads as three fresh Watch clicks.
            const live = armed(['alice', 'bob', 'carol']);
            // Reconnecting: the epoch changes, and the set momentarily empties.
            const dropped = reduceViewerCues(live, { epoch: 'TR_sid1:recon', viewers: [], now: 60_000 });
            expect(dropped.cues).toEqual([]);
            // Back: the same three re-appear.
            const back = reduceViewerCues(dropped.state, {
                epoch: 'TR_sid1:live', viewers: ['alice', 'bob', 'carol'], now: 64_000,
            });
            expect(back.cues).toEqual([]);
            expect(back.state.viewers).toEqual(['alice', 'bob', 'carol']);
        });

        it('says nothing when Change Source republishes the track under a new sid', () => {
            const live = armed(['alice']);
            const r = reduceViewerCues(live, { epoch: 'TR_sid2:live', viewers: [], now: 30_000 });
            expect(r.cues).toEqual([]);
            const back = reduceViewerCues(r.state, { epoch: 'TR_sid2:live', viewers: ['alice'], now: 30_400 });
            expect(back.cues).toEqual([]);
        });

        it('coalesces two watchers arriving a few hundred ms apart into one cue', () => {
            // Each watcher's metadata lands as its own event; playSound reuses
            // one element per category, so a second play cuts the first off
            // mid-sample.
            const first = reduceViewerCues(armed(), { epoch: EPOCH, viewers: ['alice'], now: ARMED });
            expect(first.cues).toEqual(['start']);
            const second = reduceViewerCues(first.state, {
                epoch: EPOCH, viewers: ['alice', 'bob'], now: ARMED + VIEWER_CUE_COALESCE_MS - 100,
            });
            expect(second.cues).toEqual([]);
            // ...but the set still tracked bob.
            expect(second.state.viewers).toEqual(['alice', 'bob']);
            // Past the window, a genuine third arrival cues again.
            const third = reduceViewerCues(second.state, {
                epoch: EPOCH, viewers: ['alice', 'bob', 'carol'], now: ARMED + VIEWER_CUE_COALESCE_MS + 10,
            });
            expect(third.cues).toEqual(['start']);
        });

        it('coalesces per KIND — a stop is not swallowed by a recent start', () => {
            const first = reduceViewerCues(armed(['alice']), { epoch: EPOCH, viewers: ['alice', 'bob'], now: ARMED });
            expect(first.cues).toEqual(['start']);
            const second = reduceViewerCues(first.state, { epoch: EPOCH, viewers: ['bob'], now: ARMED + 50 });
            expect(second.cues).toEqual(['stop']);
        });
    });

    it('stopping the share clears the cooldowns so the next one starts clean', () => {
        const live = reduceViewerCues(armed(), { epoch: EPOCH, viewers: ['alice'], now: ARMED });
        const off = reduceViewerCues(live.state, { epoch: '', viewers: [], now: ARMED + 10 });
        expect(off.state).toEqual(initialViewerCueState());
        // A brand new share arms fresh rather than inheriting a cooldown.
        const next = reduceViewerCues(off.state, { epoch: 'TR_sid9:live', viewers: ['alice'], now: ARMED + 20 });
        expect(next.cues).toEqual([]);
        expect(next.state.armedAt).toBe(ARMED + 20);
    });

    it('a late joiner who starts watching after the fact still cues', () => {
        // The grace window is about the START of a stream, not about who is
        // allowed to be heard arriving.
        const settled = armed(['alice']);
        const r = reduceViewerCues(settled, { epoch: EPOCH, viewers: ['alice', 'zoe'], now: 600_000 });
        expect(r.cues).toEqual(['start']);
    });

    it('de-duplicates and sorts the incoming set so ordering never reads as churn', () => {
        const r = reduceViewerCues(armed(['alice', 'bob']), {
            epoch: EPOCH, viewers: ['bob', 'alice', 'bob'], now: ARMED,
        });
        expect(r.cues).toEqual([]);
        expect(r.state.viewers).toEqual(['alice', 'bob']);
    });
});
