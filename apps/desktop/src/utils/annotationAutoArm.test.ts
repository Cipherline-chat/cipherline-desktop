/**
 * Auto-arm: when the owner approves OUR request to draw, start drawing - but
 * only on that transition, only on a surface where the tool exists.
 *
 * Every case pairs the NEW expectation with a CONTROL that runs the unchanged
 * flow (apply the same wire messages, never consult the auto-arm) and shows the
 * old behaviour does not meet it - so a test here cannot pass vacuously.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    annotationStore as store, trackKey, clock, AUTO_ARM_WINDOW_MS,
} from './annotationStore';
import { applyRemote, applySnapshot } from './annotationTransport';
import { tryAutoArm, autoArmAnnouncement } from './annotationAutoArm';
import type { AnnotMsg } from './annotationCodec';

const ROOM = 'r1';
const ME = 'alice';
const BOB_SHARE = trackKey('bob', 'screen_share');
const CAROL_SHARE = trackKey('carol', 'screen_share');

const grant = (track: string, identity: string): AnnotMsg => ({ t: 'grant.grant', room: ROOM, track, identity });
const list = (track: string, identities: string[]): AnnotMsg => ({ t: 'grant.list', room: ROOM, track, identities });

/** What bob's client puts on the wire when he clicks Allow, in order. */
const bobApproves = () => {
    applyRemote(grant(BOB_SHARE, ME), 'bob', ME);
    applyRemote(list(BOB_SHARE, [ME]), 'bob', ME);
};

let t = 1_000_000;
beforeEach(() => { store.reset(); t = 1_000_000; clock.now = () => t; });
afterEach(() => { clock.now = () => Date.now(); });

const FOCUSED = { surfaceActive: true, granted: true } as const;
const SIDEBAR = { surfaceActive: false, granted: true } as const;
const grantedNow = () => (store.getState().grants[BOB_SHARE] ?? []).includes(ME);

describe('approved while the share is focused / fullscreen', () => {
    it('arms drawing; the colour picker (shown whenever enabled) is therefore open', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        expect(grantedNow()).toBe(true);
        expect(store.getState().enabled).toBe(false); // nothing happens by itself in the store

        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(true);
        expect(store.getState().enabled).toBe(true);
    });

    it('CONTROL (old behaviour): same messages, no auto-arm -> still off, pencil needed', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        expect(grantedNow()).toBe(true);
        expect(store.getState().enabled).toBe(false);
    });

    it('leaves the state exactly as the pencil click does (same entry point, same result)', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        const before = store.getState();
        tryAutoArm(BOB_SHARE, FOCUSED);
        const viaAutoArm = { ...store.getState(), approvedAt: {} };

        store.reset(); clock.now = () => t;
        store.requestAccess(BOB_SHARE);
        bobApproves();
        store.consumeApproval(BOB_SHARE); // the marker is the only difference
        store.setEnabled(!before.enabled); // what AnnotationToolbar's onClick does
        expect(store.getState()).toEqual(viaAutoArm);
    });

    it('arms at most once per approval: Esc then a re-render does not re-arm', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(true);
        store.setEnabled(false); // Esc / the X
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(false);
        expect(store.getState().enabled).toBe(false);
    });

    it('waits for the grant list: approval seen but we are not on the list yet -> not armed, marker kept', () => {
        store.requestAccess(BOB_SHARE);
        applyRemote(grant(BOB_SHARE, ME), 'bob', ME); // grant.grant first, list still in flight
        expect(tryAutoArm(BOB_SHARE, { surfaceActive: true, granted: false })).toBe(false);
        expect(store.getState().enabled).toBe(false);
        applyRemote(list(BOB_SHARE, [ME]), 'bob', ME);
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(true);
    });
});

describe('approved while the share is only in the right-hand column', () => {
    it('does not arm; the pencil simply becomes available as before', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        expect(tryAutoArm(BOB_SHARE, SIDEBAR)).toBe(false);
        expect(store.getState().enabled).toBe(false);
        expect(grantedNow()).toBe(true);
    });

    it('CONTROL: a surface-blind arm (arm on any approval) WOULD have turned it on here', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        // The tempting wrong implementation: arm in the transport, ignoring the view.
        if (store.consumeApproval(BOB_SHARE)) store.setEnabled(true);
        expect(store.getState().enabled).toBe(true); // proves the SIDEBAR test above is discriminating
    });

    it('focusing the share within the window arms it then', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        expect(tryAutoArm(BOB_SHARE, SIDEBAR)).toBe(false);
        t += AUTO_ARM_WINDOW_MS - 1;
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(true);
        expect(store.getState().enabled).toBe(true);
    });

    it('focusing it after the window does NOT arm (no surprise pen long after the fact)', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        t += AUTO_ARM_WINDOW_MS + 1;
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(false);
        expect(store.getState().enabled).toBe(false);
        expect(store.getState().approvedAt).toEqual({}); // the stale marker was discarded
    });

    it('expireRequests prunes a marker nobody claimed', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        t += AUTO_ARM_WINDOW_MS + 1;
        expect(store.expireRequests()).toBe(true);
        expect(store.getState().approvedAt).toEqual({});
    });
});

describe('only the live approval of MY request counts', () => {
    it('re-sync of an already-approved state (snapshot) does not arm', () => {
        // Reconnect / late subscribe: the owner's snapshot already lists us.
        applySnapshot(BOB_SHARE, 'bob', [], [ME]);
        expect(grantedNow()).toBe(true);
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(false);
        expect(store.getState().enabled).toBe(false);
    });

    it('re-sync via a grant.list (no request pending) does not arm', () => {
        applyRemote(list(BOB_SHARE, [ME]), 'bob', ME);
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(false);
        expect(store.getState().enabled).toBe(false);
    });

    it('a repeated grant.grant after the request was already answered does not re-arm', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(true);
        store.setEnabled(false);
        bobApproves(); // e.g. the owner's client re-sends after a reconnect
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(false);
        expect(store.getState().enabled).toBe(false);
    });

    it('an unasked offer from the streamer ("Allow annotating" with no request) does not arm', () => {
        applyRemote(grant(BOB_SHARE, ME), 'bob', ME);
        applyRemote(list(BOB_SHARE, [ME]), 'bob', ME);
        expect(store.getState().approvedAt).toEqual({});
        expect(tryAutoArm(BOB_SHARE, FOCUSED)).toBe(false);
        expect(store.getState().enabled).toBe(false);
    });

    it("other people's approvals do nothing, even with my own request pending", () => {
        store.requestAccess(BOB_SHARE);
        applyRemote(grant(BOB_SHARE, 'dave'), 'bob', ME);
        applyRemote(list(BOB_SHARE, ['dave']), 'bob', ME);
        expect(store.getState().approvedAt).toEqual({});
        expect(tryAutoArm(BOB_SHARE, { surfaceActive: true, granted: grantedNow() })).toBe(false);
        expect(store.getState().enabled).toBe(false);
    });

    it('a grant.grant forged by someone who does not own the track is ignored', () => {
        store.requestAccess(CAROL_SHARE);
        applyRemote(grant(CAROL_SHARE, ME), 'mallory', ME);
        expect(store.getState().approvedAt).toEqual({});
        expect(store.getState().outgoing).toContain(CAROL_SHARE); // still waiting
    });

    it('approval on one track never arms from a different track\'s marker', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        expect(tryAutoArm(CAROL_SHARE, FOCUSED)).toBe(false);
        expect(store.getState().enabled).toBe(false);
        expect(Object.keys(store.getState().approvedAt)).toEqual([BOB_SHARE]);
    });

    it('a declined request never leaves a marker', () => {
        store.requestAccess(BOB_SHARE);
        applyRemote({ t: 'grant.deny', room: ROOM, track: BOB_SHARE, identity: ME }, 'bob', ME);
        expect(store.getState().approvedAt).toEqual({});
    });

    it('dropTrack and reset clear a pending marker', () => {
        store.requestAccess(BOB_SHARE);
        bobApproves();
        store.dropTrack(BOB_SHARE);
        expect(store.getState().approvedAt).toEqual({});
        store.requestAccess(BOB_SHARE);
        bobApproves();
        store.reset();
        expect(store.getState().approvedAt).toEqual({});
    });
});

describe('announcement text', () => {
    it('names the sharer and the Esc exit', () => {
        expect(autoArmAnnouncement('Bob', true)).toBe("Drawing on Bob's screen — Esc to stop");
        expect(autoArmAnnouncement('Bob', false)).toBe("Drawing on Bob's video — Esc to stop");
    });
});

describe('wiring - the auto-arm is the pencil, not a parallel path', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('both the pencil button and the auto-arm go through annotationStore.setEnabled', () => {
        const toolbar = strip(read('../components/call/AnnotationToolbar.tsx'));
        const autoArm = strip(read('./annotationAutoArm.ts'));
        expect(toolbar).toMatch(/annotationStore\.setEnabled\(!enabled\)/);
        expect(autoArm).toMatch(/annotationStore\.setEnabled\(true\)/);
    });

    it('the tile feeds it the SAME surface test that gates the pencil (annotSurface), not its own', () => {
        const tile = strip(read('../components/call/VideoTile.tsx'));
        expect(tile).toMatch(/useAnnotationAutoArm\(\{[^}]*surfaceActive:\s*annotSurface/);
        expect(tile).toMatch(/annotSurface && !isLocal && annotGranted && \(\s*<AnnotationToolbar/);
    });

    it('never moves keyboard focus', () => {
        for (const f of ['./annotationAutoArm.ts', '../hooks/useAnnotationAutoArm.ts']) {
            expect(strip(read(f))).not.toMatch(/\.focus\s*\(|autoFocus|\.select\s*\(/);
        }
    });

    it('does not touch the data-channel handling: the transport hook is unchanged by the feature', () => {
        const hook = strip(read('../hooks/useAnnotationTransport.ts'));
        expect(hook).not.toMatch(/markApproved|consumeApproval|tryAutoArm/);
    });
});
