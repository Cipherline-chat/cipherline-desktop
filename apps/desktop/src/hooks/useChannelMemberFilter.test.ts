// @vitest-environment jsdom
/**
 * useChannelMemberFilter, rendered for real: what the member sidebar shows on
 * EVERY render while channels are switched. The property under test is the
 * owner's "don't flash the full 100-member list and then shrink it", which a
 * unit test of the pure function alone cannot show (it is about the sequence
 * of renders around a fetch), plus "switching between seen channels stays
 * instant" (first render after the switch already correct, zero requests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

import { useChannelMemberFilter } from './useChannelMemberFilter';
import {
    filterMembers,
    invalidateServerChannelViewers,
    __resetChannelViewerCache,
} from '../utils/channelViewerCache';

const TOKEN = 'tok';
const MEMBERS = Array.from({ length: 100 }, (_, i) => ({ user_id: `u${i}` }));
type Ch = { channel_id: string; server_id: string; view_scope?: 'all' | 'restricted' };
const PUBLIC: Ch = { channel_id: 'pub', server_id: 'S', view_scope: 'all' };
const SECRET: Ch = { channel_id: 'secret', server_id: 'S', view_scope: 'restricted' };
const LEGACY: Ch = { channel_id: 'legacy', server_id: 'S' };   // API without view_scope

let answers: Record<string, unknown>;
let holds: Array<() => void>;
let hold: boolean;
const requests = () => axiosGet.mock.calls.length;

/** Every render's (filter kind, rows shown), in order. */
let renders: Array<{ ch: string; kind: string; n: number }>;
const Probe: React.FC<{ channel: Ch }> = ({ channel }) => {
    const f = useChannelMemberFilter('S', channel, TOKEN);
    const list = filterMembers(MEMBERS, f);
    renders.push({ ch: channel.channel_id, kind: f.kind, n: list.length });
    return null;
};

let root: Root | null = null;
const show = (channel: Ch) => act(() => { root!.render(React.createElement(Probe, { channel })); });
const settle = async () => { await act(async () => { holds.splice(0).forEach(r => r()); await new Promise(r => setTimeout(r, 0)); }); };

beforeEach(() => {
    __resetChannelViewerCache();
    axiosGet.mockReset();
    answers = { secret: { all: false, user_ids: ['u3', 'u7'] } };
    holds = [];
    hold = false;
    renders = [];
    axiosGet.mockImplementation(async (url: string) => {
        const id = /\/channels\/([^/]+)\/viewers$/.exec(url)?.[1] ?? '';
        if (hold) await new Promise<void>(r => holds.push(r));
        if (!(id in answers)) throw new Error('403');
        return { data: JSON.parse(JSON.stringify(answers[id])) };
    });
    root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => { root?.unmount(); }); root = null; });

describe('member sidebar across channel switches', () => {
    it('a never-seen restricted channel shows loading, then exactly its 2 viewers — never the full 100', async () => {
        hold = true;
        show(SECRET);
        expect(renders.at(-1)).toEqual({ ch: 'secret', kind: 'loading', n: 0 });
        await settle();
        expect(renders.at(-1)).toEqual({ ch: 'secret', kind: 'subset', n: 2 });
        expect(renders.filter(r => r.ch === 'secret').every(r => r.n === 0 || r.n === 2)).toBe(true);
        expect(requests()).toBe(1);
    });

    it('control: the recorder DOES see a full list when one is rendered (legacy API, no view_scope)', () => {
        show(LEGACY);
        expect(renders[0]).toEqual({ ch: 'legacy', kind: 'all', n: 100 });
        expect(requests()).toBe(0);
    });

    it('a public channel paints all 100 on the first render and never asks', async () => {
        show(PUBLIC);
        await settle();
        expect(renders[0]).toEqual({ ch: 'pub', kind: 'all', n: 100 });
        expect(requests()).toBe(0);
    });

    it('switching back and forth between seen channels is instant: right list on the first render, no requests', async () => {
        show(SECRET);
        await settle();
        show(PUBLIC);
        await settle();
        const before = requests();
        renders = [];
        for (let k = 0; k < 5; k++) { show(SECRET); show(PUBLIC); }
        await settle();
        expect(requests()).toBe(before);                       // fresh: nothing re-asked
        for (const r of renders) expect(r).toEqual(r.ch === 'secret'
            ? { ch: 'secret', kind: 'subset', n: 2 }
            : { ch: 'pub', kind: 'all', n: 100 });
    });

    it('a permissions change while viewing re-asks at once, keeps the old list (no spinner) until the answer lands', async () => {
        show(SECRET);
        await settle();
        expect(requests()).toBe(1);
        answers.secret = { all: false, user_ids: ['u3', 'u7', 'u9'] };
        hold = true;
        renders = [];
        act(() => { invalidateServerChannelViewers('S'); });
        expect(requests()).toBe(2);                            // revalidating now, not on next open
        expect(renders.every(r => r.kind === 'subset' && r.n === 2)).toBe(true);
        await settle();
        expect(renders.at(-1)).toEqual({ ch: 'secret', kind: 'subset', n: 3 });
    });

    it('a restricted channel whose first fetch fails falls back to everyone rather than spinning', async () => {
        delete answers.secret;
        show(SECRET);
        await settle();
        expect(renders.at(-1)).toEqual({ ch: 'secret', kind: 'all', n: 100 });
        expect(requests()).toBe(1);                            // and does not retry in a loop
    });
});
