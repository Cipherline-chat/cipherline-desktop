// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const push = vi.fn();
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push, dismiss: () => {} }) }));

import { BackOnlineHost, BACK_ONLINE_SHOW_DELAY_MS } from './BackOnlineHost';

let root: Root;
let host: HTMLDivElement;

const set = (online: boolean) => act(() => { root.render(React.createElement(BackOnlineHost, { isOnline: online })); });
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(1_000_000);
    push.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    vi.useRealTimers();
});

describe('BackOnlineHost', () => {
    it('renders nothing and says nothing while the connection is fine', async () => {
        set(true);
        await advance(10 * 60_000);
        expect(host.innerHTML).toBe('');
        expect(push).not.toHaveBeenCalled();
    });

    it('shows one small success toast, a beat after a 3-minute outage ends', async () => {
        set(true);
        set(false);
        await advance(3 * 60_000);
        set(true);
        expect(push).not.toHaveBeenCalled();
        await advance(BACK_ONLINE_SHOW_DELAY_MS + 50);
        expect(push).toHaveBeenCalledTimes(1);
        const t = push.mock.calls[0][0];
        expect(t.kind).toBe('success');
        expect(t.title).toBe('Back online');
        expect(t.message).toBe('You were offline for 3 minutes.');
        expect(t.durationMs).toBeLessThanOrEqual(5000);
    });

    it('says nothing for a drop under two minutes', async () => {
        set(true);
        set(false);
        await advance(90_000);
        set(true);
        await advance(5000);
        expect(push).not.toHaveBeenCalled();
    });

    it('drops the note if the connection fails again during the beat', async () => {
        set(true);
        set(false);
        await advance(3 * 60_000);
        set(true);
        await advance(BACK_ONLINE_SHOW_DELAY_MS / 2);
        set(false);
        await advance(BACK_ONLINE_SHOW_DELAY_MS * 2);
        expect(push).not.toHaveBeenCalled();
    });

    it('once per reconnect, and rate-limited across quick repeats', async () => {
        set(true);
        set(false);
        await advance(3 * 60_000);
        set(true);
        await advance(BACK_ONLINE_SHOW_DELAY_MS + 50);
        expect(push).toHaveBeenCalledTimes(1);
        set(false);
        await advance(3 * 60_000);
        set(true);
        await advance(BACK_ONLINE_SHOW_DELAY_MS + 50);
        expect(push).toHaveBeenCalledTimes(1);     // within the 10-minute gap
    });
});
