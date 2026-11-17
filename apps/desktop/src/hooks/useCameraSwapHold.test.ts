// @vitest-environment jsdom
/**
 * useCameraSwapHold, really rendered: the frame is held ONLY across a swap. A camera that is
 * turned off (mute / unpublish with no replacement) or whose participant leaves must clear at
 * once - never a frozen face of someone who switched their camera off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventEmitter } from 'node:events';
import { ParticipantEvent, RoomEvent, Track } from 'livekit-client';

const room = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@livekit/components-react', () => ({ useMaybeRoomContext: () => room.current }));
vi.mock('../utils/shareHoldFrame', async () => {
    const actual = await vi.importActual<typeof import('../utils/shareHoldFrame')>('../utils/shareHoldFrame');
    return { ...actual, captureHeldFrame: () => ({ canvas: document.createElement('canvas'), width: 640, height: 480 }) };
});

import { useCameraSwapHold, type CaptureContext } from './useCameraSwapHold';
import { CAMERA_HOLD_GRACE_MS } from '../utils/cameraSwapHold';
import { clearCallEvents, getCallEvents } from '../utils/callEventLog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

class FakeParticipant extends EventEmitter {
    identity = 'friend';
    pub: { source: Track.Source; isMuted: boolean } | undefined = { source: Track.Source.Camera, isMuted: false };
    getTrackPublication() { return this.pub; }
}
class FakeRoom extends EventEmitter {}

interface Api { frame: unknown; capture: (el: HTMLVideoElement | null, same: boolean, ctx: CaptureContext) => void }
let root: Root;
let host: HTMLDivElement;
let part: FakeParticipant;
let api: Api;
let live: unknown;

const Harness = () => {
    const videoRef = React.useRef<HTMLVideoElement>(null);
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    const r = useCameraSwapHold({
        enabled: true, participant: part as never, source: Track.Source.Camera,
        videoRef, wrapperRef, liveTrack: live, trackName: 'remote-video-1',
    });
    api = r as Api;
    return h('div', { ref: wrapperRef }, h('video', { ref: videoRef }));
};
const mount = () => act(() => root.render(h(Harness)));
const liveEl = () => {
    const el = document.createElement('video');
    Object.defineProperty(el, 'readyState', { value: 4 });
    Object.defineProperty(el, 'videoWidth', { value: 640 });
    Object.defineProperty(el, 'videoHeight', { value: 480 });
    return el;
};

beforeEach(() => {
    vi.useFakeTimers();
    clearCallEvents();
    part = new FakeParticipant();
    room.current = new FakeRoom();
    live = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mount();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const swap = { muted: false, replacementKnown: true };

describe('useCameraSwapHold', () => {
    it('swap (replacement already there) -> the last frame is held at once', () => {
        act(() => api.capture(liveEl(), true, swap));
        expect(api.frame).not.toBeNull();
    });

    it('mute -> cleared immediately; a muted camera never starts a hold', () => {
        act(() => api.capture(liveEl(), true, swap));
        act(() => { part.emit(ParticipantEvent.TrackMuted, { source: Track.Source.Camera }); });
        expect(api.frame).toBeNull();
        act(() => api.capture(liveEl(), true, { muted: true, replacementKnown: true }));
        expect(api.frame).toBeNull();
    });

    it('unpublish with no replacement -> cleared immediately; with a replacement the hold stays', () => {
        act(() => api.capture(liveEl(), true, swap));
        act(() => { part.emit(ParticipantEvent.TrackUnpublished, { source: Track.Source.Camera }); }); // pub still listed = replacement
        expect(api.frame).not.toBeNull();
        part.pub = undefined;
        act(() => { part.emit(ParticipantEvent.TrackUnpublished, { source: Track.Source.Camera }); });
        expect(api.frame).toBeNull();
    });

    it('participant disconnect -> cleared immediately', () => {
        act(() => api.capture(liveEl(), true, swap));
        act(() => { (room.current as FakeRoom).emit(RoomEvent.ParticipantDisconnected, { identity: 'friend' }); });
        expect(api.frame).toBeNull();
    });

    it('another participant leaving does not touch it', () => {
        act(() => api.capture(liveEl(), true, swap));
        act(() => { (room.current as FakeRoom).emit(RoomEvent.ParticipantDisconnected, { identity: 'someone-else' }); });
        expect(api.frame).not.toBeNull();
    });

    it('no replacement yet: placeholder (no frame) during the grace, dropped when none arrives', () => {
        act(() => api.capture(liveEl(), true, { muted: false, replacementKnown: false }));
        expect(api.frame).toBeNull();
        act(() => { vi.advanceTimersByTime(CAMERA_HOLD_GRACE_MS + 1); });
        expect(api.frame).toBeNull();
        live = {}; mount();                               // a late track must not resurrect the dropped frame
        expect(api.frame).toBeNull();
        expect(getCallEvents().some(e => e.kind === 'rx_video_gap' && e.detail?.end === 'gone' && e.detail?.held === false)).toBe(true);
    });

    it('replacement arriving inside the grace -> the held frame appears', () => {
        act(() => api.capture(liveEl(), true, { muted: false, replacementKnown: false }));
        act(() => { vi.advanceTimersByTime(CAMERA_HOLD_GRACE_MS - 50); });
        expect(api.frame).toBeNull();
        live = {}; mount();
        expect(api.frame).not.toBeNull();
    });

    it('mute during the grace -> nothing is ever shown', () => {
        act(() => api.capture(liveEl(), true, { muted: false, replacementKnown: false }));
        act(() => { part.emit(ParticipantEvent.TrackMuted, { source: Track.Source.Camera }); });
        part.pub = { source: Track.Source.Camera, isMuted: true };
        live = {}; mount();
        expect(api.frame).toBeNull();
    });
});
