// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Track } from 'livekit-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A viewer who has a share focused, docked and in fullscreen, across a republish.
 * The REAL FocusedStreamBanner, FullscreenOverlay and CallProvider, with the real
 * hold tracker: only the tile itself (a live video) and LiveKit's React hooks are
 * stood in for. What is asserted is what the owner reported: focus and fullscreen
 * survive, and a real stop still closes both.
 */
const room = vi.hoisted(() => ({ participants: [] as unknown[], local: null as unknown, listeners: new Set<() => void>() }));

vi.mock('@livekit/components-react', () => ({
    useParticipants: () => {
        const [, bump] = React.useState(0);
        React.useEffect(() => {
            const fn = () => bump(n => n + 1);
            room.listeners.add(fn);
            return () => { room.listeners.delete(fn); };
        }, []);
        return room.participants;
    },
    useLocalParticipant: () => ({ localParticipant: room.local }),
    useMaybeRoomContext: () => undefined,
    useRoomContext: () => undefined,
}));
vi.mock('./VideoTile', () => ({
    VideoTile: (props: { p: { identity: string }; source: string; isFocusedView?: boolean }) =>
        React.createElement('div', { 'data-tile': props.p.identity, 'data-source': props.source, 'data-focused': String(!!props.isFocusedView) }),
}));
vi.mock('./ScreenShareGate', () => ({
    ScreenShareGate: (props: { p: { identity: string } }) => React.createElement('div', { 'data-gate': props.p.identity }),
}));
vi.mock('./ParticipantCard', () => ({ ParticipantCard: () => null }));
vi.mock('../EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
vi.mock('../../hooks/useOsWindowFullscreen', () => ({ useOsWindowFullscreen: () => false }));
vi.mock('../../utils/secureLocalStore', () => ({ default: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));

import { CallProvider, useCallContext } from '../../contexts/CallContext';
import { FocusedStreamBanner } from './FocusedStreamBanner';
import { FullscreenOverlay } from './FullscreenOverlay';
import { HOLD_TIMEOUT_MS, shareHold } from '../../utils/shareHold';

const SHARER = 'sharer';

/** A remote participant with a share that can come and go. */
function makeSharer() {
    let pub: { isMuted: boolean; track: object; isSubscribed: boolean } | null = { isMuted: false, track: {}, isSubscribed: true };
    return {
        identity: SHARER,
        name: 'Sharer',
        isLocal: false,
        metadata: '',
        attributes: {},
        getTrackPublication: (s: Track.Source) => (s === Track.Source.ScreenShare ? pub ?? undefined : undefined),
        setShare(on: boolean) { pub = on ? { isMuted: false, track: {}, isSubscribed: true } : null; },
    };
}

let ctx: ReturnType<typeof useCallContext> | null = null;
// eslint-disable-next-line react-hooks/globals -- test probe: exposes the live context value to the test body
const Probe: React.FC = () => { ctx = useCallContext(); return null; };
const WATCHED = new Set([SHARER]);
const EMPTY = new Set<string>();
const WatchSet: React.FC = () => {
    const c = useCallContext();
    React.useEffect(() => { c.setWatchedScreenShareIds(WATCHED); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
};

let reactRoot: Root | null = null;
let sharer: ReturnType<typeof makeSharer>;

const tree = () => React.createElement(CallProvider, null,
    React.createElement(Probe),
    React.createElement(WatchSet),
    React.createElement(FocusedStreamBanner, {
        token: 't', isLocalDeafened: false, localMutedParticipantIds: EMPTY, onToggleLocalMute: () => {},
        hiddenVideoIds: EMPTY, hiddenScreenShareIds: EMPTY, onHideVideoChange: () => {}, onHideScreenShareChange: () => {},
    }),
    React.createElement(FullscreenOverlay as unknown as React.FC<Record<string, unknown>>, {
        token: 't', isLocalDeafened: false, localMutedParticipantIds: EMPTY, onToggleLocalMute: () => {},
        hiddenVideoIds: EMPTY, hiddenScreenShareIds: EMPTY, onHideVideoChange: () => {}, onHideScreenShareChange: () => {},
        subscribedScreenshares: WATCHED, onSubscribeScreenshare: () => {}, onStopWatchingScreenshare: () => {},
        controls: null,
    }),
);

/** useParticipants hands back a new array on every roster event. */
const notify = () => act(() => { room.participants = [...room.participants]; for (const fn of room.listeners) fn(); });
const focus = () => ctx!.focusedStream;
const stageTile = () => document.querySelector(`#fs [data-tile="${SHARER}"], [data-tile="${SHARER}"][data-focused="true"]`);

beforeEach(() => {
    vi.useFakeTimers();
    shareHold.reset();
    (globalThis as Record<string, unknown>).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    document.body.innerHTML = '<div id="call-focus-root"></div><div id="call-fullscreen-root"></div>';
    sharer = makeSharer();
    room.local = { identity: 'me', isCameraEnabled: false, getTrackPublication: () => undefined };
    room.participants = [room.local, sharer];
    const el = document.createElement('div');
    document.body.appendChild(el);
    reactRoot = createRoot(el);
    act(() => { reactRoot!.render(tree()); });
    act(() => { ctx!.setFocusedStream({ identity: SHARER, source: Track.Source.ScreenShare }); });
    act(() => { ctx!.setIsFullscreen(true); });
    expect(focus()).toEqual({ identity: SHARER, source: Track.Source.ScreenShare });
    expect(ctx!.isFullscreen).toBe(true);
});

afterEach(() => {
    act(() => { reactRoot?.unmount(); });
    reactRoot = null;
    ctx = null;
    shareHold.reset();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('a focused, fullscreen viewer across a republish', () => {
    it('stays focused and fullscreen for a republish longer than every old grace, then carries on', () => {
        act(() => { shareHold.dispatch(SHARER, { type: 'signal', seq: 'a', hasPublication: true }); });
        const tileBefore = stageTile();
        expect(tileBefore).not.toBeNull();

        act(() => { shareHold.dispatch(SHARER, { type: 'unpublished' }); sharer.setShare(false); });
        notify();
        // Past FULLSCREEN_EMPTY_GRACE_MS (1.2 s) and the old 2 s ss-adjust window.
        act(() => { vi.advanceTimersByTime(4500); });
        notify();
        expect(shareHold.phase(SHARER)).toBe('holding');
        expect(focus()).toEqual({ identity: SHARER, source: Track.Source.ScreenShare });
        expect(ctx!.isFullscreen).toBe(true);
        // The same element: the tile did not remount, so nothing about it was lost.
        expect(stageTile()).toBe(tileBefore);

        act(() => { sharer.setShare(true); shareHold.dispatch(SHARER, { type: 'published' }); });
        notify();
        expect(shareHold.phase(SHARER)).toBe('resuming');
        act(() => { shareHold.dispatch(SHARER, { type: 'first_frame' }); });
        expect(shareHold.phase(SHARER)).toBe('idle');
        act(() => { vi.advanceTimersByTime(5000); });
        notify();
        expect(focus()).toEqual({ identity: SHARER, source: Track.Source.ScreenShare });
        expect(ctx!.isFullscreen).toBe(true);
        expect(stageTile()).toBe(tileBefore);
    });

    it('positive control, a real stop: focus is gone at once and fullscreen closes as it always did', () => {
        act(() => { shareHold.dispatch(SHARER, { type: 'unpublished' }); sharer.setShare(false); });
        notify();
        expect(focus()).toBeNull(); // no timer has been advanced: this is the same tick
        expect(ctx!.isFullscreen).toBe(true);
        act(() => { vi.advanceTimersByTime(1200); }); // FULLSCREEN_EMPTY_GRACE_MS, unchanged
        expect(ctx!.isFullscreen).toBe(false);
    });

    it('a hold that times out closes both, the same way as a real stop', () => {
        act(() => { shareHold.dispatch(SHARER, { type: 'signal', seq: 'a', hasPublication: true }); });
        act(() => { shareHold.dispatch(SHARER, { type: 'unpublished' }); sharer.setShare(false); });
        notify();
        act(() => { vi.advanceTimersByTime(HOLD_TIMEOUT_MS - 1); });
        expect(focus()).not.toBeNull();
        expect(ctx!.isFullscreen).toBe(true);
        act(() => { vi.advanceTimersByTime(1); });
        expect(shareHold.phase(SHARER)).toBe('idle');
        expect(focus()).toBeNull();
        act(() => { vi.advanceTimersByTime(1200); });
        expect(ctx!.isFullscreen).toBe(false);
    });

    it('the publisher leaving mid-hold closes focus at once', () => {
        act(() => { shareHold.dispatch(SHARER, { type: 'signal', seq: 'a', hasPublication: true }); });
        act(() => { shareHold.dispatch(SHARER, { type: 'unpublished' }); sharer.setShare(false); });
        notify();
        act(() => { shareHold.left(SHARER); room.participants = [room.local]; });
        notify();
        expect(focus()).toBeNull();
    });
});
