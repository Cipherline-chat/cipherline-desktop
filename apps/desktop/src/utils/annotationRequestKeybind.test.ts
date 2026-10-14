import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { annotationStore as store, trackKey, clock, REQUEST_TTL_MS, DENY_COOLDOWN_MS } from './annotationStore';
import {
    visibleAnnotationRequests, setAnnotationKeybindContext, hasAnswerableAnnotationRequest,
    approveOldestAnnotationRequest, declineOldestAnnotationRequest, allowAnnotationRequest,
    oldestAnswerableRequest, notifyAnnotationKeybindContextChanged, getAnnotationKeybindContext,
    type AnnotationKeybindContext,
} from './annotationRequestKeybind';

const ME = 'me-id';
const SCREEN = trackKey(ME, 'screen_share');
const CAMERA = trackKey(ME, 'camera');
const OTHER_SCREEN = trackKey('bob', 'screen_share');

let T = 1_000_000;
let present: Set<string>;
let clearCtx: (() => void) | null = null;

function ctx(): AnnotationKeybindContext {
    return { me: ME, isPresent: id => present.has(id) };
}

/** Queue a request from `id` on `track`, asked at absolute time `at`. */
function ask(track: string, id: string, at: number) {
    clock.now = () => at;
    expect(store.addRequest(track, id)).toBe(true);
    clock.now = () => T;
}

beforeEach(() => {
    T = 1_000_000;
    clock.now = () => T;
    store.reset();
    present = new Set(['alice', 'bob', 'carol']);
    clearCtx = setAnnotationKeybindContext(ctx());
});
afterEach(() => {
    clearCtx?.();
    clearCtx = null;
    clock.now = () => Date.now();
    vi.restoreAllMocks();
});

describe('visibleAnnotationRequests - what the dock shows and the key may answer', () => {
    it('orders oldest first across surfaces', () => {
        ask(SCREEN, 'bob', T - 3000);
        ask(CAMERA, 'alice', T - 9000);
        ask(SCREEN, 'carol', T - 1000);
        const list = visibleAnnotationRequests(store.getState(), ctx(), T);
        expect(list.map(r => r.id)).toEqual(['alice', 'bob', 'carol']);
        expect(list[0]).toEqual({ track: CAMERA, id: 'alice', at: T - 9000 });
    });

    it('drops a request at exactly REQUEST_TTL_MS, keeps one a millisecond younger', () => {
        ask(SCREEN, 'alice', T - REQUEST_TTL_MS);      // expired (boundary)
        ask(SCREEN, 'bob', T - REQUEST_TTL_MS + 1);    // still valid
        expect(visibleAnnotationRequests(store.getState(), ctx(), T).map(r => r.id)).toEqual(['bob']);
    });

    it('ignores requests on surfaces we do not own, from ourselves, and from people not in the call', () => {
        ask(OTHER_SCREEN, 'alice', T - 5000);   // not our surface
        ask(SCREEN, ME, T - 5000);              // our own identity
        ask(SCREEN, 'mallory', T - 5000);       // not a participant
        ask(SCREEN, 'carol', T - 100);
        expect(visibleAnnotationRequests(store.getState(), ctx(), T).map(r => r.id)).toEqual(['carol']);
    });

    it('ignores a request with no timestamp (cannot be aged, so cannot be live)', () => {
        const s = { requests: { [SCREEN]: ['alice'] }, requestedAt: {} };
        expect(visibleAnnotationRequests(s, ctx(), T)).toEqual([]);
    });

    it('shows nothing without a context (no call / dock not mounted) or without an identity', () => {
        ask(SCREEN, 'alice', T - 100);
        expect(visibleAnnotationRequests(store.getState(), null, T)).toEqual([]);
        expect(visibleAnnotationRequests(store.getState(), { me: '', isPresent: () => true }, T)).toEqual([]);
    });
});

describe('approve / decline by keybind', () => {
    it('approves the OLDEST valid request only, one per press', () => {
        ask(SCREEN, 'bob', T - 2000);
        ask(SCREEN, 'alice', T - 8000);
        const first = approveOldestAnnotationRequest();
        expect(first?.id).toBe('alice');
        expect(store.getState().grants[SCREEN]).toEqual(['alice']);
        expect(store.getState().requests[SCREEN]).toEqual(['bob']);
        const second = approveOldestAnnotationRequest();
        expect(second?.id).toBe('bob');
        expect(store.getState().grants[SCREEN]).toEqual(['alice', 'bob']);
        expect(approveOldestAnnotationRequest()).toBeNull();
    });

    it('skips an expired request still in the store (between expiry ticks) and approves the next valid one', () => {
        ask(SCREEN, 'alice', T - REQUEST_TTL_MS - 500); // lapsed, tick has not run yet
        ask(SCREEN, 'bob', T - 1000);
        expect(store.getState().requests[SCREEN]).toContain('alice');
        expect(approveOldestAnnotationRequest()?.id).toBe('bob');
        expect(store.getState().grants[SCREEN]).toEqual(['bob']);
    });

    it('does nothing when the only request has expired (no grant, no state change)', () => {
        ask(SCREEN, 'alice', T - REQUEST_TTL_MS);
        const before = store.getState();
        const grant = vi.spyOn(store, 'grant');
        expect(approveOldestAnnotationRequest()).toBeNull();
        expect(grant).not.toHaveBeenCalled();
        expect(store.getState()).toBe(before);
    });

    it('goes through the same path as clicking Allow (store.grant with that track and identity)', () => {
        ask(SCREEN, 'alice', T - 1000);
        const grant = vi.spyOn(store, 'grant');
        approveOldestAnnotationRequest();
        expect(grant).toHaveBeenCalledTimes(1);
        expect(grant).toHaveBeenCalledWith(SCREEN, 'alice');
        const byKey = store.getState();

        // Same starting state, answered with the dock's own click handler.
        store.reset();
        ask(SCREEN, 'alice', T - 1000);
        allowAnnotationRequest(SCREEN, 'alice');
        const byClick = store.getState();
        expect(byKey.grants).toEqual(byClick.grants);
        expect(byKey.requests).toEqual(byClick.requests);
        expect(byKey.requestedAt).toEqual(byClick.requestedAt);
        expect(byKey.deniedUntil).toEqual(byClick.deniedUntil);
    });

    it('grants on exactly one surface: a request on the camera never grants the screen (no room-wide approval)', () => {
        ask(CAMERA, 'alice', T - 1000);
        approveOldestAnnotationRequest();
        expect(store.getState().grants[CAMERA]).toEqual(['alice']);
        expect(store.getState().grants[SCREEN]).toBeUndefined();
    });

    it('decline answers the oldest with the click path, including the cooldown', () => {
        ask(SCREEN, 'bob', T - 1000);
        ask(SCREEN, 'alice', T - 5000);
        const deny = vi.spyOn(store, 'denyRequest');
        expect(declineOldestAnnotationRequest()?.id).toBe('alice');
        expect(deny).toHaveBeenCalledWith(SCREEN, 'alice');
        expect(store.getState().deniedUntil[SCREEN + '\nalice']).toBe(T + DENY_COOLDOWN_MS);
        expect(store.getState().grants[SCREEN]).toBeUndefined();
    });

    it('negative control: with no context (no call) a pending request is NOT approvable', () => {
        ask(SCREEN, 'alice', T - 1000);
        clearCtx?.(); clearCtx = null;
        expect(oldestAnswerableRequest()).toBeNull();
        expect(approveOldestAnnotationRequest()).toBeNull();
        expect(store.getState().grants[SCREEN]).toBeUndefined();
    });

    it('a requester who left is not approvable even before the store drops them', () => {
        ask(SCREEN, 'alice', T - 1000);
        present.delete('alice');
        expect(approveOldestAnnotationRequest()).toBeNull();
    });
});

describe('arming gate', () => {
    it('turns on with the first pending request and off when none remain', () => {
        const seen: boolean[] = [];
        const off = store.subscribe(() => seen.push(hasAnswerableAnnotationRequest()));
        expect(hasAnswerableAnnotationRequest()).toBe(false);
        ask(SCREEN, 'alice', T);
        ask(SCREEN, 'bob', T);
        expect(hasAnswerableAnnotationRequest()).toBe(true);
        approveOldestAnnotationRequest();
        expect(hasAnswerableAnnotationRequest()).toBe(true);
        approveOldestAnnotationRequest();
        expect(hasAnswerableAnnotationRequest()).toBe(false);
        off();
        expect(seen[0]).toBe(true);
        expect(seen[seen.length - 1]).toBe(false);
    });

    it('turns off when the expiry tick removes the last request', () => {
        ask(SCREEN, 'alice', T);
        expect(hasAnswerableAnnotationRequest()).toBe(true);
        store.expireRequests(T + REQUEST_TTL_MS);
        expect(hasAnswerableAnnotationRequest()).toBe(false);
    });

    it('turns off when the requester leaves (store.dropRequestsFrom), keeping their decline cooldown', () => {
        ask(SCREEN, 'alice', T);
        ask(CAMERA, 'alice', T);
        store.denyRequest(CAMERA, 'alice');
        ask(SCREEN, 'bob', T + 1);
        store.dropRequestsFrom('alice');
        expect(store.getState().requests[SCREEN]).toEqual(['bob']);
        expect(store.getState().requestedAt[SCREEN + '\nalice']).toBeUndefined();
        expect(store.getState().deniedUntil[CAMERA + '\nalice']).toBeDefined();
        store.dropRequestsFrom('bob');
        expect(hasAnswerableAnnotationRequest()).toBe(false);
    });

    it('is off with no context, and a stale cleanup never clears a newer context', () => {
        ask(SCREEN, 'alice', T);
        const older = clearCtx!;
        const newer = setAnnotationKeybindContext(ctx());
        older();                                  // late unmount of the old dock
        expect(getAnnotationKeybindContext()).not.toBeNull();
        expect(hasAnswerableAnnotationRequest()).toBe(true);
        newer();
        expect(hasAnswerableAnnotationRequest()).toBe(false);
        clearCtx = null;
        notifyAnnotationKeybindContextChanged(); // no listeners left - must not throw
    });
});

describe('AnnotationRequestsDock wiring (source contract)', () => {
    const src = readFileSync(resolve(__dirname, '../components/call/AnnotationRequestsDock.tsx'), 'utf8');
    it('renders from the same selector the keybind uses', () => {
        expect(src).toMatch(/visibleAnnotationRequests\(/);
        expect(src).toMatch(/setAnnotationKeybindContext\(/);
    });
    it('Allow and Decline call the shared answer functions, not the store directly', () => {
        expect(src).toMatch(/onClick=\{\(\) => allowAnnotationRequest\(track, id\)\}/);
        expect(src).toMatch(/onClick=\{\(\) => declineAnnotationRequest\(track, id\)\}/);
        expect(src).not.toMatch(/annotationStore\.(grant|denyRequest)\(/);
    });
    it('puts the key hint on the first (oldest) row only', () => {
        expect(src).toMatch(/i === 0 && hints\.approve/);
    });
});
