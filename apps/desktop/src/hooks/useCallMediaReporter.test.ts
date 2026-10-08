// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
    decideCallMediaReport,
    useCallMediaReporter,
    CALL_MEDIA_REPORT_DEBOUNCE_MS,
    type CallMediaTarget,
} from './useCallMediaReporter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const HUDDLE: CallMediaTarget = { kind: 'huddle', callId: 'call-1' };
const HUDDLE_2: CallMediaTarget = { kind: 'huddle', callId: 'call-2' };
const VOICE: CallMediaTarget = { kind: 'voice', channelId: 'chan-1' };

describe('decideCallMediaReport', () => {
    it('sends nothing when not in a call, and forgets state', () => {
        expect(decideCallMediaReport({ targetKey: 'h:x', camera: true, screen_share: false, connCount: 1 },
            { target: null, camera: true, screen_share: true, connCount: 1 })).toEqual({ report: null, next: null });
    });

    it('a fresh call with nothing on sends nothing (the server cleared us on join)', () => {
        const r = decideCallMediaReport(null, { target: HUDDLE, camera: false, screen_share: false, connCount: 1 });
        expect(r.report).toBeNull();
        expect(r.next).toEqual({ targetKey: 'h:call-1', camera: false, screen_share: false, connCount: 1 });
    });

    it('turning something on sends a call_id report for a Calls-channel call', () => {
        const r = decideCallMediaReport(null, { target: HUDDLE, camera: false, screen_share: true, connCount: 1 });
        expect(r.report).toEqual({ call_id: 'call-1', camera: false, screen_share: true });
    });

    it('a voice channel reports by channel_id', () => {
        const r = decideCallMediaReport(null, { target: VOICE, camera: true, screen_share: false, connCount: 1 });
        expect(r.report).toEqual({ channel_id: 'chan-1', camera: true, screen_share: false });
    });

    it('no change → no report', () => {
        const prev = { targetKey: 'h:call-1', camera: true, screen_share: false, connCount: 1 };
        expect(decideCallMediaReport(prev, { target: HUDDLE, camera: true, screen_share: false, connCount: 1 }).report).toBeNull();
    });

    it('a WS reconnect re-asserts the current state even if unchanged (incl. all-off)', () => {
        const prev = { targetKey: 'h:call-1', camera: false, screen_share: false, connCount: 1 };
        expect(decideCallMediaReport(prev, { target: HUDDLE, camera: false, screen_share: false, connCount: 2 }).report)
            .toEqual({ call_id: 'call-1', camera: false, screen_share: false });
    });

    it('moving to another call resets the baseline to nothing-on for the new call', () => {
        const prev = { targetKey: 'h:call-1', camera: true, screen_share: false, connCount: 1 };
        expect(decideCallMediaReport(prev, { target: HUDDLE_2, camera: true, screen_share: false, connCount: 1 }).report)
            .toEqual({ call_id: 'call-2', camera: true, screen_share: false });
    });
});

describe('useCallMediaReporter', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    type P = { target: CallMediaTarget | null; camera: boolean; screenShare: boolean; connCount: number; send: (r: unknown) => boolean };
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
        const base = { target: HUDDLE, camera: false, screenShare: false, connCount: 1, send };
        const m = mount(base);
        m.update({ ...base, camera: true });
        m.update({ ...base, camera: true, screenShare: true });
        act(() => { vi.advanceTimersByTime(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10); });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith({ call_id: 'call-1', camera: true, screen_share: true });
        m.unmount();
    });

    it('does not mark a report as sent when the socket was closed, and retries on reconnect', () => {
        let open = false;
        const send = vi.fn(() => open);
        const base = { target: HUDDLE, camera: true, screenShare: false, connCount: 1, send };
        const m = mount(base);
        act(() => { vi.advanceTimersByTime(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10); });
        expect(send).toHaveBeenCalledTimes(1);
        open = true;
        m.update({ ...base, connCount: 2 });
        act(() => { vi.advanceTimersByTime(CALL_MEDIA_REPORT_DEBOUNCE_MS + 10); });
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith({ call_id: 'call-1', camera: true, screen_share: false });
        m.unmount();
    });

    it('sends nothing at all while not in a call', () => {
        const send = vi.fn(() => true);
        const m = mount({ target: null, camera: true, screenShare: true, connCount: 1, send });
        act(() => { vi.advanceTimersByTime(CALL_MEDIA_REPORT_DEBOUNCE_MS * 3); });
        expect(send).not.toHaveBeenCalled();
        m.unmount();
    });
});
