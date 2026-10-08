// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
    useChannelKeyGateHeal, GATE_HEAL_FAST_MS, GATE_HEAL_SLOW_MS, GATE_HEAL_FAST_TICKS,
} from './useChannelKeyGateHeal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The "Waiting for channel keys…" gate lowers itself the moment a key is held. */
type Props = { channelId: string | null; awaiting: boolean; held: () => Promise<number | null>; onHeld: (id: string) => void };
const Probe: React.FC<Props> = ({ channelId, awaiting, held, onHeld }) => {
    useChannelKeyGateHeal({ channelId, awaiting, getLatestEpoch: held, onHeld });
    return null;
};

let root: Root;
const render = (p: Props) => act(() => { root.render(React.createElement(Probe, p)); });
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { vi.useFakeTimers(); root = createRoot(document.createElement('div')); });
afterEach(() => { act(() => { root.unmount(); }); vi.useRealTimers(); });

describe('useChannelKeyGateHeal', () => {
    it('lowers the gate when the key turns out to be held (the stale-snapshot case)', async () => {
        const onHeld = vi.fn();
        let epoch: number | null = null;
        render({ channelId: 'c1', awaiting: true, held: async () => epoch, onHeld });
        await advance(GATE_HEAL_FAST_MS);
        expect(onHeld).not.toHaveBeenCalled(); // genuinely no key yet: gate stays
        epoch = 3;
        await advance(GATE_HEAL_FAST_MS);
        expect(onHeld).toHaveBeenCalledWith('c1');
        expect(onHeld).toHaveBeenCalledTimes(1);
        await advance(GATE_HEAL_SLOW_MS * 2);
        expect(onHeld).toHaveBeenCalledTimes(1); // and stops looking
    });

    it('never lowers the gate for a channel that has no key', async () => {
        const onHeld = vi.fn();
        render({ channelId: 'c1', awaiting: true, held: async () => null, onHeld });
        await advance(GATE_HEAL_FAST_MS * (GATE_HEAL_FAST_TICKS + 3) + GATE_HEAL_SLOW_MS * 3);
        expect(onHeld).not.toHaveBeenCalled();
    });

    it('does nothing when the channel is not gated, or no channel is open', async () => {
        const held = vi.fn(async () => 5);
        const onHeld = vi.fn();
        render({ channelId: 'c1', awaiting: false, held, onHeld });
        await advance(GATE_HEAL_FAST_MS * 3);
        render({ channelId: null, awaiting: true, held, onHeld });
        await advance(GATE_HEAL_FAST_MS * 3);
        expect(held).not.toHaveBeenCalled();
        expect(onHeld).not.toHaveBeenCalled();
    });

    it('slows down after the fast ticks, and stops when the channel is left', async () => {
        const held = vi.fn(async () => null);
        render({ channelId: 'c1', awaiting: true, held, onHeld: vi.fn() });
        await advance(GATE_HEAL_FAST_MS * GATE_HEAL_FAST_TICKS);
        const fast = held.mock.calls.length;
        expect(fast).toBeGreaterThanOrEqual(GATE_HEAL_FAST_TICKS - 1);
        await advance(GATE_HEAL_SLOW_MS * 2);
        expect(held.mock.calls.length - fast).toBeLessThanOrEqual(3); // slow rate
        render({ channelId: 'c2', awaiting: false, held, onHeld: vi.fn() });
        const after = held.mock.calls.length;
        await advance(GATE_HEAL_SLOW_MS * 5);
        expect(held.mock.calls.length).toBe(after);
    });

    it('survives the key store throwing and keeps looking', async () => {
        const onHeld = vi.fn();
        let n = 0;
        render({ channelId: 'c1', awaiting: true, held: async () => { if (n++ < 2) throw new Error('busy'); return 1; }, onHeld });
        await advance(GATE_HEAL_FAST_MS * 5);
        expect(onHeld).toHaveBeenCalledWith('c1');
    });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('Dashboard wiring', () => {
    it('is mounted for the open channel, reads the local key store, and clears the same state the other clear-sites do', () => {
        const src = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
        const i = src.indexOf('useChannelKeyGateHeal({');
        expect(i).toBeGreaterThan(-1);
        const body = src.slice(i, i + 700);
        expect(body).toContain('channelId: activeChannel?.channel_id ?? null');
        expect(body).toContain('awaitingChannelKeys[activeChannel.channel_id]');
        expect(body).toContain('window.electronAPI!.getLatestChannelEpoch(id)');
        expect(body).toContain('firstKeyRequestTimeRef.current.delete(id)');
        expect(body).toContain('setAwaitingChannelKeys');
    });
});
