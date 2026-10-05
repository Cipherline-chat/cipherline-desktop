import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    annotationStore as store, trackKey, clock, LASER_TTL_MS, DENY_COOLDOWN_MS, selectCanAnnotate,
} from './annotationStore';
import {
    diffLocalForWire, applyRemote, SnapshotAssembler, applySnapshot, snapshotOf, remoteId, isAllowed,
    grantsOf, type SentState,
} from './annotationTransport';
import { chunkSnapshot, type AnnotMsg } from './annotationCodec';

const ROOM = 'r1';
const ME = 'alice';
const MY_SHARE = trackKey(ME, 'screen_share');
const BOB_CAM = trackKey('bob', 'camera');

beforeEach(() => store.reset());

describe('diffLocalForWire - what my drawing puts on the wire', () => {
    it('begin -> appends (batched) -> end, and nothing twice', () => {
        const sent: SentState = new Map();
        const s0 = store.getState();
        const id = store.beginStroke(MY_SHARE, ME, { x: 0.1, y: 0.1 })!;
        store.appendPoints(MY_SHARE, id, Array.from({ length: 70 }, (_, i) => ({ x: i / 100, y: 0.5 })));
        const s1 = store.getState();
        const m1 = diffLocalForWire(s0, s1, ME, ROOM, sent);
        expect(m1.map(m => m.t)).toEqual(['stroke.begin', 'stroke.append', 'stroke.append']);
        expect((m1[1] as Extract<AnnotMsg, { t: 'stroke.append' }>).pts).toHaveLength(64);
        expect((m1[2] as Extract<AnnotMsg, { t: 'stroke.append' }>).pts).toHaveLength(6);
        // idempotent
        expect(diffLocalForWire(s1, s1, ME, ROOM, sent)).toEqual([]);
        store.endStroke(MY_SHARE, id);
        const m2 = diffLocalForWire(s1, store.getState(), ME, ROOM, sent);
        expect(m2.map(m => m.t)).toEqual(['stroke.end']);
    });

    it('ignores strokes that are not mine', () => {
        const sent: SentState = new Map();
        const s0 = store.getState();
        store.beginStroke(BOB_CAM, 'bob', { x: 0, y: 0 });
        expect(diffLocalForWire(s0, store.getState(), ME, ROOM, sent)).toEqual([]);
    });

    it('a stroke that expires says nothing on the wire, and retires its send cursor', () => {
        const sent: SentState = new Map();
        const s0 = store.getState();
        const a = store.beginStroke(MY_SHARE, ME, { x: 0, y: 0 }, { id: 'a' })!;
        store.endStroke(MY_SHARE, a);
        const primed = store.getState();
        expect(diffLocalForWire(s0, primed, ME, ROOM, sent).map(m => m.t)).toEqual(['stroke.begin', 'stroke.end']);
        expect(sent.size).toBe(1);

        // Every peer runs the same TTL off the same last-point timestamp, so
        // an expiry is not news: nothing goes out, and the cursor is dropped
        // rather than left to accumulate for the length of the call.
        expect(store.expireLasers(Date.now() + LASER_TTL_MS + 1)).toBe(true);
        expect(diffLocalForWire(primed, store.getState(), ME, ROOM, sent)).toEqual([]);
        expect(sent.size).toBe(0);
    });
});

describe('applyRemote - owner draws; others only when granted', () => {
    const begin = (track: string, id = 'w1'): AnnotMsg =>
        ({ t: 'stroke.begin', room: ROOM, track, id, tool: 'laser', color: '#25E0C8', width: 4, p: { x: 0.2, y: 0.2 } });

    it('accepts the owner stroke, namespaced by sender, authored by the sender', () => {
        expect(applyRemote(begin(BOB_CAM), 'bob', ME).applied).toBe(true);
        const [s] = store.getState().strokes[BOB_CAM];
        expect(s.id).toBe(remoteId('bob', 'w1'));
        expect(s.by).toBe('bob');
    });

    it('refuses a stroke on someone else track until the owner grants it', () => {
        expect(applyRemote(begin(BOB_CAM), 'carol', ME).applied).toBe(false);
        expect(store.getState().strokes[BOB_CAM]).toBeUndefined();
        // the owner's list arrives naming carol
        expect(applyRemote({ t: 'grant.list', room: ROOM, track: BOB_CAM, identities: ['carol'] }, 'bob', ME).applied).toBe(true);
        expect(applyRemote(begin(BOB_CAM), 'carol', ME).applied).toBe(true);
        expect(store.getState().strokes[BOB_CAM][0].by).toBe('carol');
    });

    it('a grant list is only believed from the track owner', () => {
        expect(applyRemote({ t: 'grant.list', room: ROOM, track: BOB_CAM, identities: ['carol'] }, 'carol', ME).applied).toBe(false);
        expect(isAllowed(BOB_CAM, 'carol')).toBe(false);
    });

    it('grant.request reaches only the owner and queues the asker', () => {
        // I am alice; a request for MY share from bob is queued
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME).applied).toBe(true);
        expect(store.getState().requests[MY_SHARE]).toEqual(['bob']);
        // a request for bob's track is not my business
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: BOB_CAM }, 'carol', ME).applied).toBe(false);
    });

    it('my pending request clears when the owner grants me', () => {
        store.requestAccess(BOB_CAM);
        expect(store.getState().outgoing).toEqual([BOB_CAM]);
        applyRemote({ t: 'grant.grant', room: ROOM, track: BOB_CAM, identity: ME }, 'bob', ME);
        expect(store.getState().outgoing).toEqual([]);
    });

    it('refuses my own echo', () => {
        expect(applyRemote(begin(MY_SHARE), ME, ME).applied).toBe(false);
    });

    it('append/end act on the sender own namespaced stroke only', () => {
        applyRemote(begin(BOB_CAM), 'bob', ME);
        applyRemote({ t: 'stroke.append', room: ROOM, track: BOB_CAM, id: 'w1', pts: [{ x: 0.5, y: 0.5 }] }, 'bob', ME);
        applyRemote({ t: 'stroke.end', room: ROOM, track: BOB_CAM, id: 'w1' }, 'bob', ME);
        expect(store.getState().strokes[BOB_CAM][0]).toMatchObject({ id: remoteId('bob', 'w1') });
        expect(store.getState().strokes[BOB_CAM][0].closedAt).not.toBe(0); // their stroke.end closed it
        expect(store.getState().strokes[BOB_CAM][0].points).toHaveLength(2);
        // carol's append cannot reach it even knowing the wire id: hers would
        // be namespaced to her, and she is not allowed on bob's track at all.
        expect(applyRemote({ t: 'stroke.append', room: ROOM, track: BOB_CAM, id: 'w1', pts: [{ x: 0.9, y: 0.9 }] }, 'carol', ME).applied).toBe(false);
        expect(store.getState().strokes[BOB_CAM][0].points).toHaveLength(2);
    });

    it('isAllowed is exactly "sender owns the track"', () => {
        expect(isAllowed('bob|camera', 'bob')).toBe(true);
        expect(isAllowed('bob|camera', 'alice')).toBe(false);
    });
});

describe('being declined - the cooldown, end to end', () => {
    const T = 5_000_000;
    beforeEach(() => { clock.now = () => T; store.reset(); });
    afterEach(() => { clock.now = () => Date.now(); });

    it("the owner's no ends my request, starts my countdown, and holds until it runs out", () => {
        store.requestAccess(BOB_CAM);
        expect(store.getState().outgoing).toEqual([BOB_CAM]);

        expect(applyRemote({ t: 'grant.deny', room: ROOM, track: BOB_CAM, identity: ME }, 'bob', ME).applied).toBe(true);
        expect(store.getState().outgoing).toEqual([]);
        expect(store.getState().cooldownUntil[BOB_CAM]).toBe(T + DENY_COOLDOWN_MS);

        // Asking again inside the window does nothing at all - no state, so
        // nothing for the transport to turn into a second grant.request.
        clock.now = () => T + DENY_COOLDOWN_MS - 1;
        store.requestAccess(BOB_CAM);
        expect(store.getState().outgoing).toEqual([]);

        // ...and once it lapses, asking works again. That is the whole point:
        // a decline is a pause, not a door that stays shut for the call.
        clock.now = () => T + DENY_COOLDOWN_MS;
        expect(store.expireRequests()).toBe(true);
        store.requestAccess(BOB_CAM);
        expect(store.getState().outgoing).toEqual([BOB_CAM]);
    });

    it('a deny about someone else, or from someone who is not the owner, never cools me down', () => {
        store.requestAccess(BOB_CAM);
        // carol is not the owner of bob's camera - her "no" is not bob's.
        expect(applyRemote({ t: 'grant.deny', room: ROOM, track: BOB_CAM, identity: ME }, 'carol', ME).applied).toBe(false);
        // bob answering someone else says nothing about me.
        expect(applyRemote({ t: 'grant.deny', room: ROOM, track: BOB_CAM, identity: 'dave' }, 'bob', ME).applied).toBe(true);
        expect(store.getState().outgoing).toEqual([BOB_CAM]);
        expect(store.getState().cooldownUntil[BOB_CAM]).toBeUndefined();
    });

    it("the owner holds the same window themselves, so a patched asker gains nothing", () => {
        store.addRequest(MY_SHARE, 'bob');
        store.denyRequest(MY_SHARE, 'bob');
        expect(store.getState().requests[MY_SHARE]).toEqual([]);
        // A client that ignores its own cooldown still gets nowhere: the
        // request is refused where it lands, not where it is sent.
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME).applied).toBe(true);
        expect(store.getState().requests[MY_SHARE]).toEqual([]);
        clock.now = () => T + DENY_COOLDOWN_MS;
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME).applied).toBe(true);
        expect(store.getState().requests[MY_SHARE]).toEqual(['bob']);
    });
});

describe('snapshots - late joiners', () => {
    it('streamer builds a snapshot; a joiner reassembles chunks in any order and applies it', () => {
        // Streamer (bob) side: draw, then snapshot.
        for (let i = 0; i < 30; i++) {
            const id = store.beginStroke(BOB_CAM, 'bob', { x: 0, y: 0 }, { id: `b${i}` })!;
            store.appendPoints(BOB_CAM, id, Array.from({ length: 40 }, (_, j) => ({ x: j / 100, y: 0.3 })));
            store.endStroke(BOB_CAM, id);
        }
        const wire = snapshotOf(BOB_CAM);
        const parts = chunkSnapshot(ROOM, BOB_CAM, 3, wire, []);
        expect(parts.length).toBeGreaterThan(1);

        // Joiner side: fresh store, parts arrive shuffled.
        store.reset();
        const asm = new SnapshotAssembler();
        const shuffled = [...parts].reverse();
        let result: ReturnType<SnapshotAssembler['push']> = null;
        for (const p of shuffled) result = asm.push(p, 'bob') ?? result;
        expect(result).not.toBeNull();
        expect(result!.strokes).toHaveLength(30);
        expect(applySnapshot(BOB_CAM, 'bob', result!.strokes)).toBe(true);
        const applied = store.getState().strokes[BOB_CAM];
        expect(applied).toHaveLength(30);
        expect(applied[0].points).toHaveLength(41);
        expect(applied.every(s => s.closedAt !== 0 && s.by === 'bob')).toBe(true);
    });

    it('a snapshot from a non-owner is refused', () => {
        expect(applySnapshot(BOB_CAM, 'carol', [])).toBe(false);
    });

    it('a newer seq supersedes a partially received older one; stale parts are dropped', () => {
        const asm = new SnapshotAssembler();
        const mk = (seq: number, part: number, of: number) =>
            ({ t: 'snapshot' as const, room: ROOM, track: BOB_CAM, seq, part, of, strokes: [] });
        expect(asm.push(mk(1, 0, 2), 'bob')).toBeNull();
        expect(asm.push(mk(2, 0, 1), 'bob')).not.toBeNull(); // newer, complete
        expect(asm.push(mk(1, 1, 2), 'bob')).toBeNull();     // stale straggler
    });
});

describe('grants on the wire (streamer side)', () => {
    it('granting publishes grant.grant + grant.list; revoking publishes grant.revoke + grant.list', () => {
        const sent: SentState = new Map();
        let prev = store.getState();
        store.grant(MY_SHARE, 'bob');
        let next = store.getState();
        expect(diffLocalForWire(prev, next, ME, ROOM, sent)).toEqual([
            { t: 'grant.grant', room: ROOM, track: MY_SHARE, identity: 'bob' },
            { t: 'grant.list', room: ROOM, track: MY_SHARE, identities: ['bob'] },
        ]);
        prev = next;
        store.revoke(MY_SHARE, 'bob');
        next = store.getState();
        expect(diffLocalForWire(prev, next, ME, ROOM, sent)).toEqual([
            { t: 'grant.revoke', room: ROOM, track: MY_SHARE, identity: 'bob' },
            { t: 'grant.list', room: ROOM, track: MY_SHARE, identities: [] },
        ]);
    });

    it('a name right-click revoke publishes revoke+list for EVERY track I own', () => {
        const MY_CAM = trackKey(ME, 'camera');
        const sent: SentState = new Map();
        store.grant(MY_SHARE, 'bob');
        store.grant(MY_CAM, 'bob');
        store.setGrantList(BOB_CAM, ['carol']); // not mine - must stay untouched
        const prev = store.getState();
        expect(store.revokeAllFrom(ME, 'bob').sort()).toEqual([MY_CAM, MY_SHARE].sort());
        const msgs = diffLocalForWire(prev, store.getState(), ME, ROOM, sent);
        // Two tracks, each a revoke followed by its authoritative list; order
        // between tracks is not contractual, so compare as a set.
        expect(msgs).toHaveLength(4);
        for (const track of [MY_SHARE, MY_CAM]) {
            expect(msgs).toContainEqual({ t: 'grant.revoke', room: ROOM, track, identity: 'bob' });
            expect(msgs).toContainEqual({ t: 'grant.list', room: ROOM, track, identities: [] });
        }
        // Nothing was said about carol on bob's track.
        expect(msgs.some(m => m.track === BOB_CAM)).toBe(false);
        // And the revoked peer immediately fails the draw check.
        expect(isAllowed(MY_SHARE, 'bob')).toBe(false);
        expect(isAllowed(MY_CAM, 'bob')).toBe(false);
    });

    it('a mirrored list for someone else track is never re-published as mine', () => {
        const sent: SentState = new Map();
        const prev = store.getState();
        store.setGrantList(BOB_CAM, ['carol']);
        expect(diffLocalForWire(prev, store.getState(), ME, ROOM, sent)).toEqual([]);
    });

    it('asking for access publishes grant.request once', () => {
        const sent: SentState = new Map();
        const prev = store.getState();
        store.requestAccess(BOB_CAM);
        const next = store.getState();
        expect(diffLocalForWire(prev, next, ME, ROOM, sent)).toEqual([{ t: 'grant.request', room: ROOM, track: BOB_CAM }]);
        expect(diffLocalForWire(next, next, ME, ROOM, sent)).toEqual([]);
    });

    it('declining publishes exactly one grant.deny for that person, and never repeats it', () => {
        const sent: SentState = new Map();
        store.addRequest(MY_SHARE, 'bob');
        store.addRequest(MY_SHARE, 'carol');
        const prev = store.getState();
        store.denyRequest(MY_SHARE, 'bob');
        const next = store.getState();
        expect(diffLocalForWire(prev, next, ME, ROOM, sent)).toEqual([
            { t: 'grant.deny', room: ROOM, track: MY_SHARE, identity: 'bob' },
        ]);
        // Carol is untouched, and a second diff of the same state repeats nothing.
        expect(store.getState().requests[MY_SHARE]).toEqual(['carol']);
        expect(diffLocalForWire(next, next, ME, ROOM, sent)).toEqual([]);
    });

    it('a decline on a track I do not own is never published as mine', () => {
        const sent: SentState = new Map();
        const prev = store.getState();
        store.denyRequest(BOB_CAM, 'carol'); // not my surface to answer for
        expect(diffLocalForWire(prev, store.getState(), ME, ROOM, sent)).toEqual([]);
    });

    it('a snapshot carries the owner grant list and the joiner mirrors it', () => {
        expect(applySnapshot(BOB_CAM, 'bob', [], ['carol'])).toBe(true);
        expect(isAllowed(BOB_CAM, 'carol')).toBe(true);
        expect(isAllowed(BOB_CAM, 'dave')).toBe(false);
    });
});

describe('a track that ends takes its grants with it, out loud (regression)', () => {
    it('dropping a track I own publishes grant.revoke + an empty grant.list', () => {
        // The bug: useAnnotationTransport dropped the track inside its
        // `silently` wrapper, so the grants were cleared LOCALLY and nowhere
        // else. A grant list is believed only from its owner, so every peer
        // kept the last list we published - the grantee still thought it could
        // draw, and everyone still rendered the pencil badge beside their name.
        const sent: SentState = new Map();
        store.grant(MY_SHARE, 'bob');
        store.grant(MY_SHARE, 'carol');
        const prev = store.getState();
        store.dropTrack(MY_SHARE);
        const msgs = diffLocalForWire(prev, store.getState(), ME, ROOM, sent);
        expect(msgs).toContainEqual({ t: 'grant.revoke', room: ROOM, track: MY_SHARE, identity: 'bob' });
        expect(msgs).toContainEqual({ t: 'grant.revoke', room: ROOM, track: MY_SHARE, identity: 'carol' });
        expect(msgs).toContainEqual({ t: 'grant.list', room: ROOM, track: MY_SHARE, identities: [] });
    });

    it('a receiver applying that list drops the grant and the badge', () => {
        // The peer half of the same exchange - this is what actually clears
        // the pencil on everyone else's screen.
        applyRemote({ t: 'grant.list', room: ROOM, track: BOB_CAM, identities: ['alice'] }, 'bob', ME);
        expect(isAllowed(BOB_CAM, 'alice')).toBe(true);
        expect(selectCanAnnotate('alice')(store.getState())).toBe(true);
        applyRemote({ t: 'grant.list', room: ROOM, track: BOB_CAM, identities: [] }, 'bob', ME);
        expect(isAllowed(BOB_CAM, 'alice')).toBe(false);
        expect(selectCanAnnotate('alice')(store.getState())).toBe(false);
    });

    it('a re-share under the same key starts with no grants - a fresh ask is required', () => {
        store.grant(MY_SHARE, 'bob');
        store.dropTrack(MY_SHARE);
        expect(isAllowed(MY_SHARE, 'bob')).toBe(false);
        // Share again: same identity|source key. The list we would hand a late
        // joiner is empty, so nothing inherits the old grant.
        store.setOwnedSurfaces([MY_SHARE]);
        store.beginStroke(MY_SHARE, ME, { x: 0, y: 0 });
        expect(grantsOf(MY_SHARE)).toEqual([]);
        expect(isAllowed(MY_SHARE, 'bob')).toBe(false);
        // ...and bob asking is a brand-new request, not a resumed grant.
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME))
            .toEqual({ applied: true, queuedRequest: true });
    });
});

describe('grant.request tells the caller whether anyone is actually waiting', () => {
    it('is queued (and so worth a sound) only for a new asker', () => {
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME))
            .toEqual({ applied: true, queuedRequest: true });
        // A repeat of an ask already on the list rings nothing.
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME))
            .toEqual({ applied: true, queuedRequest: false });
    });

    it('stays silent for someone already granted', () => {
        store.grant(MY_SHARE, 'bob');
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME))
            .toEqual({ applied: true, queuedRequest: false });
    });

    it('stays silent inside a decline cooldown - a "no" cannot be turned into a doorbell', () => {
        const T = 5_000_000;
        clock.now = () => T;
        store.addRequest(MY_SHARE, 'bob');
        store.denyRequest(MY_SHARE, 'bob');
        clock.now = () => T + DENY_COOLDOWN_MS - 1;
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME))
            .toEqual({ applied: true, queuedRequest: false });
        clock.now = () => T + DENY_COOLDOWN_MS;
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: MY_SHARE }, 'bob', ME))
            .toEqual({ applied: true, queuedRequest: true });
        clock.now = () => Date.now();
    });

    it('a request for a track I do not own is not mine to queue or ring for', () => {
        expect(applyRemote({ t: 'grant.request', room: ROOM, track: BOB_CAM }, 'carol', ME))
            .toEqual({ applied: false, reason: 'not my track' });
    });
});

describe('the send cursor counts absolutely, so a faded tail is not a rewind', () => {
    afterEach(() => { clock.now = () => Date.now(); });

    it('sends each point exactly once across a long, continuously trimmed stroke', () => {
        const T = 6_000_000;
        clock.now = () => T;
        const sent: SentState = new Map();
        let prev = store.getState();
        const id = store.beginStroke(MY_SHARE, ME, { x: 0, y: 0 }, { id: 'long' })!;
        const seen: number[] = [];
        const drain = () => {
            const msgs = diffLocalForWire(prev, store.getState(), ME, ROOM, sent);
            prev = store.getState();
            for (const m of msgs) {
                if (m.t === 'stroke.begin') seen.push(m.p.x);
                if (m.t === 'stroke.append') for (const p of m.pts) seen.push(p.x);
            }
        };
        drain();
        // 10 seconds of drawing at 100ms, with expiry running the whole time.
        for (let i = 1; i <= 100; i++) {
            const t = T + i * 100;
            clock.now = () => t;
            store.appendPoints(MY_SHARE, id, [{ x: i / 1000, y: 0.5 }]);
            store.expireLasers(t);
            drain();
        }
        // Every point went out once and only once, in order - no duplicates
        // from a "rewind" misread, and no gaps from the trimming.
        expect(seen).toEqual([0, ...Array.from({ length: 100 }, (_, i) => (i + 1) / 1000)]);
        expect(new Set(seen).size).toBe(seen.length);
    });
});

/**
 * The whole chain a stroke travels once someone OTHER than the streamer draws
 * on it — which is the only way anyone ever draws, since a tile's owner is
 * deliberately never allowed to draw on their own (VideoTile's annotGranted).
 *
 * Every outbound test above draws on `MY_SHARE`, a track the drawer owns. That
 * is the one case the real feature never exercises, so this walks the case it
 * always does: grantee draws -> the diff puts it on the wire -> the streamer
 * applies it -> a third participant applies it too. Once for a SCREEN SHARE
 * and once for a CAMERA, because the two are separate surfaces (different
 * trackKey source, different object-fit, different publish/mute lifecycles)
 * and "it works for screen share" has never implied the other.
 *
 * The last link this can reach is the receiver's STORE. What happens after —
 * AnnotationOverlay's rAF loop painting `strokes[trackKey]` onto the canvas —
 * is DOM, and is covered structurally by annotationHitTest.test.ts and
 * annotationOverlayContract.test.ts instead.
 */
describe('a grantee draws on the streamer tile: sender -> wire -> every receiver', () => {
    const OWNER = 'alice', DRAWER = 'bob', BYSTANDER = 'carol';

    /** Replay one participant's view of the call from a clean store. */
    const asParticipant = <T>(fn: () => T): T => { store.reset(); return fn(); };

    for (const source of ['screen_share', 'camera'] as const) {
        it(`carries a stroke on the owner's ${source} to the owner and to a bystander`, () => {
            const TRACK = trackKey(OWNER, source);
            const points = [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.35 }, { x: 0.6, y: 0.5 }];

            // ── the DRAWER's client ──────────────────────────────────────
            const wire = asParticipant(() => {
                // The owner's published list, mirrored the way the real
                // client mirrors it — believed because it came from the owner.
                applyRemote({ t: 'grant.list', room: ROOM, track: TRACK, identities: [DRAWER] }, OWNER, DRAWER);
                const sent: SentState = new Map();
                const before = store.getState();
                const id = store.beginStroke(TRACK, DRAWER, points[0], { id: 'g1', color: '#25E0C8', width: 4 })!;
                expect(id, 'the drawer could not even start a stroke locally').toBeTruthy();
                store.appendPoints(TRACK, id, points.slice(1));
                store.endStroke(TRACK, id);
                return diffLocalForWire(before, store.getState(), DRAWER, ROOM, sent);
            });
            expect(wire.map(m => m.t), 'the drawer published nothing for a track they were granted on')
                .toEqual(['stroke.begin', 'stroke.append', 'stroke.end']);

            // ── the OWNER's client ───────────────────────────────────────
            const onOwner = asParticipant(() => {
                store.setGrantList(TRACK, [DRAWER]); // the list the owner itself holds
                for (const m of wire) expect(applyRemote(m, DRAWER, OWNER).applied, `owner refused ${m.t}`).toBe(true);
                return store.getState().strokes[TRACK] ?? [];
            });
            expect(onOwner).toHaveLength(1);
            expect(onOwner[0].by, 'authorship must come from the attested sender, not the payload').toBe(DRAWER);
            expect(onOwner[0].points).toEqual(points);
            expect(onOwner[0].closedAt, 'the stroke should be fading, not stuck live').not.toBe(0);

            // ── a BYSTANDER's client ─────────────────────────────────────
            const onBystander = asParticipant(() => {
                applyRemote({ t: 'grant.list', room: ROOM, track: TRACK, identities: [DRAWER] }, OWNER, BYSTANDER);
                for (const m of wire) expect(applyRemote(m, DRAWER, BYSTANDER).applied, `bystander refused ${m.t}`).toBe(true);
                return store.getState().strokes[TRACK] ?? [];
            });
            expect(onBystander).toHaveLength(1);
            expect(onBystander[0].points).toEqual(points);

            // ── and the same packets from someone with no grant ──────────
            // The authorization rule is per-sender, not per-packet-shape.
            const onStranger = asParticipant(() => {
                applyRemote({ t: 'grant.list', room: ROOM, track: TRACK, identities: [DRAWER] }, OWNER, BYSTANDER);
                for (const m of wire) expect(applyRemote(m, 'mallory', BYSTANDER).applied).toBe(false);
                return store.getState().strokes[TRACK] ?? [];
            });
            expect(onStranger, 'an ungranted peer got a stroke through').toHaveLength(0);
        });
    }
});
