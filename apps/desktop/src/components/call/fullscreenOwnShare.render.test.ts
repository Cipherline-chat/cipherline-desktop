// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Track } from 'livekit-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Your own share in the cinema view, and one video filling the screen. The REAL
 * FullscreenOverlay, LocalScreenShareTile, CallProvider and escape stack; only the
 * tile's picture and LiveKit's React hooks are stood in for. The stand-in tile
 * exposes the two menu callbacks the real one wires to its right-click menu.
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
    VideoTile: (props: { p: { identity: string }; source: string; isFilled?: boolean; onToggleFill?: () => void; onHideScreenShareChange?: (v: boolean) => void }) =>
        React.createElement('button', {
            'data-tile': `${props.p.identity}:${props.source}`,
            'data-filled': String(!!props.isFilled),
            onClick: props.onToggleFill,
            onContextMenu: () => props.onHideScreenShareChange?.(true),
        }),
}));
vi.mock('./ScreenShareGate', () => ({
    ScreenShareGate: (props: { p: { identity: string } }) => React.createElement('div', { 'data-gate': props.p.identity }),
}));
vi.mock('./ParticipantCard', () => ({
    ParticipantCard: (props: { p: { identity: string } }) => React.createElement('div', { 'data-card': props.p.identity }),
}));
vi.mock('../EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
vi.mock('../../hooks/useOsWindowFullscreen', () => ({ useOsWindowFullscreen: () => false, OS_WINDOW_FULLSCREEN_QUERY: '(display-mode: fullscreen)' }));
vi.mock('../../utils/secureLocalStore', () => ({ default: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));

import { CallProvider, useCallContext } from '../../contexts/CallContext';
import { FullscreenOverlay } from './FullscreenOverlay';
import { SHARE_REPUBLISH_ATTR, shareHold } from '../../utils/shareHold';

const ME = 'me';
const CAM = Track.Source.Camera;
const SS = Track.Source.ScreenShare;
const OWN_SHARE = `${ME}:${SS}`;
const AMY_CAM = `amy:${CAM}`;

const makeLocal = () => ({
    identity: ME, name: 'Me', isLocal: true, metadata: '', attributes: {} as Record<string, string>,
    isCameraEnabled: false,
    isScreenShareEnabled: true,
    setAttributes: vi.fn(),
    publishTrack: vi.fn(),
    unpublishTrack: vi.fn(),
    setScreenShareEnabled: vi.fn(),
    getTrackPublication: () => undefined,
});
const makeRemote = (identity: string) => {
    const pub = { isSubscribed: true, isMuted: false, track: {} };
    let cam = true;
    return {
        identity, name: identity, isLocal: false, metadata: '', attributes: {},
        getTrackPublication: (s: Track.Source) => (s === CAM && cam ? pub : undefined),
        setCamera(on: boolean) { cam = on; },
    };
};

let ctx: ReturnType<typeof useCallContext> | null = null;
// eslint-disable-next-line react-hooks/globals -- test probe: exposes the live context value to the test body
const Probe: React.FC = () => { ctx = useCallContext(); return null; };

const EMPTY = new Set<string>();
/** The one piece of SidebarConference these tests need: the hide state itself. */
const Surface: React.FC = () => {
    const [hidden, setHidden] = React.useState<Set<string>>(new Set());
    const onHide = (id: string, hide: boolean) => setHidden(prev => {
        const next = new Set(prev);
        if (hide) next.add(id); else next.delete(id);
        return next;
    });
    return React.createElement(FullscreenOverlay as unknown as React.FC<Record<string, unknown>>, {
        token: 't', isLocalDeafened: false, localMutedParticipantIds: EMPTY, onToggleLocalMute: () => {},
        hiddenVideoIds: EMPTY, hiddenScreenShareIds: hidden, onHideVideoChange: () => {}, onHideScreenShareChange: onHide,
        subscribedScreenshares: EMPTY, onSubscribeScreenshare: () => {},
    });
};

let rootEl: HTMLElement;
let root: Root;
let local: ReturnType<typeof makeLocal>;
let amy: ReturnType<typeof makeRemote>;

const tile = (id: string) => document.querySelector(`[data-tile="${id}"]`) as HTMLElement | null;
const paused = () => (document.body.textContent ?? '').includes('Preview paused');
const fire = (el: HTMLElement, type: 'click' | 'contextmenu') => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); });
const pressEscape = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
const refreshRoster = () => act(() => { room.listeners.forEach(fn => fn()); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

/** Stand-ins for the HTML fullscreen API, which jsdom does not implement. */
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;
function setFullscreenElement(el: Element | null) {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
}

beforeEach(async () => {
    vi.useFakeTimers();
    shareHold.reset();
    ctx = null;
    local = makeLocal();
    amy = makeRemote('amy');
    room.local = local;
    room.participants = [local, amy];
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    setFullscreenElement(null);
    requestFullscreen = vi.fn(() => { setFullscreenElement(document.documentElement); return Promise.resolve(); });
    exitFullscreen = vi.fn(() => { setFullscreenElement(null); return Promise.resolve(); });
    (document.documentElement as unknown as { requestFullscreen: unknown }).requestFullscreen = requestFullscreen;
    (document as unknown as { exitFullscreen: unknown }).exitFullscreen = exitFullscreen;
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    root = createRoot(rootEl);
    await act(async () => {
        root.render(React.createElement(CallProvider, null, React.createElement(Probe), React.createElement(Surface)));
    });
    await act(async () => { ctx!.setIsFullscreen(true); });
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    rootEl.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('your own share in fullscreen', () => {
    it('is a tile while you share, and is not one when you are not', async () => {
        expect(tile(OWN_SHARE)).not.toBeNull();
        local.isScreenShareEnabled = false;
        refreshRoster();
        expect(tile(OWN_SHARE)).toBeNull();
    });

    it('showing it publishes nothing and changes nothing on the participant', () => {
        expect(tile(OWN_SHARE)).not.toBeNull();
        expect(local.publishTrack).not.toHaveBeenCalled();
        expect(local.unpublishTrack).not.toHaveBeenCalled();
        expect(local.setScreenShareEnabled).not.toHaveBeenCalled();
        expect(local.setAttributes).not.toHaveBeenCalled();
    });

    it('keeps its place across your own announced republish, alone on the stage, without closing fullscreen', () => {
        room.participants = [local];
        local.attributes[SHARE_REPUBLISH_ATTR] = 'seq-1';
        local.isScreenShareEnabled = false;
        refreshRoster();
        advance(5000);
        expect(tile(OWN_SHARE)).not.toBeNull();
        expect(ctx!.isFullscreen).toBe(true);
    });

    it('a real stop with nothing else up closes fullscreen, as for any last video', () => {
        room.participants = [local];
        local.isScreenShareEnabled = false;
        refreshRoster();
        advance(1300);
        expect(ctx!.isFullscreen).toBe(false);
    });

    it('hide takes the tile off and publishes nothing; your card takes its place', () => {
        fire(tile(OWN_SHARE)!, 'contextmenu');
        expect(tile(OWN_SHARE)).toBeNull();
        expect(document.querySelector(`[data-card="${ME}"]`)).not.toBeNull();
        expect(local.unpublishTrack).not.toHaveBeenCalled();
        expect(local.setScreenShareEnabled).not.toHaveBeenCalled();
    });

    it('hiding your only tile closes fullscreen through the empty-stage path', () => {
        room.participants = [local];
        refreshRoster();
        fire(tile(OWN_SHARE)!, 'contextmenu');
        advance(1300);
        expect(ctx!.isFullscreen).toBe(false);
    });

    it('clicking out of Cipherline swaps in the paused placeholder and the layout does not move', () => {
        room.participants = [local];
        refreshRoster();
        act(() => { window.dispatchEvent(new Event('blur')); });
        expect(paused()).toBe(true);
        expect(tile(OWN_SHARE)).toBeNull();
        // Still on the stage: fullscreen must survive alt-tabbing with this as the only picture.
        advance(5000);
        expect(ctx!.isFullscreen).toBe(true);
        act(() => { window.dispatchEvent(new Event('focus')); });
        expect(paused()).toBe(false);
        expect(tile(OWN_SHARE)).not.toBeNull();
    });

    it('someone else\'s video is not paused by clicking out', () => {
        act(() => { window.dispatchEvent(new Event('blur')); });
        expect(tile(AMY_CAM)).not.toBeNull();
    });
});

describe('one video filling the screen', () => {
    const fill = async (id: string) => { await act(async () => { tile(id)!.click(); }); };
    const filled = (id: string) => tile(id)?.dataset.filled === 'true';

    it('shows only that tile, with no strip and no title strip', async () => {
        await act(async () => { ctx!.setFocusedStream({ identity: 'amy', source: CAM }); });
        expect(document.querySelector('[aria-label="Call participants"]')).not.toBeNull();
        expect(document.querySelector('.cl-fs-titlestrip')).not.toBeNull();
        await fill(AMY_CAM);
        expect(filled(AMY_CAM)).toBe(true);
        expect(tile(OWN_SHARE)).toBeNull();
        expect(document.querySelector('[aria-label="Call participants"]')).toBeNull();
        expect(document.querySelector('.cl-fs-titlestrip')).toBeNull();
    });

    it('works on your own share too', async () => {
        await fill(OWN_SHARE);
        expect(filled(OWN_SHARE)).toBe(true);
        expect(tile(AMY_CAM)).toBeNull();
    });

    it('the same menu item returns to the layout you had', async () => {
        await fill(AMY_CAM);
        await fill(AMY_CAM);
        expect(filled(AMY_CAM)).toBe(false);
        expect(tile(OWN_SHARE)).not.toBeNull();
        expect(ctx!.isFullscreen).toBe(true);
    });

    it('Escape steps back one level, then a second press leaves fullscreen', async () => {
        await act(async () => { ctx!.setFocusedStream({ identity: ME, source: SS }); });
        await fill(AMY_CAM);
        expect(filled(AMY_CAM)).toBe(true);
        pressEscape();
        expect(ctx!.isFullscreen).toBe(true);
        expect(filled(AMY_CAM)).toBe(false);
        // The focus underneath was never touched.
        expect(ctx!.focusedStream).toEqual({ identity: ME, source: SS });
        expect(document.querySelector('[aria-label="Call participants"]')).not.toBeNull();
        pressEscape();
        expect(ctx!.isFullscreen).toBe(false);
    });

    it('moves focus to the stage on the way in and on the way out', async () => {
        await fill(AMY_CAM);
        const stage = document.querySelector('.cl-fs-fill') as HTMLElement;
        expect(document.activeElement).toBe(stage);
        pressEscape();
        expect(document.activeElement).toBe(stage);
        expect(stage.classList.contains('cl-fs-fill')).toBe(false);
    });

    it('takes the OS window fullscreen and gives it back when the fill ends', async () => {
        expect(requestFullscreen).not.toHaveBeenCalled();
        await fill(AMY_CAM);
        expect(requestFullscreen).toHaveBeenCalledTimes(1);
        expect(exitFullscreen).not.toHaveBeenCalled();
        await fill(AMY_CAM);
        expect(exitFullscreen).toHaveBeenCalledTimes(1);
    });

    it('the browser taking Escape in OS fullscreen is the same one step: fullscreen stays, the fill goes', async () => {
        await fill(AMY_CAM);
        await act(async () => { await Promise.resolve(); });
        await act(async () => {
            setFullscreenElement(null);
            document.dispatchEvent(new Event('fullscreenchange'));
        });
        expect(filled(AMY_CAM)).toBe(false);
        expect(ctx!.isFullscreen).toBe(true);
    });

    it('leaves a window that was already fullscreen alone, in and out', async () => {
        window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as never;
        await fill(AMY_CAM);
        expect(requestFullscreen).not.toHaveBeenCalled();
        pressEscape();
        expect(exitFullscreen).not.toHaveBeenCalled();
        expect(ctx!.isFullscreen).toBe(true);
    });

    it('still fills inside the window when the OS refuses', async () => {
        requestFullscreen.mockImplementation(() => Promise.reject(new Error('denied')));
        await fill(AMY_CAM);
        await act(async () => { await Promise.resolve(); });
        expect(filled(AMY_CAM)).toBe(true);
    });

    it('leaving fullscreen forgets the fill and gives the window back', async () => {
        await fill(AMY_CAM);
        await act(async () => { ctx!.setIsFullscreen(false); });
        expect(exitFullscreen).toHaveBeenCalledTimes(1);
        await act(async () => { ctx!.setIsFullscreen(true); });
        expect(filled(AMY_CAM)).toBe(false);
    });

    it('survives its stream dropping and coming back inside the grace', async () => {
        await fill(AMY_CAM);
        amy.setCamera(false);
        refreshRoster();
        advance(800);
        expect(filled(AMY_CAM)).toBe(true);
        amy.setCamera(true);
        refreshRoster();
        advance(5000);
        expect(filled(AMY_CAM)).toBe(true);
    });

    it('steps back when the stream really ends', async () => {
        await fill(AMY_CAM);
        amy.setCamera(false);
        refreshRoster();
        advance(1300);
        expect(tile(AMY_CAM)).toBeNull();
        expect(tile(OWN_SHARE)).not.toBeNull();
        expect(ctx!.isFullscreen).toBe(true);
    });

    it('waits longer while the publisher has said a republish is coming', async () => {
        await fill(AMY_CAM);
        amy.setCamera(false);
        refreshRoster();
        act(() => { ctx!.markAdjusting('amy', 2000); });
        advance(1300);
        expect(filled(AMY_CAM)).toBe(true);
        advance(2500);
        expect(tile(AMY_CAM)).toBeNull();
    });

    it('steps back at once when they leave the call, with no crash on the missing participant', async () => {
        await fill(AMY_CAM);
        room.participants = [local];
        refreshRoster();
        expect(tile(AMY_CAM)).toBeNull();
        expect(tile(OWN_SHARE)).not.toBeNull();
        advance(10);
        expect(ctx!.isFullscreen).toBe(true);
    });

    it('hiding your own share while it fills the screen ends the fill', async () => {
        await fill(OWN_SHARE);
        fire(tile(OWN_SHARE)!, 'contextmenu');
        expect(tile(OWN_SHARE)).toBeNull();
        expect(tile(AMY_CAM)?.dataset.filled).toBe('false');
    });

    it('your own share filling the screen and going to the background shows the placeholder, still filling', async () => {
        await fill(OWN_SHARE);
        act(() => { window.dispatchEvent(new Event('blur')); });
        expect(paused()).toBe(true);
        expect(document.querySelector('.cl-fs-fill')).not.toBeNull();
        act(() => { window.dispatchEvent(new Event('focus')); });
        expect(filled(OWN_SHARE)).toBe(true);
    });
});
