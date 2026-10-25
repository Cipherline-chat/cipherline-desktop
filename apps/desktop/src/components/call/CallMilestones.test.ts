// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConnectionState, RoomEvent, Track } from 'livekit-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});

// A stand-in room: events, a connection state, and the two screen-share readings.
class FakeRoom {
    state: ConnectionState = ConnectionState.Connected;
    localParticipant = { isScreenShareEnabled: false };
    remoteParticipants = new Map<string, { getTrackPublication: (s: Track.Source) => { isSubscribed: boolean; isMuted: boolean } | undefined }>();
    private h = new Map<string, Set<() => void>>();
    on(e: string, f: () => void) { (this.h.get(e) ?? this.h.set(e, new Set()).get(e)!).add(f); return this; }
    off(e: string, f: () => void) { this.h.get(e)?.delete(f); return this; }
    emit(e: string) { this.h.get(e)?.forEach(f => f()); }
    listenerCount() { return Array.from(this.h.values()).reduce((a, s) => a + s.size, 0); }
}
let room: FakeRoom;
vi.mock('@livekit/components-react', () => ({ useRoomContext: () => room }));

import { CallMilestones, LONG_CALL_COPY, LONG_CALL_CARD_MS, MILESTONE_POLL_MS, inCall } from './CallMilestones';
import { LONG_CALL_MS } from '../../utils/callMilestones';
import { releaseCallOfferSlot, callOfferSlotHolder, acquireCallOfferSlot } from '../../utils/performanceOffer';

let root: Root;
let host: HTMLDivElement;

const mount = () => act(() => { root.render(React.createElement(CallMilestones)); });
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const card = () => document.querySelector('[role="status"]');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.setSystemTime(1_000_000);
    room = new FakeRoom();
    releaseCallOfferSlot('longcall'); releaseCallOfferSlot('gaming'); releaseCallOfferSlot('performance');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('the three-hour card', () => {
    it('is not there at the start, nor at two hours fifty-nine', async () => {
        mount();
        expect(card()).toBeNull();
        await advance(LONG_CALL_MS - 2 * MILESTONE_POLL_MS);
        expect(card()).toBeNull();
    });

    it('appears after three continuous hours, with its copy, and is dismissable', async () => {
        mount();
        await advance(LONG_CALL_MS + MILESTONE_POLL_MS);
        expect(card()?.textContent).toContain('Three hours in. Maybe stretch?');
        expect(LONG_CALL_COPY).toBe('Three hours in. Maybe stretch?');
        const btn = card()!.querySelector('button')!;
        act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(card()).toBeNull();
        expect(callOfferSlotHolder()).toBeNull();
    });

    it('once per call: dismissed, it does not come back', async () => {
        mount();
        await advance(LONG_CALL_MS + MILESTONE_POLL_MS);
        act(() => { card()!.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        await advance(6 * 60 * 60 * 1000);
        expect(card()).toBeNull();
    });

    it('fades by itself after two minutes, and stays gone', async () => {
        mount();
        await advance(LONG_CALL_MS + MILESTONE_POLL_MS);
        expect(card()).not.toBeNull();
        await advance(LONG_CALL_CARD_MS + 100);
        expect(card()).toBeNull();
        await advance(60 * 60 * 1000);
        expect(card()).toBeNull();
    });

    it('is passive: it never takes focus', async () => {
        mount();
        const before = document.activeElement;
        await advance(LONG_CALL_MS + MILESTONE_POLL_MS);
        expect(document.activeElement).toBe(before);
    });

    it('does not count time outside the call: a disconnect restarts the clock', async () => {
        mount();
        await advance(2 * 60 * 60 * 1000);
        room.state = ConnectionState.Disconnected;
        act(() => { room.emit(RoomEvent.ConnectionStateChanged); });
        room.state = ConnectionState.Connected;
        act(() => { room.emit(RoomEvent.ConnectionStateChanged); });
        await advance(2 * 60 * 60 * 1000);
        expect(card()).toBeNull();
        await advance(60 * 60 * 1000 + MILESTONE_POLL_MS);
        expect(card()).not.toBeNull();
    });

    it('waits its turn when another in-call card holds the offer surface, then shows', async () => {
        mount();
        expect(acquireCallOfferSlot('gaming')).toBe(true);
        await advance(LONG_CALL_MS + MILESTONE_POLL_MS);
        expect(card()).toBeNull();
        releaseCallOfferSlot('gaming');
        await advance(6000);
        expect(card()).not.toBeNull();
    });

    it('releases the offer surface when the call ends', async () => {
        mount();
        await advance(LONG_CALL_MS + MILESTONE_POLL_MS);
        expect(callOfferSlotHolder()).toBe('longcall');
        act(() => { root.unmount(); });
        expect(callOfferSlotHolder()).toBeNull();
        root = createRoot(host);
    });
});

describe('plumbing', () => {
    it('stops listening to the room when it unmounts', () => {
        mount();
        expect(room.listenerCount()).toBeGreaterThan(0);
        act(() => { root.unmount(); });
        expect(room.listenerCount()).toBe(0);
        root = createRoot(host);
    });

    it('inCall: connected and reconnecting count, disconnected does not', () => {
        expect(inCall(ConnectionState.Connected)).toBe(true);
        expect(inCall(ConnectionState.Reconnecting)).toBe(true);
        expect(inCall(ConnectionState.SignalReconnecting)).toBe(true);
        expect(inCall(ConnectionState.Disconnected)).toBe(false);
        expect(inCall(ConnectionState.Connecting)).toBe(false);
    });
});
