// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EventEmitter } from 'events';
import { Track } from 'livekit-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Mocks ────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({ room: null as unknown, store: new Map<string, string>(), toasts: [] as unknown[] }));
vi.mock('@livekit/components-react', () => ({ useRoomContext: () => h.room }));
vi.mock('../../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => h.store.get(k) ?? null,
        setItem: (k: string, v: string) => { h.store.set(k, v); },
    },
}));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ push: (t: unknown) => h.toasts.push(t), dismiss: () => {} }) }));
vi.mock('../cl', () => ({
    ClButton: ({ children, onClick, disabled, tooltip }: { children?: React.ReactNode; onClick?: () => void; disabled?: boolean; tooltip?: string }) =>
        React.createElement('button', { onClick, disabled, 'aria-label': tooltip }, children),
}));

import { GamingVideoGuard } from './GamingVideoGuard';
import { sampleCallVideo } from '../../utils/callVideoSampling';
import { __resetGamingVideoModeForTests, setGamingVideoMode } from '../../utils/gamingVideoMode';
import { GAMING_VIDEO_OFFER_KEY } from '../../utils/gamingVideoOffer';
import { acquireCallOfferSlot, releaseCallOfferSlot, callOfferSlotHolder, __resetCallOfferSlotForTests } from '../../utils/performanceOffer';
import { getReportRequest, closeReportProblem } from '../../utils/diagnostics/reportRequest';

// ── A fake LiveKit room: one local camera, one remote camera ──────────────
function statsMap(...stats: Array<Record<string, unknown>>) {
    return new Map(stats.map((s, i) => [String(i), s]));
}

function makeRoom() {
    const counters = { camSent: 0, remoteDecoded: 0, remoteBytes: 0, advanceCam: true, advanceRemote: true };
    const camTrack = {
        kind: Track.Kind.Video,
        mediaStreamTrack: { readyState: 'live' },
        degradationPreference: 'balanced' as RTCDegradationPreference,
        prefCalls: [] as RTCDegradationPreference[],
        setDegradationPreference(p: RTCDegradationPreference) { this.prefCalls.push(p); this.degradationPreference = p; return Promise.resolve(); },
        getRTCStatsReport: vi.fn(async () => {
            if (counters.advanceCam) counters.camSent += 30;
            return statsMap({ type: 'outbound-rtp', kind: 'video', framesSent: counters.camSent, qualityLimitationReason: 'cpu' });
        }),
    };
    const camPub = { source: Track.Source.Camera, trackSid: 'TR_cam', isMuted: false, track: camTrack };
    const remoteTrack = {
        kind: Track.Kind.Video,
        streamState: Track.StreamState.Active,
        mediaStreamTrack: { readyState: 'live' },
        getRTCStatsReport: vi.fn(async () => {
            if (counters.advanceRemote) counters.remoteDecoded += 30;
            counters.remoteBytes += 100_000;
            return statsMap({
                type: 'inbound-rtp', kind: 'video', framesDecoded: counters.remoteDecoded,
                bytesReceived: counters.remoteBytes, packetsReceived: counters.remoteBytes / 1000, packetsLost: 0,
            });
        }),
    };
    const remotePub = { source: Track.Source.Camera, trackSid: 'TR_r', isSubscribed: true, isEnabled: true, isMuted: false, track: remoteTrack };
    const room = Object.assign(new EventEmitter(), {
        localParticipant: {
            videoTrackPublications: new Map([['TR_cam', camPub]]),
            getTrackPublication: (s: Track.Source) => (s === Track.Source.Camera ? camPub : undefined),
        },
        remoteParticipants: new Map([['p1', { videoTrackPublications: new Map([['TR_r', remotePub]]) }]]),
    });
    return { room, camTrack, camPub, remoteTrack, remotePub, counters };
}

// ── electronAPI bridge ───────────────────────────────────────────────────
let savedMode = false;
const winCbs: Record<string, Array<() => void>> = {};
const on = (name: string) => (cb: () => void) => { (winCbs[name] ||= []).push(cb); return () => { winCbs[name] = winCbs[name].filter(c => c !== cb); }; };
const fire = (name: string) => act(() => { for (const cb of winCbs[name] ?? []) cb(); });
let api: Record<string, ReturnType<typeof vi.fn> | ((cb: () => void) => () => void)>;

function installApi() {
    const reply = () => ({
        platform: 'win32',
        saved: { screenCapturer: 'auto', captureLog: false, gamingVideo: savedMode },
        active: { screenCapturer: 'auto', captureLog: false, gamingVideo: false },
        envOverride: {},
    });
    api = {
        getStartupFlags: vi.fn(async () => reply()),
        setStartupFlags: vi.fn(async (p: { gamingVideo: boolean }) => { savedMode = p.gamingVideo; return reply(); }),
        setCallMediaActive: vi.fn(async () => {}),
        onWindowFocus: on('focus'),
        onWindowMinimize: on('minimize'),
        onWindowHide: on('hide'),
        onGameDetected: on('game'),
        onGameStopped: on('gameStopped'),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
}

let root: Root | null = null;
let container: HTMLDivElement;
async function mount() {
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => { root!.render(React.createElement(GamingVideoGuard)); });
    await act(async () => { await Promise.resolve(); });
}
async function unmount() {
    await act(async () => { root?.unmount(); });
    root = null;
}
const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const offerText = () => document.body.textContent ?? '';
const clickButton = (label: string) => act(() => {
    const b = [...document.body.querySelectorAll('button')].find(x => x.textContent === label || x.getAttribute('aria-label') === label);
    if (!b) throw new Error(`no button ${label}`);
    (b as HTMLButtonElement).click();
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    savedMode = false;
    h.store.clear();
    h.toasts.length = 0;
    for (const k of Object.keys(winCbs)) delete winCbs[k];
    __resetGamingVideoModeForTests();
    __resetCallOfferSlotForTests();
    closeReportProblem();
    installApi();
});
afterEach(async () => {
    await unmount();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('GamingVideoGuard — call signal to main', () => {
    it('tells main a call started on mount and ended on unmount', async () => {
        h.room = makeRoom().room;
        await mount();
        expect(api.setCallMediaActive).toHaveBeenCalledWith(true);
        await unmount();
        expect(api.setCallMediaActive).toHaveBeenLastCalledWith(false);
    });
});

describe('GamingVideoGuard — camera degradation follows the mode', () => {
    it('mode ON: maintain-framerate while in the call, restored at call end', async () => {
        savedMode = true;
        const r = makeRoom();
        h.room = r.room;
        await mount();
        expect(r.camTrack.degradationPreference).toBe('maintain-framerate');
        await unmount();
        expect(r.camTrack.degradationPreference).toBe('balanced');
    });

    it('turning the mode off mid-call restores it at once; on again re-applies', async () => {
        savedMode = true;
        const r = makeRoom();
        h.room = r.room;
        await mount();
        await act(async () => { await setGamingVideoMode(false); });
        expect(r.camTrack.degradationPreference).toBe('balanced');
        await act(async () => { await setGamingVideoMode(true); });
        expect(r.camTrack.degradationPreference).toBe('maintain-framerate');
    });

    it('mode OFF: the camera is never touched', async () => {
        const r = makeRoom();
        h.room = r.room;
        await mount();
        await unmount();
        expect(r.camTrack.prefCalls).toEqual([]);
    });

    it('re-applies when the camera is republished', async () => {
        savedMode = true;
        const r = makeRoom();
        h.room = r.room;
        await mount();
        r.camTrack.degradationPreference = 'balanced'; // a fresh publish
        await act(async () => { r.room.emit('localTrackPublished', r.camPub); });
        expect(r.camTrack.degradationPreference).toBe('maintain-framerate');
    });
});

describe('GamingVideoGuard — integration with the webcam make-before-break republish', () => {
    it('applies to the NEW camera track even while the old publication is still first', async () => {
        savedMode = true;
        const r = makeRoom();
        h.room = r.room;
        await mount();
        expect(r.camTrack.degradationPreference).toBe('maintain-framerate');
        // cameraPublish.republishCamera: a second camera publication with a
        // fresh track; getTrackPublication(Camera) still returns the OLD one.
        const fresh = { ...r.camTrack, degradationPreference: 'balanced' as RTCDegradationPreference, prefCalls: [] as RTCDegradationPreference[] };
        fresh.setDegradationPreference = function (p: RTCDegradationPreference) { this.prefCalls.push(p); this.degradationPreference = p; return Promise.resolve(); };
        const freshPub = { ...r.camPub, trackSid: 'TR_cam2', track: fresh };
        await act(async () => { r.room.emit('localTrackPublished', freshPub); });
        expect(fresh.degradationPreference).toBe('maintain-framerate');
        await unmount();
        expect(fresh.degradationPreference).toBe('balanced');
    });
});

describe('GamingVideoGuard — freeze detection and the one-time offer', () => {
    async function backgroundedCallWithFrozenRemote() {
        const r = makeRoom();
        h.room = r.room;
        await mount();
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        await tick(); await tick(); // remote decoding normally
        r.counters.advanceRemote = false; // bytes still arrive, nothing decodes
        return r;
    }

    it('in the FOREGROUND nothing is sampled at all', async () => {
        const r = makeRoom();
        h.room = r.room;
        await mount();
        fire('focus');
        await tick(5000);
        expect(r.remoteTrack.getRTCStatsReport).not.toHaveBeenCalled();
        expect(r.camTrack.getRTCStatsReport).not.toHaveBeenCalled();
    });

    it('a real freeze while in the background shows the offer once; "Not now" snoozes it for a day', async () => {
        const r = await backgroundedCallWithFrozenRemote();
        expect(offerText()).not.toContain('Video froze');
        await tick(); await tick(); await tick(); await tick();
        expect(offerText()).toContain('Video froze while Cipherline was in the background');
        expect(offerText()).toContain('may lower your game’s FPS');
        await clickButton('Not now');
        expect(offerText()).not.toContain('Video froze');
        const saved = JSON.parse(h.store.get(GAMING_VIDEO_OFFER_KEY)!);
        expect(saved.never).toBe(false);
        expect(saved.snoozedUntil).toBeGreaterThan(Date.now());
        // Same call, another freeze: no second offer.
        r.counters.advanceRemote = true;
        await tick(); await tick();
        r.counters.advanceRemote = false;
        await tick(5000);
        expect(offerText()).not.toContain('Video froze');
    });

    it('names gaming only when the game detector has reported a game', async () => {
        const r = makeRoom();
        h.room = r.room;
        await mount();
        fire('game');
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        await tick(); await tick();
        r.counters.advanceCam = false;
        await tick(5000);
        expect(offerText()).toContain('Video froze while you were gaming');
    });

    it('"Turn on" saves the mode through main and confirms; the camera then switches over', async () => {
        const r = await backgroundedCallWithFrozenRemote();
        await tick(5000);
        await clickButton('Turn on');
        await act(async () => { await Promise.resolve(); });
        expect(api.setStartupFlags).toHaveBeenCalledWith({ gamingVideo: true });
        expect(offerText()).not.toContain('Video froze');
        expect(h.toasts).toHaveLength(1);
        expect(r.camTrack.degradationPreference).toBe('maintain-framerate');
    });

    it('"Don\'t ask again" is remembered across calls', async () => {
        await backgroundedCallWithFrozenRemote();
        await tick(5000);
        await clickButton('Don’t ask again');
        expect(JSON.parse(h.store.get(GAMING_VIDEO_OFFER_KEY)!).never).toBe(true);
        await unmount();
        // A new call, same freeze: sampling never even starts.
        const r2 = makeRoom();
        h.room = r2.room;
        await mount();
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        await tick(8000);
        expect(r2.remoteTrack.getRTCStatsReport).not.toHaveBeenCalled();
        expect(offerText()).not.toContain('Video froze');
    });

    it('a snoozed offer stays away in the next call', async () => {
        h.store.set(GAMING_VIDEO_OFFER_KEY, JSON.stringify({ snoozedUntil: Date.now() + 60_000, never: false }));
        await backgroundedCallWithFrozenRemote();
        await tick(8000);
        expect(offerText()).not.toContain('Video froze');
    });

    it('a remote stream paused at the SFU (no bytes, disabled) never triggers it', async () => {
        const r = makeRoom();
        h.room = r.room;
        await mount();
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        await tick(); await tick();
        r.remotePub.isEnabled = false;
        r.counters.advanceRemote = false;
        await tick(8000);
        expect(offerText()).not.toContain('Video froze');
    });

    it('never samples or offers while the mode is already on', async () => {
        savedMode = true;
        const r = makeRoom();
        h.room = r.room;
        await mount();
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        r.counters.advanceRemote = false;
        await tick(8000);
        expect(r.remoteTrack.getRTCStatsReport).not.toHaveBeenCalled();
        expect(offerText()).not.toContain('Video froze');
    });
});

describe('GamingVideoGuard — shared offer slot and the issue reporter', () => {
    async function frozen() {
        const r = makeRoom();
        h.room = r.room;
        await mount();
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        await tick(); await tick();
        r.counters.advanceRemote = false;
        return r;
    }

    it('waits while another in-call offer holds the slot, then shows and holds it itself', async () => {
        expect(acquireCallOfferSlot('perf')).toBe(true);
        await frozen();
        await tick(5000);
        expect(offerText()).not.toContain('Video froze');
        releaseCallOfferSlot('perf');
        await tick(2000);
        expect(offerText()).toContain('Video froze');
        expect(callOfferSlotHolder()).toBe('gaming');
        await clickButton('Not now');
        expect(callOfferSlotHolder()).toBeNull();
    });

    it('releases the slot when the call ends with the card open', async () => {
        await frozen();
        await tick(5000);
        expect(callOfferSlotHolder()).toBe('gaming');
        await unmount();
        expect(callOfferSlotHolder()).toBeNull();
    });

    it('"Report this freeze" opens the reporter on Performance, closes the card, writes no snooze', async () => {
        await frozen();
        await tick(5000);
        await clickButton('Report this freeze');
        expect(getReportRequest()).toMatchObject({ category: 'performance', trigger: 'freeze_offer' });
        expect(offerText()).not.toContain('Video froze');
        expect(h.store.get(GAMING_VIDEO_OFFER_KEY)).toBeUndefined();
        expect(callOfferSlotHolder()).toBeNull();
    });
});

describe('sampleCallVideo', () => {
    it('marks muted / paused / ended streams ineligible without fetching their stats', async () => {
        const r = makeRoom();
        r.camPub.isMuted = true;
        r.remoteTrack.streamState = Track.StreamState.Paused;
        const s = await sampleCallVideo(r.room as never);
        expect(s.map(x => [x.key, x.eligible])).toEqual([['out:TR_cam', false], ['in:TR_r', false]]);
        expect(r.camTrack.getRTCStatsReport).not.toHaveBeenCalled();
        expect(r.remoteTrack.getRTCStatsReport).not.toHaveBeenCalled();
    });

    it('reads live streams', async () => {
        const r = makeRoom();
        const s = await sampleCallVideo(r.room as never);
        expect(s).toEqual([
            { direction: 'out', key: 'out:TR_cam', kind: 'camera', eligible: true, framesSent: 30, bandwidthLimited: false },
            { direction: 'in', key: 'in:TR_r', kind: 'camera', eligible: true, framesDecoded: 30, bytesReceived: 100_000, packetsReceived: 100, packetsLost: 0 },
        ]);
    });
});
