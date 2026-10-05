import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    annotationStore as store, trackKey, LASER_TTL_MS, MAX_STROKES_PER_TRACK, MAX_POINTS_PER_STROKE, PALETTE, MAX_GRANTS,
    isGranted, selectTrackGrants, selectTrackRequests, clock, REQUEST_TTL_MS,
    ownedGrantTracks, selectCanAnnotate, selectCanRevoke,
    DENY_COOLDOWN_MS, cooldownLeft, selectCooldownUntil,
    selectCanGrantAnnotation, selectGrantTarget, isScreenShareTrack, strokeAlpha, STROKE_IDLE_MS,
} from './annotationStore';

const K = trackKey('alice', 'screen_share');
const ME = 'alice';

beforeEach(() => store.reset());

describe('draw state', () => {
    it('starts disabled with the brand colour', () => {
        const s = store.getState();
        expect(s.enabled).toBe(false);
        expect(s.color).toBe(PALETTE[0]);
    });
    it('has no tool to choose: every stroke is a laser, and none survives the TTL', () => {
        // The store exposes no setTool and a Stroke carries no tool, so this
        // is the whole of the "which tool?" question now — a stroke always
        // goes, whoever drew it and however it was started.
        expect('setTool' in store).toBe(false);
        const t0 = 1_000_000;
        clock.now = () => t0;
        const id = store.beginStroke(K, ME, { x: 0.1, y: 0.1 })!;
        expect(store.getState().strokes[K][0]).not.toHaveProperty('tool');
        store.endStroke(K, id);
        expect(store.expireLasers(t0 + LASER_TTL_MS)).toBe(true);
        expect(store.getState().strokes[K]).toEqual([]);
        clock.now = () => Date.now();
    });
    it('clamps width to a sane range', () => {
        store.setWidth(0); expect(store.getState().width).toBe(1);
        store.setWidth(999); expect(store.getState().width).toBe(24);
    });
    it('notifies subscribers only on real change', () => {
        let n = 0; const off = store.subscribe(() => n++);
        store.setEnabled(true); store.setEnabled(true); store.setColor(PALETTE[0]);
        off();
        expect(n).toBe(1);
    });
});

describe('stroke lifecycle', () => {
    it('begin → append → end records a finished stroke with normalized points', () => {
        const id = store.beginStroke(K, ME, { x: 0.1, y: 0.2 })!;
        store.appendPoints(K, id, [{ x: 0.3, y: 0.4 }, { x: 0.5, y: 0.6 }]);
        store.endStroke(K, id);
        const [s] = store.getState().strokes[K];
        expect(s.by).toBe(ME);
        expect(s.points).toHaveLength(3);
        expect(s.closedAt).not.toBe(0); // closed = the pen lifted
    });
    it('rejects a malformed first point instead of recording garbage', () => {
        expect(store.beginStroke(K, ME, { x: NaN, y: 0 })).toBeNull();
        expect(store.getState().strokes[K]).toBeUndefined();
    });
    it('clamps drifting points into the frame and drops non-finite ones', () => {
        const id = store.beginStroke(K, ME, { x: 0.5, y: 0.5 })!;
        store.appendPoints(K, id, [{ x: 1.7, y: -0.3 }, { x: Infinity, y: 0 }]);
        const [s] = store.getState().strokes[K];
        expect(s.points).toEqual([{ x: 0.5, y: 0.5 }, { x: 1, y: 0 }]);
    });
    it('ignores appends after end and for unknown ids', () => {
        const id = store.beginStroke(K, ME, { x: 0, y: 0 })!;
        store.endStroke(K, id);
        store.appendPoints(K, id, [{ x: 1, y: 1 }]);
        store.appendPoints(K, 'nope', [{ x: 1, y: 1 }]);
        expect(store.getState().strokes[K][0].points).toHaveLength(1);
    });
});

describe('bounds — the same limits a receiver applies to remote data', () => {
    it('caps points per stroke', () => {
        const id = store.beginStroke(K, ME, { x: 0, y: 0 })!;
        store.appendPoints(K, id, Array.from({ length: MAX_POINTS_PER_STROKE + 50 }, () => ({ x: 0.5, y: 0.5 })));
        expect(store.getState().strokes[K][0].points).toHaveLength(MAX_POINTS_PER_STROKE);
    });
    it('evicts the oldest strokes past the per-track cap', () => {
        for (let i = 0; i < MAX_STROKES_PER_TRACK + 3; i++) store.beginStroke(K, ME, { x: 0, y: 0 }, { id: `s${i}` });
        const list = store.getState().strokes[K];
        expect(list).toHaveLength(MAX_STROKES_PER_TRACK);
        expect(list[0].id).toBe('s3');
    });
});

describe('clearing a track', () => {
    it('clearTrack empties a track; dropTrack forgets it entirely', () => {
        store.beginStroke(K, ME, { x: 0, y: 0 });
        store.clearTrack(K);
        expect(store.getState().strokes[K]).toEqual([]);
        store.dropTrack(K);
        expect(K in store.getState().strokes).toBe(false);
    });
});

describe('laser expiry — a stroke stands until it is let go, then fades whole', () => {
    const T = 1_000_000;
    beforeEach(() => { clock.now = () => T; store.reset(); });
    afterEach(() => { clock.now = () => Date.now(); });

    // ── the behaviour the user asked for back ──────────────────────────────
    it('a stroke being drawn is never eroded: no points are dropped, nothing fades', () => {
        // The regression this guards: a per-point TTL ate the tail of a stroke
        // while the hand was still moving, so a long line dissolved under its
        // own cursor and rendered as a string of dots. While the pen is down
        // the mark is WHOLE.
        const id = store.beginStroke(K, ME, { x: 0, y: 0 }, { id: 'held' })!;
        const drawn: { x: number; y: number }[] = [{ x: 0, y: 0 }];
        for (let ms = 100; ms <= 10_000; ms += 100) {
            const t = T + ms;
            clock.now = () => t;
            const p = { x: (ms % 1000) / 1000, y: 0.5 };
            drawn.push(p);
            expect(store.appendPoints(K, id, [p])).toBe(true);
            store.expireLasers(t);              // the render loop's tick
            const s = store.getState().strokes[K][0];
            expect(s, `stroke vanished mid-gesture at +${ms}ms`).toBeDefined();
            expect(s.closedAt, `closed mid-gesture at +${ms}ms`).toBe(0);
            // Every point ever drawn is still there, in order.
            expect(s.points).toEqual(drawn);
        }
        // Ten seconds of continuous drawing, still one solid unbroken stroke.
        expect(store.getState().strokes[K][0].points).toHaveLength(101);
    });

    it('a released stroke fades over exactly one TTL, measured from the RELEASE', () => {
        const id = store.beginStroke(K, ME, { x: 0, y: 0 }, { id: 'released' })!;
        clock.now = () => T + 900;
        store.appendPoints(K, id, [{ x: 0.5, y: 0.5 }]);
        clock.now = () => T + 1000;
        store.endStroke(K, id);                          // pen up at T+1000
        const [s] = store.getState().strokes[K];
        expect(s.closedAt).toBe(T + 1000);
        expect(strokeAlpha(s, T + 1000)).toBe(1);
        expect(strokeAlpha(s, T + 1000 + LASER_TTL_MS / 2)).toBeCloseTo(0.5, 5);
        expect(store.expireLasers(T + 1000 + LASER_TTL_MS - 1)).toBe(false);
        expect(store.getState().strokes[K]).toHaveLength(1);
        expect(store.expireLasers(T + 1000 + LASER_TTL_MS)).toBe(true);
        expect(store.getState().strokes[K]).toEqual([]);
    });

    // ── the guarantee that must survive the restoration ────────────────────
    it('WATCHDOG: a stroke that never gets a release still closes, and then fades', () => {
        // The pointerup is lost / the peer left / the tab went away. Nothing
        // will ever end this stroke, so the watchdog does, and it then fades
        // exactly as a released stroke would rather than popping out.
        const id = store.beginStroke(K, ME, { x: 0, y: 0 }, { id: 'abandoned' })!;
        clock.now = () => T + 500;
        store.appendPoints(K, id, [{ x: 0.2, y: 0.2 }]);
        const last = T + 500;

        // Still live right up to the watchdog deadline.
        expect(store.expireLasers(last + STROKE_IDLE_MS - 1)).toBe(false);
        expect(store.getState().strokes[K][0].closedAt).toBe(0);

        // Deadline: closed, as if released — same fade, same alpha ramp.
        expect(store.expireLasers(last + STROKE_IDLE_MS)).toBe(true);
        const [s] = store.getState().strokes[K];
        expect(s.closedAt).toBe(last + STROKE_IDLE_MS);
        expect(strokeAlpha(s, last + STROKE_IDLE_MS)).toBe(1);

        // ...and gone one TTL after that. Worst case an abandoned stroke can
        // occupy a screen is STROKE_IDLE_MS + LASER_TTL_MS after its last point.
        expect(store.expireLasers(last + STROKE_IDLE_MS + LASER_TTL_MS)).toBe(true);
        expect(store.getState().strokes[K]).toEqual([]);
    });

    it('the watchdog is refreshed by new points, so an active stroke never trips it', () => {
        const id = store.beginStroke(K, ME, { x: 0, y: 0 }, { id: 'active' })!;
        // A point every STROKE_IDLE_MS - 1 keeps it alive indefinitely...
        for (let i = 1; i <= 20; i++) {
            const t = T + i * (STROKE_IDLE_MS - 1);
            clock.now = () => t;
            store.appendPoints(K, id, [{ x: i / 20, y: 0.5 }]);
            store.expireLasers(t);
            expect(store.getState().strokes[K][0].closedAt).toBe(0);
        }
        // ...and the moment they stop, the watchdog takes it.
        const last = T + 20 * (STROKE_IDLE_MS - 1);
        expect(store.expireLasers(last + STROKE_IDLE_MS)).toBe(true);
        expect(store.getState().strokes[K][0].closedAt).toBe(last + STROKE_IDLE_MS);
    });

    it('every unreleased stroke expires, whoever drew it', () => {
        store.beginStroke(K, ME, { x: 0, y: 0 }, { id: 'mine' });
        store.beginStroke(K, 'bob', { x: 0, y: 0 }, { id: 'bobs' });
        store.expireLasers(T + STROKE_IDLE_MS);                    // both close
        expect(store.expireLasers(T + STROKE_IDLE_MS + LASER_TTL_MS)).toBe(true);
        expect(store.getState().strokes[K]).toEqual([]);
    });

    it('appendPoints reports a closed stroke, so the pen restarts instead of dying', () => {
        const id = store.beginStroke(K, ME, { x: 0, y: 0 }, { id: 'gone' })!;
        expect(store.appendPoints(K, id, [{ x: 0.1, y: 0.1 }])).toBe(true);
        store.expireLasers(T + STROKE_IDLE_MS);                    // watchdog closes it
        expect(store.appendPoints(K, id, [{ x: 0.2, y: 0.2 }])).toBe(false);
        store.expireLasers(T + STROKE_IDLE_MS + LASER_TTL_MS);     // and it goes
        expect(store.appendPoints(K, id, [{ x: 0.3, y: 0.3 }])).toBe(false);
    });

    it('a stroke that hits the point cap closes rather than silently swallowing points', () => {
        // While the head was being trimmed the cap was unreachable; now it is,
        // and a full stroke that kept returning `true` would leave the pen dead
        // for the rest of the gesture with no way for the caller to know.
        const id = store.beginStroke(K, ME, { x: 0, y: 0 }, { id: 'full' })!;
        const fill = Array.from({ length: MAX_POINTS_PER_STROKE }, (_, i) => ({ x: (i % 100) / 100, y: 0.5 }));
        store.appendPoints(K, id, fill);
        expect(store.getState().strokes[K][0].points).toHaveLength(MAX_POINTS_PER_STROKE);
        expect(store.appendPoints(K, id, [{ x: 0.9, y: 0.9 }])).toBe(false);
        expect(store.getState().strokes[K][0].closedAt).not.toBe(0);
    });

    it('strokeAlpha: solid while live, then a linear ramp to gone over one TTL', () => {
        expect(strokeAlpha({ closedAt: 0 }, T + 10_000_000)).toBe(1); // live: never fades
        expect(strokeAlpha({ closedAt: T }, T)).toBe(1);
        expect(strokeAlpha({ closedAt: T }, T + LASER_TTL_MS / 2)).toBeCloseTo(0.5, 5);
        expect(strokeAlpha({ closedAt: T }, T + LASER_TTL_MS)).toBe(0);
        expect(strokeAlpha({ closedAt: T }, T + LASER_TTL_MS * 10)).toBe(0); // clamped
    });

    it('remote strokes age from when WE heard them, not from any wire timestamp', () => {
        // Nothing a peer sends can make a stroke look younger than it is, and
        // a peer that goes silent mid-stroke cannot pin it on our screen.
        clock.now = () => T + 50_000;
        const id = store.beginStroke(K, 'bob', { x: 0, y: 0 }, { id: 'remote' })!;
        expect(store.getState().strokes[K][0].updatedAt).toBe(T + 50_000);
        expect(store.expireLasers(T + 50_000 + STROKE_IDLE_MS - 1)).toBe(false);
        expect(store.expireLasers(T + 50_000 + STROKE_IDLE_MS)).toBe(true);       // watchdog
        expect(store.expireLasers(T + 50_000 + STROKE_IDLE_MS + LASER_TTL_MS)).toBe(true);
        expect(store.getState().strokes[K]).toEqual([]);
        expect(id).toBe('remote');
    });

    it('removeStroke drops one stroke at once (reduced motion), leaving others alone', () => {
        const a = store.beginStroke(K, ME, { x: 0, y: 0 }, { id: 'a' })!;
        store.beginStroke(K, 'bob', { x: 0, y: 0 }, { id: 'b' });
        store.endStroke(K, a);
        store.removeStroke(K, a);
        expect(store.getState().strokes[K].map(s => s.id)).toEqual(['b']);
    });
});

describe('grants (Phase 3)', () => {
    const KEY = trackKey('alice', 'screen_share');

    it('the owner is implicitly granted, nobody else is', () => {
        expect(isGranted(store.getState(), KEY, 'alice')).toBe(true);
        expect(isGranted(store.getState(), KEY, 'bob')).toBe(false);
    });

    it('request -> grant clears the request and allows drawing; revoke takes it back', () => {
        store.addRequest(KEY, 'bob');
        store.addRequest(KEY, 'bob'); // dedup
        expect(selectTrackRequests(KEY)(store.getState())).toEqual(['bob']);
        store.grant(KEY, 'bob');
        expect(selectTrackRequests(KEY)(store.getState())).toEqual([]);
        expect(selectTrackGrants(KEY)(store.getState())).toEqual(['bob']);
        expect(isGranted(store.getState(), KEY, 'bob')).toBe(true);
        store.revoke(KEY, 'bob');
        expect(isGranted(store.getState(), KEY, 'bob')).toBe(false);
    });

    it('a request from someone already granted is not queued', () => {
        store.grant(KEY, 'bob');
        store.addRequest(KEY, 'bob');
        expect(selectTrackRequests(KEY)(store.getState())).toEqual([]);
    });

    it('setGrantList replaces wholesale, dedups, drops empties, and caps', () => {
        store.grant(KEY, 'old');
        store.setGrantList(KEY, ['bob', 'bob', '', 'carol']);
        expect(selectTrackGrants(KEY)(store.getState())).toEqual(['bob', 'carol']);
        store.setGrantList(KEY, Array.from({ length: MAX_GRANTS + 10 }, (_, i) => `u${i}`));
        expect(selectTrackGrants(KEY)(store.getState())).toHaveLength(MAX_GRANTS);
    });

    it('setGrantList with an identical list does not notify', () => {
        store.setGrantList(KEY, ['bob']);
        let n = 0; const off = store.subscribe(() => n++);
        store.setGrantList(KEY, ['bob']);
        off();
        expect(n).toBe(0);
    });

    it('dropTrack forgets grants and requests along with strokes', () => {
        store.grant(KEY, 'bob'); store.addRequest(KEY, 'carol'); store.beginStroke(KEY, 'alice', { x: 0, y: 0 });
        store.dropTrack(KEY);
        const s = store.getState();
        expect(KEY in s.strokes).toBe(false);
        expect(KEY in s.grants).toBe(false);
        expect(KEY in s.requests).toBe(false);
    });

    it('reset clears grants and requests', () => {
        store.grant(KEY, 'bob'); store.addRequest(KEY, 'carol');
        store.reset();
        expect(store.getState().grants).toEqual({});
        expect(store.getState().requests).toEqual({});
    });
});

describe('revoking from a participant name (right-click)', () => {
    const CAM = trackKey('alice', 'camera');
    const SHARE = trackKey('alice', 'screen_share');
    const THEIRS = trackKey('carol', 'screen_share');

    it('takes the grant off EVERY surface the revoker owns, in one mutation', () => {
        store.grant(CAM, 'bob');
        store.grant(SHARE, 'bob');
        let n = 0; const off = store.subscribe(() => n++);
        const changed = store.revokeAllFrom('alice', 'bob');
        off();
        expect(changed.sort()).toEqual([CAM, SHARE].sort());
        expect(n).toBe(1); // one set() -> one grant.revoke+grant.list pair per track
        expect(isGranted(store.getState(), CAM, 'bob')).toBe(false);
        expect(isGranted(store.getState(), SHARE, 'bob')).toBe(false);
    });

    it('never touches a grant on someone else\'s surface', () => {
        store.grant(SHARE, 'bob');
        store.setGrantList(THEIRS, ['bob']); // carol granted bob on carol's share
        store.revokeAllFrom('alice', 'bob');
        expect(isGranted(store.getState(), SHARE, 'bob')).toBe(false);
        expect(isGranted(store.getState(), THEIRS, 'bob')).toBe(true);
    });

    it('leaves other grantees on the same surface alone', () => {
        store.grant(SHARE, 'bob'); store.grant(SHARE, 'dave');
        store.revokeAllFrom('alice', 'bob');
        expect(selectTrackGrants(SHARE)(store.getState())).toEqual(['dave']);
    });

    it('is a no-op (no notify) when there is nothing to revoke', () => {
        store.grant(SHARE, 'bob');
        let n = 0; const off = store.subscribe(() => n++);
        expect(store.revokeAllFrom('alice', 'nobody')).toEqual([]);
        expect(store.revokeAllFrom('', 'bob')).toEqual([]);
        expect(store.revokeAllFrom('alice', '')).toEqual([]);
        off();
        expect(n).toBe(0);
    });

    it('selectCanRevoke gates the menu item on owning the grant', () => {
        store.setGrantList(THEIRS, ['bob']);
        expect(selectCanRevoke('alice', 'bob')(store.getState())).toBe(false);
        store.grant(SHARE, 'bob');
        expect(selectCanRevoke('alice', 'bob')(store.getState())).toBe(true);
        store.revokeAllFrom('alice', 'bob');
        expect(selectCanRevoke('alice', 'bob')(store.getState())).toBe(false);
    });

    it('ownedGrantTracks lists only the revoker\'s own tracks', () => {
        store.grant(CAM, 'bob'); store.setGrantList(THEIRS, ['bob']);
        expect(ownedGrantTracks(store.getState(), 'alice', 'bob')).toEqual([CAM]);
        expect(ownedGrantTracks(store.getState(), 'carol', 'bob')).toEqual([THEIRS]);
    });
});

describe('granting from a participant name (right-click "Allow Annotating")', () => {
    const CAM = trackKey('alice', 'camera');
    const SHARE = trackKey('alice', 'screen_share');
    const THEIRS = trackKey('carol', 'screen_share');

    it('prefers the screen share when we publish both', () => {
        // A share is the surface annotation is FOR — the one with content
        // worth pointing at, and the only one the desktop overlay can draw
        // over. Granting on the camera by default would hand someone a pen
        // over your face because you happened to have both on.
        store.setOwnedSurfaces([CAM, SHARE]);
        expect(store.grantOnOwnedSurface('alice', 'bob')).toBe(SHARE);
        expect(selectTrackGrants(SHARE)(store.getState())).toEqual(['bob']);
        expect(selectTrackGrants(CAM)(store.getState())).toEqual([]);
    });

    it('falls back to the camera when that is all we publish', () => {
        store.setOwnedSurfaces([CAM]);
        expect(store.grantOnOwnedSurface('alice', 'bob')).toBe(CAM);
        expect(isGranted(store.getState(), CAM, 'bob')).toBe(true);
    });

    it('does nothing when we publish no surface, or the target is us', () => {
        expect(store.grantOnOwnedSurface('alice', 'bob')).toBeNull();
        store.setOwnedSurfaces([SHARE]);
        expect(store.grantOnOwnedSurface('alice', 'alice')).toBeNull();
        expect(store.grantOnOwnedSurface('', 'bob')).toBeNull();
        expect(store.grantOnOwnedSurface('alice', '')).toBeNull();
    });

    it('never grants on a surface someone else owns', () => {
        // A grant list is believed only from its owner, so a grant here would
        // be a button that does nothing on every other client.
        store.setOwnedSurfaces([THEIRS]);
        expect(store.grantOnOwnedSurface('alice', 'bob')).toBeNull();
        expect(selectTrackGrants(THEIRS)(store.getState())).toEqual([]);
    });

    it('clears a standing decline cooldown — an offer outranks an earlier no', () => {
        store.setOwnedSurfaces([SHARE]);
        store.addRequest(SHARE, 'bob');
        store.denyRequest(SHARE, 'bob');
        expect(Object.keys(store.getState().deniedUntil)).toHaveLength(1);
        store.grantOnOwnedSurface('alice', 'bob');
        expect(store.getState().deniedUntil).toEqual({});
        expect(isGranted(store.getState(), SHARE, 'bob')).toBe(true);
    });

    it('is idempotent and does not re-notify when they are already granted', () => {
        store.setOwnedSurfaces([SHARE]);
        store.grantOnOwnedSurface('alice', 'bob');
        let n = 0; const off = store.subscribe(() => n++);
        expect(store.grantOnOwnedSurface('alice', 'bob')).toBe(SHARE);
        off();
        expect(n).toBe(0);
    });

    it('selectCanGrantAnnotation is the exact complement of selectCanRevoke', () => {
        const canGrant = () => selectCanGrantAnnotation('alice', 'bob')(store.getState());
        const canRevoke = () => selectCanRevoke('alice', 'bob')(store.getState());
        // No surface published: neither item shows.
        expect(canGrant()).toBe(false); expect(canRevoke()).toBe(false);
        store.setOwnedSurfaces([SHARE]);
        expect(canGrant()).toBe(true);  expect(canRevoke()).toBe(false);
        store.grantOnOwnedSurface('alice', 'bob');
        expect(canGrant()).toBe(false); expect(canRevoke()).toBe(true);
        store.revokeAllFrom('alice', 'bob');
        expect(canGrant()).toBe(true);  expect(canRevoke()).toBe(false);
        // Never offered against ourselves.
        expect(selectCanGrantAnnotation('alice', 'alice')(store.getState())).toBe(false);
    });

    it('selectGrantTarget names the surface the menu would grant on', () => {
        expect(selectGrantTarget('alice')(store.getState())).toBeNull();
        store.setOwnedSurfaces([CAM]);
        expect(selectGrantTarget('alice')(store.getState())).toBe(CAM);
        store.setOwnedSurfaces([CAM, SHARE]);
        expect(selectGrantTarget('alice')(store.getState())).toBe(SHARE);
    });

    it('setOwnedSurfaces dedups and stays quiet when the set is unchanged', () => {
        store.setOwnedSurfaces([SHARE, CAM]);
        let n = 0; const off = store.subscribe(() => n++);
        store.setOwnedSurfaces([CAM, SHARE, SHARE]); // same set, different order
        off();
        expect(n).toBe(0);
    });

    it('a surface that goes away stops being grantable', () => {
        store.setOwnedSurfaces([SHARE]);
        store.dropTrack(SHARE);
        expect(store.getState().ownedSurfaces).toEqual([]);
        expect(selectCanGrantAnnotation('alice', 'bob')(store.getState())).toBe(false);
    });

    it('isScreenShareTrack reads the source half, not a substring of the whole key', () => {
        expect(isScreenShareTrack(trackKey('alice', 'screen_share'))).toBe(true);
        expect(isScreenShareTrack(trackKey('alice', 'camera'))).toBe(false);
        // The old `track.includes('screen')` said true for this one.
        expect(isScreenShareTrack(trackKey('screenprinter', 'camera'))).toBe(false);
    });
});

describe('the pencil badge (selectCanAnnotate)', () => {
    const SHARE = trackKey('alice', 'screen_share');
    const THEIRS = trackKey('carol', 'screen_share');

    it('is off for everyone until someone is actually granted', () => {
        expect(selectCanAnnotate('bob')(store.getState())).toBe(false);
    });

    it('is on for a grantee on ANY surface, ours or a mirrored one', () => {
        store.setGrantList(THEIRS, ['bob']);
        expect(selectCanAnnotate('bob')(store.getState())).toBe(true);
        store.reset();
        store.grant(SHARE, 'bob');
        expect(selectCanAnnotate('bob')(store.getState())).toBe(true);
    });

    it('does NOT badge a streamer for their own implicit access', () => {
        store.beginStroke(SHARE, 'alice', { x: 0, y: 0 });
        expect(isGranted(store.getState(), SHARE, 'alice')).toBe(true); // owner may draw
        expect(selectCanAnnotate('alice')(store.getState())).toBe(false); // but wears no badge
    });

    it('goes off the moment the grant is revoked', () => {
        store.grant(SHARE, 'bob');
        store.revokeAllFrom('alice', 'bob');
        expect(selectCanAnnotate('bob')(store.getState())).toBe(false);
    });

    it('ignores an empty identity', () => {
        store.grant(SHARE, 'bob');
        expect(selectCanAnnotate('')(store.getState())).toBe(false);
    });
});


describe('request expiry', () => {
    const T = 1_000_000;
    beforeEach(() => { clock.now = () => T; store.reset(); });
    afterEach(() => { clock.now = () => Date.now(); });

    it('a viewer can ask again once the request lapses', () => {
        const other = trackKey('bob', 'screen_share');
        store.requestAccess(other);
        store.requestAccess(other); // idempotent while pending
        expect(store.getState().outgoing).toEqual([other]);
        clock.now = () => T + REQUEST_TTL_MS - 1;
        expect(store.expireRequests()).toBe(false);
        clock.now = () => T + REQUEST_TTL_MS;
        expect(store.expireRequests()).toBe(true);
        expect(store.getState().outgoing).toEqual([]);
        store.requestAccess(other);
        expect(store.getState().outgoing).toEqual([other]);
    });

    it("the owner's pending request lapses too; grant and decline clear it first", () => {
        store.addRequest(K, 'carol');
        store.addRequest(K, 'dave');
        store.grant(K, 'carol');
        store.denyRequest(K, 'dave');
        expect(Object.keys(store.getState().requestedAt)).toEqual([]);
        clock.now = () => T + 10;
        store.addRequest(K, 'erin');
        clock.now = () => T + REQUEST_TTL_MS + 5; // 5ms short for erin
        // (This tick DOES change something — dave's decline cooldown lapses
        // on the same schedule — so assert on erin's ask, not on the flag.)
        store.expireRequests();
        expect(selectTrackRequests(K)(store.getState())).toEqual(['erin']);
        clock.now = () => T + REQUEST_TTL_MS + 10;
        expect(store.expireRequests()).toBe(true);
        expect(selectTrackRequests(K)(store.getState())).toEqual([]);
        expect(selectTrackGrants(K)(store.getState())).toEqual(['carol']);
    });

    it('dropTrack forgets timestamps for that track only', () => {
        const other = trackKey('bob', 'screen_share');
        store.requestAccess(other);
        store.addRequest(K, 'carol');
        store.dropTrack(other);
        expect(Object.keys(store.getState().requestedAt)).toEqual([K + '\ncarol']);
    });
});

describe('decline cooldown', () => {
    const T = 2_000_000;
    const THEIRS = trackKey('bob', 'screen_share');
    beforeEach(() => { clock.now = () => T; store.reset(); });
    afterEach(() => { clock.now = () => Date.now(); });

    // -- owner side ---------------------------------------------------------

    it('a decline drops the request and books the cooldown against that one person', () => {
        store.addRequest(K, 'carol');
        store.addRequest(K, 'dave');
        store.denyRequest(K, 'carol');
        expect(selectTrackRequests(K)(store.getState())).toEqual(['dave']);
        expect(store.getState().deniedUntil).toEqual({ [K + '\ncarol']: T + DENY_COOLDOWN_MS });
    });

    it('refuses the declined person\'s next request until it lapses, then takes it', () => {
        store.addRequest(K, 'carol');
        store.denyRequest(K, 'carol');
        clock.now = () => T + DENY_COOLDOWN_MS - 1;
        store.addRequest(K, 'carol');
        expect(selectTrackRequests(K)(store.getState())).toEqual([]);
        // Someone who was never declined is unaffected the whole time.
        store.addRequest(K, 'dave');
        expect(selectTrackRequests(K)(store.getState())).toEqual(['dave']);
        clock.now = () => T + DENY_COOLDOWN_MS;
        store.addRequest(K, 'carol');
        expect(selectTrackRequests(K)(store.getState())).toEqual(['dave', 'carol']);
    });

    it('granting someone clears a cooldown standing against them (a yes outranks an earlier no)', () => {
        store.addRequest(K, 'carol');
        store.denyRequest(K, 'carol');
        store.grant(K, 'carol');
        expect(store.getState().deniedUntil).toEqual({});
        expect(isGranted(store.getState(), K, 'carol')).toBe(true);
    });

    it('declining someone who is not currently asking still books the cooldown', () => {
        store.denyRequest(K, 'carol');
        expect(store.getState().deniedUntil[K + '\ncarol']).toBe(T + DENY_COOLDOWN_MS);
        expect(store.denyRequest(K, '')).toBeUndefined();
        expect(Object.keys(store.getState().deniedUntil)).toHaveLength(1);
    });

    // -- viewer side --------------------------------------------------------

    it('entering a cooldown ends the pending ask and blocks a new one until it runs out', () => {
        store.requestAccess(THEIRS);
        store.enterCooldown(THEIRS);
        expect(store.getState().outgoing).toEqual([]);
        expect(store.getState().requestedAt).toEqual({});
        expect(cooldownLeft(store.getState(), THEIRS)).toBe(DENY_COOLDOWN_MS);
        expect(selectCooldownUntil(THEIRS)(store.getState())).toBe(T + DENY_COOLDOWN_MS);

        clock.now = () => T + DENY_COOLDOWN_MS - 1_000;
        store.requestAccess(THEIRS);
        expect(store.getState().outgoing).toEqual([]);
        expect(cooldownLeft(store.getState(), THEIRS)).toBe(1_000);

        clock.now = () => T + DENY_COOLDOWN_MS;
        expect(cooldownLeft(store.getState(), THEIRS)).toBe(0);
        store.requestAccess(THEIRS);
        expect(store.getState().outgoing).toEqual([THEIRS]);
    });

    it('a cooldown on one surface never blocks asking on another', () => {
        const otherSurface = trackKey('bob', 'camera');
        store.enterCooldown(THEIRS);
        store.requestAccess(otherSurface);
        expect(store.getState().outgoing).toEqual([otherSurface]);
        expect(cooldownLeft(store.getState(), otherSurface)).toBe(0);
    });

    it('the slow tick purges both sides once they lapse, and says so', () => {
        store.addRequest(K, 'carol');
        store.denyRequest(K, 'carol');
        store.enterCooldown(THEIRS);
        clock.now = () => T + DENY_COOLDOWN_MS - 1;
        expect(store.expireRequests()).toBe(false);
        clock.now = () => T + DENY_COOLDOWN_MS;
        expect(store.expireRequests()).toBe(true);
        expect(store.getState().deniedUntil).toEqual({});
        expect(store.getState().cooldownUntil).toEqual({});
    });

    it('a track that goes away takes both halves of its cooldown with it; reset clears everything', () => {
        store.denyRequest(K, 'carol');
        store.enterCooldown(THEIRS);
        store.dropTrack(K);
        expect(store.getState().deniedUntil).toEqual({});
        expect(store.getState().cooldownUntil[THEIRS]).toBe(T + DENY_COOLDOWN_MS);
        store.dropTrack(THEIRS);
        expect(store.getState().cooldownUntil).toEqual({});
        store.denyRequest(K, 'carol'); store.enterCooldown(THEIRS);
        store.reset();
        expect(store.getState().deniedUntil).toEqual({});
        expect(store.getState().cooldownUntil).toEqual({});
    });
});
