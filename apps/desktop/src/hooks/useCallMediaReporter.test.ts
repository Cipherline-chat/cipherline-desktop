// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
    decideCallMediaReport,
    useCallMediaReporter,
    CALL_MEDIA_REPORT_DEBOUNCE_MS,
    CALL_MEDIA_JOIN_SETTLE_MS,
    selfMutedForPresence,
    type CallMediaTarget,
} from './useCallMediaReporter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const HUDDLE: CallMediaTarget = { kind: 'huddle', callId: 'call-1' };
const HUDDLE_2: CallMediaTarget = { kind: 'huddle', callId: 'call-2' };
const VOICE: CallMediaTarget = { kind: 'voice', channelId: 'chan-1' };

describe('decideCallMediaReport', () => {
    it('sends nothing when not in a call, and forgets state', () => {
        expect(decideCallMediaReport({ targetKey: 'h:x', camera: true, screen_share: false, muted: false, deafened: false, connCount: 1 },
            { target: null, camera: true, screen_share: true, muted: false, deafened: false, connCount: 1 })).toEqual({ report: null, next: null });
    });

    it('a fresh call with nothing on sends nothing (the server cleared us on join)', () => {
        const r = decideCallMediaReport(null, { target: HUDDLE, camera: false, screen_share: false, muted: false, deafened: false, connCount: 1 });
        expect(r.report).toBeNull();
        expect(r.next).toEqual({ targetKey: 'h:call-1', camera: false, screen_share: false, muted: false, deafened: false, connCount: 1 });
    });

    it('turning something on sends a call_id report for a Calls-channel call', () => {
        const r = decideCallMediaReport(null, { target: HUDDLE, camera: false, screen_share: true, muted: false, deafened: false, connCount: 1 });
        expect(r.report).toEqual({ call_id: 'call-1', camera: false, screen_share: true, muted: false, deafened: false });
    });

    it('a voice channel reports by channel_id', () => {
        const r = decideCallMediaReport(null, { target: VOICE, camera: true, screen_share: false, muted: false, deafened: false, connCount: 1 });
        expect(r.report).toEqual({ channel_id: 'chan-1', camera: true, screen_share: false, muted: false, deafened: false });
    });

    it('no change → no report', () => {
        const prev = { targetKey: 'h:call-1', camera: true, screen_share: false, muted: false, deafened: false, connCount: 1 };
        expect(decideCallMediaReport(prev, { target: HUDDLE, camera: true, screen_share: false, muted: false, deafened: false, connCount: 1 }).report).toBeNull();
    });

    it('a WS reconnect re-asserts the current state even if unchanged (incl. all-off)', () => {
        const prev = { targetKey: 'h:call-1', camera: false, screen_share: false, muted: false, deafened: false, connCount: 1 };
        expect(decideCallMediaReport(prev, { target: HUDDLE, camera: false, screen_share: false, muted: false, deafened: false, connCount: 2 }).report)
            .toEqual({ call_id: 'call-1', camera: false, screen_share: false, muted: false, deafened: false });
    });

    it('moving to another call resets the baseline to nothing-on for the new call', () => {
        const prev = { targetKey: 'h:call-1', camera: true, screen_share: false, muted: false, deafened: false, connCount: 1 };
        expect(decideCallMediaReport(prev, { target: HUDDLE_2, camera: true, screen_share: false, muted: false, deafened: false, connCount: 1 }).report)
            .toEqual({ call_id: 'call-2', camera: true, screen_share: false, muted: false, deafened: false });
    });
});

describe('useCallMediaReporter', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    type P = { target: CallMediaTarget | null; camera: boolean; screenShare: boolean; micOff: boolean; pushToTalk: boolean; deafened: boolean; connCount: number; send: (r: unknown) => boolean };
    const Probe: React.FC<P> = (p) => { useCallMediaReporter(p as never); return null; };

    function mount(p: P) {
        const host = document.createElement('div');
        const root = createRoot(host);
        act(() => root.render(h(Probe, p)));
        return {
            update: (next: P) => act(() => root.render(h(Probe, next))),
            unmount: () => act(() => root.unmount()),
        };
    }

    it('debounces a quick flicker into one report of the final state', () => {
        const send = vi.fn(() => true);
        const base = { target: HUDDLE, camera: false, screenShare: false, micOff: false, pushToTalk: false, deafened: false, connCount: 1, send };
        const m = mount(base);
        m.update({ ...base, camera: true });
        m.update({ ...base, camera: true, screenShare: true });
        act(() => { vi.advanceTimersByTime(CALL_MEDIA_JOIN_SETTLE_MS + 10); });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ call_id: 'call-1', camera: true, screen_share: true, muted: false, deafened: false });
        m.unmount();
    });

    it('does not mark a report as sent when the socket was closed, and retries on reconnect', () => {
        let open = false;
        const send = vi.fn(() => open);
        const base = { target: HUDDLE, camera: true, screenShare: false, micOff: false, pushToTalk: false, deafened: false, connCount: 1, send };
        const m = mount(base);
        act(() => { vi.advanceTimersByTime(CALL_MEDIA_JOIN_SETTLE_MS + 10); });
        expect(send).toHaveBeenCalledTimes(1);
        open = true;
        m.update({ ...base, connCount: 2 });
        // Nothing was ever delivered for this call, so the retry still waits the join settle.
        act(() => { vi.advanceTimersByTime(CALL_MEDIA_JOIN_SETTLE_MS + 10); });
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith({ call_id: 'call-1', camera: true, screen_share: false, muted: false, deafened: false });
        m.unmount();
    });

    it('sends nothing at all while not in a call', () => {
        const send = vi.fn(() => true);
        const m = mount({ target: null, camera: true, screenShare: true, micOff: true, pushToTalk: false, deafened: true, connCount: 1, send });
        act(() => { vi.advanceTimersByTime(CALL_MEDIA_REPORT_DEBOUNCE_MS * 3); });
        expect(send).not.toHaveBeenCalled();
        m.unmount();
    });
});

describe('decideCallMediaReport — muted / deafened', () => {
    const prev = { targetKey: 'h:call-1', camera: false, screen_share: false, muted: false, deafened: false, connCount: 1 };
    const now = { target: HUDDLE, camera: false, screen_share: false, muted: false, deafened: false, connCount: 1 };

    it('a mute-only change is a change and reports all four flags', () => {
        const r = decideCallMediaReport(prev, { ...now, muted: true });
        expect(r.report).toEqual({ call_id: 'call-1', camera: false, screen_share: false, muted: true, deafened: false });
        expect(r.next).toEqual({ ...prev, muted: true });
    });

    it('a deafen-only change is a change (voice channel reports by channel_id)', () => {
        const r = decideCallMediaReport({ ...prev, targetKey: 'v:chan-1' }, { ...now, target: VOICE, deafened: true });
        expect(r.report).toEqual({ channel_id: 'chan-1', camera: false, screen_share: false, muted: false, deafened: true });
    });

    it('a fresh call whose first reading is already muted reports it (the server cleared us on join)', () => {
        expect(decideCallMediaReport(null, { ...now, muted: true }).report)
            .toEqual({ call_id: 'call-1', camera: false, screen_share: false, muted: true, deafened: false });
    });

    it('no change in any of the four flags → no report', () => {
        const p = { ...prev, muted: true, deafened: true };
        expect(decideCallMediaReport(p, { ...now, muted: true, deafened: true }).report).toBeNull();
    });

    it('a reconnect re-asserts a standing mute', () => {
        const p = { ...prev, muted: true };
        expect(decideCallMediaReport(p, { ...now, muted: true, connCount: 2 }).report)
            .toEqual({ call_id: 'call-1', camera: false, screen_share: false, muted: true, deafened: false });
    });
});

describe('selfMutedForPresence — the push-to-talk rule', () => {
    it('outside PTT, a closed mic is a mute (what the in-call MicOff shows)', () => {
        expect(selfMutedForPresence(true, false)).toBe(true);
        expect(selfMutedForPresence(false, false)).toBe(false);
    });
    it('in PTT mode a closed mic is the resting state, never a mute, whatever the key is doing', () => {
        expect(selfMutedForPresence(true, true)).toBe(false);
        expect(selfMutedForPresence(false, true)).toBe(false);
    });
});

describe('useCallMediaReporter — mute / deafen reporting', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    type P = { target: CallMediaTarget | null; camera: boolean; screenShare: boolean; micOff: boolean; pushToTalk: boolean; deafened: boolean; connCount: number; send: (r: unknown) => boolean };
    const Probe: React.FC<P> = (p) => { useCallMediaReporter(p as never); return null; };
    function mount(p: P) {
        const host = document.createElement('div');
        const root = createRoot(host);
        act(() => root.render(h(Probe, p)));
        return { update: (next: P) => act(() => root.render(h(Probe, next))), unmount: () => act(() => root.unmount()) };
    }
    const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
    const mk = (send: (r: unknown) => boolean): P => ({
        target: HUDDLE, camera: false, screenShare: false, micOff: false, pushToTalk: false, deafened: false, connCount: 1, send,
    });
    const FLAGS = { camera: false, screen_share: false };

    it('joining with the mic on sends nothing, even though the mic track reads off until it is published', () => {
        const send = vi.fn(() => true);
        const base = mk(send);
        // Mic not published yet: telemetry says "off" at first...
        const m = mount({ ...base, micOff: true });
        advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 50);
        // ...then LiveKit publishes it, still inside the join settle window.
        m.update({ ...base, micOff: false });
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 50);
        expect(send).not.toHaveBeenCalled();
        m.unmount();
    });

    it('joining pre-muted reports muted once the settle window passes (seeds start correct)', () => {
        const send = vi.fn(() => true);
        const m = mount({ ...mk(send), micOff: true });
        advance(CALL_MEDIA_JOIN_SETTLE_MS - 50);
        expect(send).not.toHaveBeenCalled();
        advance(100);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ call_id: 'call-1', ...FLAGS, muted: true, deafened: false });
        m.unmount();
    });

    it('a mid-call mic toggle reports after the short debounce, and rapid toggles coalesce to one report of the final state', () => {
        const send = vi.fn(() => true);
        const base = mk(send);
        const m = mount(base);
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 10); // join settled, nothing to say
        expect(send).not.toHaveBeenCalled();

        // mute, unmute, mute, unmute, mute inside one debounce window
        for (const off of [true, false, true, false, true]) { m.update({ ...base, micOff: off }); advance(40); }
        advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);

        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ call_id: 'call-1', ...FLAGS, muted: true, deafened: false });
        m.unmount();
    });

    it('a flicker that ends where it started sends nothing', () => {
        const send = vi.fn(() => true);
        const base = mk(send);
        const m = mount(base);
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 10);
        m.update({ ...base, micOff: true }); advance(40);
        m.update({ ...base, micOff: false });
        advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);
        expect(send).not.toHaveBeenCalled();
        m.unmount();
    });

    it('PUSH-TO-TALK: opening and closing the mic on every key press reports nothing', () => {
        const send = vi.fn(() => true);
        const base = { ...mk(send), pushToTalk: true };
        const m = mount({ ...base, micOff: true }); // PTT closes the mic at start
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 10);
        for (let i = 0; i < 6; i++) {
            m.update({ ...base, micOff: false }); advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10); // key down
            m.update({ ...base, micOff: true });  advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10); // key up
        }
        expect(send).not.toHaveBeenCalled();
        m.unmount();
    });

    it('negative control: the same mic flapping OUTSIDE push-to-talk does report every change', () => {
        const send = vi.fn(() => true);
        const base = mk(send);
        const m = mount(base);
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 10);
        for (let i = 0; i < 3; i++) {
            m.update({ ...base, micOff: true });  advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);
            m.update({ ...base, micOff: false }); advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);
        }
        expect(send).toHaveBeenCalledTimes(6);
        m.unmount();
    });

    it('switching PTT on while the mic is open does not fabricate a mute; switching it off with the mic closed does', () => {
        const send = vi.fn(() => true);
        const base = mk(send);
        const m = mount(base);
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 10);
        // PTT turned on: the app closes the mic.
        m.update({ ...base, pushToTalk: true, micOff: true });
        advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);
        expect(send).not.toHaveBeenCalled();
        // PTT turned off but the mic stayed closed (e.g. the user was deafened/muted): now it IS a mute.
        m.update({ ...base, pushToTalk: false, micOff: true });
        advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ call_id: 'call-1', ...FLAGS, muted: true, deafened: false });
        m.unmount();
    });

    it('deafening reports deafened (and muted, outside PTT, since deafen closes the mic); PTT deafen reports deafened only', () => {
        const send = vi.fn(() => true);
        const base = mk(send);
        const m = mount(base);
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 10);
        m.update({ ...base, deafened: true, micOff: true });
        advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);
        expect(send).toHaveBeenLastCalledWith({ call_id: 'call-1', ...FLAGS, muted: true, deafened: true });
        m.unmount();

        const send2 = vi.fn(() => true);
        const ptt = { ...mk(send2), pushToTalk: true };
        const m2 = mount({ ...ptt, micOff: true });
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 10);
        m2.update({ ...ptt, deafened: true, micOff: true });
        advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);
        expect(send2).toHaveBeenLastCalledWith({ call_id: 'call-1', ...FLAGS, muted: false, deafened: true });
        m2.unmount();
    });

    it('a standing mute is re-asserted after a WS reconnect', () => {
        const send = vi.fn(() => true);
        const base = mk(send);
        const m = mount({ ...base, micOff: true });
        advance(CALL_MEDIA_JOIN_SETTLE_MS + 10);
        expect(send).toHaveBeenCalledTimes(1);
        m.update({ ...base, micOff: true, connCount: 2 });
        advance(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith({ call_id: 'call-1', ...FLAGS, muted: true, deafened: false });
        m.unmount();
    });
});
