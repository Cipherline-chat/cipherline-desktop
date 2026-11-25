// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useLiveKitRoom } from '@livekit/components-react';
import type { Room } from 'livekit-client';
import { useStableCallback } from './useStableCallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null; host = null;
});

describe('useStableCallback', () => {
    it('keeps one identity across re-renders and always calls the latest implementation', () => {
        const seen: Array<(x: number) => string> = [];
        const Probe = ({ tag }: { tag: string }) => {
            const cb = useStableCallback((x: number) => `${tag}:${x}`);
            seen.push(cb);
            return null;
        };
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        act(() => { root!.render(React.createElement(Probe, { tag: 'a' })); });
        act(() => { root!.render(React.createElement(Probe, { tag: 'b' })); });
        act(() => { root!.render(React.createElement(Probe, { tag: 'c' })); });
        expect(seen.length).toBeGreaterThanOrEqual(3);
        expect(new Set(seen).size).toBe(1);
        expect(seen[0](7)).toBe('c:7');
    });
});

describe('CallPane: <LiveKitRoom onError> is stable (a re-render mid-reconnect must not call room.connect again)', () => {
    const src = readFileSync(join(__dirname, '../components/CallPane.tsx'), 'utf8');
    const open = src.search(/<LiveKitRoom\s*\n/); // the JSX element, not a mention in a comment
    const room = src.slice(open, src.indexOf('</LiveKitRoom>'));
    // Just the element's own props: up to the first child.
    const props = room.slice(0, room.indexOf('<E2EEActivator'));

    it('passes a named stable handler, never an inline arrow, to onError', () => {
        expect(open).toBeGreaterThan(-1);
        expect(props).toMatch(/onError=\{onRoomError\}/);
        expect(props).not.toMatch(/\sonError=\{\s*\(/);
        expect(src).toMatch(/const onRoomError = useStableCallback\(/);
    });

    it('every other prop the connect effect depends on is stable too (token / serverUrl / connectOptions / connect)', () => {
        // @livekit/components-react 2.9 connect effect deps: connect, token, JSON.stringify(connectOptions), room, onError, serverUrl.
        expect(props).toMatch(/connect=\{true\}/);
        expect(props).toMatch(/connectOptions=\{connectOptions\}/);
        expect(src).toMatch(/const connectOptions = useMemo\(\(\): RoomConnectOptions => \(\{[\s\S]{0,80}\}\), \[\]\)/);
    });
});

describe('why: @livekit/components-react re-runs room.connect() when onError changes identity', () => {
    // A stand-in Room: what the wrapper touches (event wiring, connect, disconnect). Its state stays "reconnecting",
    // the state in which livekit-client 2.18's Room.connect() does NOT short-circuit (it only does for Connected).
    const fakeRoom = () => {
        const r = {
            state: 'reconnecting',
            connect: vi.fn(async () => undefined),
            disconnect: vi.fn(async () => undefined),
            on: vi.fn(() => r),
            off: vi.fn(() => r),
            localParticipant: {},
        };
        return r;
    };
    const mount = (stable: boolean) => {
        const room = fakeRoom();
        const Probe = ({ n }: { n: number }) => {
            void n;
            const stableOnError = useStableCallback((e: Error) => { void e; });
            useLiveKitRoom({
                room: room as unknown as Room, token: 't', serverUrl: 'wss://sfu.invalid', connect: true,
                onError: stable ? stableOnError : (e: Error) => { void e; },
            });
            return null;
        };
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        for (let n = 0; n < 4; n++) act(() => { root!.render(React.createElement(Probe, { n })); });
        return room;
    };

    it('control: an inline onError makes every re-render call room.connect() again (the bug)', () => {
        expect(mount(false).connect.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('a stable onError connects exactly once across re-renders (the fix)', () => {
        expect(mount(true).connect).toHaveBeenCalledTimes(1);
    });
});
