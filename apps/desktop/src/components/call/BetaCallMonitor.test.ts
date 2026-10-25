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
