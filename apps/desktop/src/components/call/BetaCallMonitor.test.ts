// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConnectionState, RoomEvent, Track } from 'livekit-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeRoom {
    state: ConnectionState = ConnectionState.Connected;
    remoteParticipants = new Map<string, unknown>();
    private h = new Map<string, Set<(...a: unknown[]) => void>>();
    on(e: string, f: (...a: unknown[]) => void) { (this.h.get(e) ?? this.h.set(e, new Set()).get(e)!).add(f); return this; }
    off(e: string, f: (...a: unknown[]) => void) { this.h.get(e)?.delete(f); return this; }
    emit(e: string, ...a: unknown[]) { this.h.get(e)?.forEach(f => f(...a)); }
}
let room: FakeRoom;
vi.mock('@livekit/components-react', () => ({ useRoomContext: () => room }));
const reportBeta = vi.fn();
vi.mock('../../utils/betaDiagnostics/reporter', () => ({ isBetaActive: () => true, reportBeta: (...a: unknown[]) => reportBeta(...a) }));
const noteFirstAudio = vi.fn();
vi.mock('../../utils/betaDiagnostics/callSession', () => ({ getActiveCallSummary: () => ({ noteFirstAudio }), noteBetaPeers: () => {} }));

import { BetaCallMonitor, FIRST_AUDIO_SLOW_MS } from './BetaCallMonitor';

let root: Root;
let host: HTMLDivElement;
const mic = { kind: Track.Kind.Audio };
const micPub = { source: Track.Source.Microphone };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    room = new FakeRoom();
    reportBeta.mockReset();
    noteFirstAudio.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root.render(React.createElement(BetaCallMonitor)); });
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    vi.useRealTimers();
});

describe('BetaCallMonitor — time to first audio', () => {
    it('a peer heard within a second is not slow', () => {
        const p = {};
        room.emit(RoomEvent.ParticipantConnected, p);
        vi.setSystemTime(1_000_800);
        room.emit(RoomEvent.TrackSubscribed, mic, micPub, p);
        expect(noteFirstAudio).toHaveBeenCalledWith(800);
        expect(reportBeta).not.toHaveBeenCalled();
    });

    it('a RE-subscription of the same peer minutes later (crash + rejoin, mic republish) is not "first audio slow"', () => {
        const p = {};
        room.emit(RoomEvent.ParticipantConnected, p);
        vi.setSystemTime(1_000_500);
        room.emit(RoomEvent.TrackSubscribed, mic, micPub, p);
        // 4.7 minutes later: the staging.174 call_first_audio_slow {ms: 283616}.
        vi.setSystemTime(1_000_000 + 283_616);
        room.emit(RoomEvent.TrackSubscribed, mic, micPub, p);
        expect(reportBeta).not.toHaveBeenCalled();
        expect(noteFirstAudio).toHaveBeenCalledTimes(1);
    });

    it('a genuinely slow first subscription is still reported', () => {
        const p = {};
        room.emit(RoomEvent.ParticipantConnected, p);
        vi.setSystemTime(1_000_000 + FIRST_AUDIO_SLOW_MS + 1000);
        room.emit(RoomEvent.TrackSubscribed, mic, micPub, p);
        expect(reportBeta).toHaveBeenCalledWith('call_first_audio_slow', { ms: FIRST_AUDIO_SLOW_MS + 1000 });
    });
});

describe('BetaCallMonitor: one-way audio, inbound', () => {
    const report = (stats: Array<Record<string, unknown>>) => ({ forEach: (cb: (s: Record<string, unknown>) => void) => stats.forEach(cb) });
    /** A remote peer with a mic whose RTP counter `packets()` reads, optionally a camera whose counter is `cam()`. */
    function addPeer(opts: { packets: () => number; muted?: () => boolean; speaking?: () => boolean; cam?: () => number }) {
        const micTrack = { getRTCStatsReport: async () => report([{ type: 'inbound-rtp', kind: 'audio', packetsReceived: opts.packets() }]) };
        const micPublication = { isSubscribed: true, get isMuted() { return opts.muted?.() ?? false; }, track: micTrack };
        const pubs = new Map<string, unknown>();
        if (opts.cam) pubs.set('cam', { isSubscribed: true, track: { getRTCStatsReport: async () => report([{ type: 'inbound-rtp', kind: 'video', packetsReceived: opts.cam!() }]) } });
        const p = {
            get isSpeaking() { return opts.speaking?.() ?? false; },
            getTrackPublication: () => micPublication,
            trackPublications: pubs,
        };
        room.remoteParticipants.set('peer', p);
        return p;
    }
    const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    it('an unmuted mic whose packets stop for 15 s reports once, with the leg booleans', async () => {
        let packets = 100;
        let cam = 5000;
        addPeer({ packets: () => packets, cam: () => cam });
        for (let i = 0; i < 4; i++) { packets += 250; cam += 40; await tick(5000); } // healthy for 20 s
        expect(reportBeta).not.toHaveBeenCalledWith('call_one_way_audio', expect.anything());
        for (let i = 0; i < 4; i++) { cam += 40; await tick(5000); } // mic stops, the camera keeps arriving
        const calls = reportBeta.mock.calls.filter(c => c[0] === 'call_one_way_audio');
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toEqual({ direction: 'in', cause: 'rtp_flat', sfu_hears: false, other_flowing: true });
        await tick(60_000);
        expect(reportBeta.mock.calls.filter(c => c[0] === 'call_one_way_audio')).toHaveLength(1);
    });

    it('a muted publisher is never a stall', async () => {
        addPeer({ packets: () => 7, muted: () => true });
        await tick(120_000);
        expect(reportBeta).not.toHaveBeenCalledWith('call_one_way_audio', expect.anything());
    });

    it('a machine that slept (timers frozen for an hour) does not report a stall on wake', async () => {
        let packets = 500;
        addPeer({ packets: () => packets });
        packets += 100; await tick(5000);
        packets += 100; await tick(5000);
        // Lid closed: no timer fires, no packets are counted; the clock jumps an hour.
        vi.setSystemTime(Date.now() + 3_600_000);
        await tick(5000); // first poll after wake sees the same counter
        expect(reportBeta).not.toHaveBeenCalledWith('call_one_way_audio', expect.anything());
        // Packets resume (the SFU is still sending): still nothing.
        packets += 100; await tick(5000);
        expect(reportBeta).not.toHaveBeenCalledWith('call_one_way_audio', expect.anything());
    });
});
