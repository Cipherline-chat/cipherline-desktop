// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventEmitter } from 'events';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

/**
 * useParticipantTrackState must react to the LOCAL participant's own publishes.
 *
 * LiveKit emits `trackPublished` / `trackUnpublished` only on a RemoteParticipant.
 * The local participant emits `localTrackPublished` / `localTrackUnpublished`
 * instead — distinct event strings, not aliases. Subscribing only to the remote
 * pair meant starting your own camera or screen share never re-rendered this
 * hook, leaving your own "hidden video" / "hidden screenshare" badge stale.
 *
 * These tests drive a fake participant emitter, so they fail if either local
 * subscription is dropped again.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let useParticipantTrackState: any;
let Track: { Source: { Camera: string; ScreenShare: string } };

beforeAll(async () => {
    ({ useParticipantTrackState } = await import('./useParticipantTrackState'));
    ({ Track } = await import('livekit-client'));
}, 60000);

class FakeParticipant extends EventEmitter {
    pubs: Record<string, unknown> = {};
    getTrackPublication(source: string) { return this.pubs[source]; }
}

const livePub = () => ({ isMuted: false, track: {} });

let root: Root | null = null;
let host: HTMLDivElement;
let latest: { hasActiveCamera: boolean; hasActiveScreenShare: boolean } | null = null;

const Probe: React.FC<{ p: unknown }> = ({ p }) => {
    latest = useParticipantTrackState(p);
    return null;
};

const mount = (p: unknown) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(React.createElement(Probe, { p })); });
};

beforeEach(() => { latest = null; });
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host?.remove();
});

describe('useParticipantTrackState reacts to LOCAL track events', () => {
    it('picks up the local camera publishing (localTrackPublished)', () => {
        const p = new FakeParticipant();
        mount(p);
        expect(latest!.hasActiveCamera).toBe(false);

        // What LiveKit actually does when YOU start your camera.
        p.pubs[Track.Source.Camera] = livePub();
        act(() => { p.emit('localTrackPublished'); });

        expect(latest!.hasActiveCamera).toBe(true);
    });

    it('picks up the local camera unpublishing (localTrackUnpublished)', () => {
        const p = new FakeParticipant();
        p.pubs[Track.Source.Camera] = livePub();
        mount(p);
        expect(latest!.hasActiveCamera).toBe(true);

        delete p.pubs[Track.Source.Camera];
        act(() => { p.emit('localTrackUnpublished'); });

        expect(latest!.hasActiveCamera).toBe(false);
    });

    it('picks up a local screen share publishing', () => {
        const p = new FakeParticipant();
        mount(p);
        expect(latest!.hasActiveScreenShare).toBe(false);

        p.pubs[Track.Source.ScreenShare] = livePub();
        act(() => { p.emit('localTrackPublished'); });

        expect(latest!.hasActiveScreenShare).toBe(true);
    });

    it('still reacts to the REMOTE events it already handled', () => {
        const p = new FakeParticipant();
        mount(p);
        p.pubs[Track.Source.Camera] = livePub();
        act(() => { p.emit('trackPublished'); });
        expect(latest!.hasActiveCamera).toBe(true);
    });

    it('unsubscribes on unmount — no listeners left behind', () => {
        const p = new FakeParticipant();
        mount(p);
        expect(p.listenerCount('localTrackPublished')).toBeGreaterThan(0);
        act(() => { root!.unmount(); root = null; });
        expect(p.listenerCount('localTrackPublished')).toBe(0);
        expect(p.listenerCount('localTrackUnpublished')).toBe(0);
        expect(p.listenerCount('trackPublished')).toBe(0);
    });
});
