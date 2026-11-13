// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});

import { FlappyLeaderboardPanel } from './FlappyLeaderboardPanel';
import { __resetFlappyBest, bindFlappyAccount, type FlappyApi, type FlappyBoard, type FlappyMe, type FlappyScope } from '../utils/flappyBest';
import { __resetEscapeStackForTests, escapeLayerCount } from '../utils/escapeStack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME_OFF: FlappyMe = { best_score: 22, global_opt_in: false, rank: null };
const friends: FlappyBoard = {
    scope: 'friends',
    entries: [
        { rank: 1, username: 'ana', discriminator: 12, score: 30, is_me: false },
        { rank: 2, username: 'me', discriminator: 1, score: 22, is_me: true },
        { rank: 3, username: 'bo', discriminator: null, score: 5, is_me: false },
    ],
    me: { ...ME_OFF, rank: 2 },
};
const globalBoard = (over: Partial<FlappyBoard> = {}): FlappyBoard => ({
    scope: 'global',
    entries: [
        { rank: 1, username: 'zed', discriminator: 7, score: 99, is_me: false },
        { rank: 2, username: 'kim', discriminator: 4321, score: 80, is_me: false },
    ],
    me: ME_OFF,
    ...over,
});

let root: Root;
let host: HTMLDivElement;
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

function fakeApi(boards: Partial<Record<FlappyScope, FlappyBoard | null | (() => Promise<FlappyBoard | null>)>>, opt: boolean | null = true) {
    let saved: boolean | null = null; // what the "server" now holds, once the player has toggled it
    const board = vi.fn(async (s: FlappyScope) => {
        const b = boards[s];
        const out = typeof b === 'function' ? await b() : (b ?? null);
        return out && saved !== null ? { ...out, me: { ...out.me, global_opt_in: saved } } : out;
    });
    const setOptIn = vi.fn(async (on: boolean) => { if (opt === null) return null; saved = on; return on; });
    const api: FlappyApi = { submit: vi.fn(), me: vi.fn(async () => ME_OFF), board, setOptIn } as unknown as FlappyApi;
    return { api, board, setOptIn };
}

async function open(api: FlappyApi, onClose = vi.fn(), onMe = vi.fn()) {
    bindFlappyAccount('acct-1', api);
    await act(async () => { root.render(React.createElement(FlappyLeaderboardPanel, { onClose, onMe })); });
    await flush();
    return { onClose, onMe };
}
const $ = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => Array.from(host.querySelectorAll(sel)) as HTMLElement[];
const click = (el: Element | null) => act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

beforeEach(() => {
    store.clear();
    __resetFlappyBest();
    __resetEscapeStackForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    __resetFlappyBest();
});

describe('FlappyLeaderboardPanel', () => {
    it('opens on the Friends tab, with your row highlighted and ranked', async () => {
        const { api, board } = fakeApi({ friends });
        await open(api);
        expect(board).toHaveBeenCalledWith('friends');
        const tabs = $$('[role="tab"]');
        expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([['Friends', 'true'], ['Global', 'false']]);
        const rows = $$('.fw-lb-row');
        expect(rows.map((r) => r.querySelector('.fw-lb-name')!.textContent)).toEqual(['ana#0012', 'me#0001You', 'bo']);
        expect(rows.map((r) => r.querySelector('.fw-lb-score')!.textContent)).toEqual(['30', '22', '5']);
        expect(rows.map((r) => r.classList.contains('is-me'))).toEqual([false, true, false]);
        expect(rows[1].getAttribute('aria-current')).toBe('true');
        expect(rows[0].getAttribute('aria-current')).toBeNull();
    });

    it('shows name#tag with a 4-digit tag, and just the name when there is no tag', async () => {
        const { api } = fakeApi({ friends: { ...friends, entries: [{ rank: 1, username: 'kim', discriminator: 4321, score: 9, is_me: false }, { rank: 2, username: 'solo', discriminator: null, score: 1, is_me: false }] } });
        await open(api);
        expect($$('.fw-lb-name').map((n) => n.textContent)).toEqual(['kim#4321', 'solo']);
    });

    it('the Global tab loads the global board', async () => {
        const { api, board } = fakeApi({ friends, global: globalBoard() });
        await open(api);
        await click($$('[role="tab"]')[1]);
        await flush();
        expect(board).toHaveBeenLastCalledWith('global');
        expect($$('[role="tab"]').map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);
        expect($$('.fw-lb-name').map((n) => n.textContent)).toEqual(['zed#0007', 'kim#4321']);
        expect($('.fw-lb-list')!.getAttribute('aria-label')).toBe('Global top 100');
    });

    it('the global opt-in switch is OFF by default and says so', async () => {
        const { api } = fakeApi({ friends });
        await open(api);
        const sw = $('[role="switch"]')!;
        expect(sw.getAttribute('aria-checked')).toBe('false');
        expect(sw.textContent).toBe('Show me on the global leaderboard');
        expect($('#fw-lb-opt-help')!.textContent).toMatch(/^Off\./);
    });

    it('turning it on asks the server, flips at once, and refreshes the global board so you appear', async () => {
        const { api, setOptIn, board } = fakeApi({ friends, global: globalBoard() });
        await open(api);
        await click($$('[role="tab"]')[1]);
        await flush();
        const before = board.mock.calls.length;
        await click($('[role="switch"]'));
        await flush();
        expect(setOptIn).toHaveBeenCalledWith(true);
        expect($('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
        expect($('#fw-lb-opt-help')!.textContent).toMatch(/Anyone can see your name#tag/);
        expect(board.mock.calls.length).toBe(before + 1); // refetched
    });

    it('a failed opt-in change reverts the switch and says so', async () => {
        const { api } = fakeApi({ friends }, null);
        await open(api);
        await click($('[role="switch"]'));
        await flush();
        expect($('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
        expect($('#fw-lb-opt-help')!.textContent).toMatch(/Couldn’t save that/);
    });

    it('reflects an account that is already opted in', async () => {
        const { api } = fakeApi({ friends: { ...friends, me: { ...friends.me, global_opt_in: true } } });
        await open(api);
        expect($('[role="switch"]')!.getAttribute('aria-checked')).toBe('true');
    });

    it('while the first load is pending: a loading note and a busy list, switch disabled until the server has spoken', async () => {
        let release!: (b: FlappyBoard) => void;
        const { api } = fakeApi({ friends: () => new Promise<FlappyBoard | null>((r) => { release = r; }) });
        await open(api);
        expect($('[role="status"]')!.textContent).toMatch(/Loading/);
        expect($('#fw-lb-list')!.getAttribute('aria-busy')).toBe('true');
        expect(($('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
        await act(async () => { release(friends); });
        await flush();
        expect($('#fw-lb-list')!.getAttribute('aria-busy')).toBe('false');
        expect(($('[role="switch"]') as HTMLButtonElement).disabled).toBe(false);
    });

    it('an error shows a message and Try again retries', async () => {
        let ok = false;
        const { api, board } = fakeApi({ friends: async () => (ok ? friends : null) });
        await open(api);
        expect($('[role="alert"]')!.textContent).toMatch(/Couldn’t load the leaderboard/);
        ok = true;
        await click($('[role="alert"] button'));
        await flush();
        expect($('[role="alert"]')).toBeNull();
        expect($$('.fw-lb-row').length).toBe(3);
        expect(board).toHaveBeenCalledTimes(2);
    });

    it('with no API bound (signed out) it is an error, not a crash', async () => {
        await act(async () => { root.render(React.createElement(FlappyLeaderboardPanel, { onClose: vi.fn() })); });
        await flush();
        expect($('[role="alert"]')).not.toBeNull();
    });

    it('empty friends: invites the first score; empty global: points at the switch', async () => {
        const { api } = fakeApi({ friends: { ...friends, entries: [] }, global: globalBoard({ entries: [] }) });
        await open(api);
        expect($('.fw-lb-note')!.textContent).toMatch(/None of your friends have played yet/);
        await click($$('[role="tab"]')[1]);
        await flush();
        expect($('.fw-lb-note')!.textContent).toMatch(/Nobody has joined the global leaderboard yet/);
    });

    it('opted in but below the top 100: your own rank is shown under the list, highlighted', async () => {
        const { api } = fakeApi({ friends, global: globalBoard({ me: { best_score: 3, global_opt_in: true, rank: 412 } }) });
        await open(api);
        await click($$('[role="tab"]')[1]);
        await flush();
        const below = $('.fw-lb-below')!;
        expect(below.classList.contains('is-me')).toBe(true);
        expect(below.textContent).toContain('412');
        expect(below.textContent).toContain('3');
        expect(below.textContent).toMatch(/outside the top 100/);
    });

    it('not opted in: no "below the cut" row even with a score (you are not on the board)', async () => {
        const { api } = fakeApi({ friends, global: globalBoard({ me: { best_score: 3, global_opt_in: false, rank: null } }) });
        await open(api);
        await click($$('[role="tab"]')[1]);
        await flush();
        expect($('.fw-lb-below')).toBeNull();
    });

    it('tabs are keyboard operable: arrows, Home and End move the selection and focus (roving tabindex)', async () => {
        const { api } = fakeApi({ friends, global: globalBoard() });
        await open(api);
        const [t0, t1] = $$('[role="tab"]');
        expect(document.activeElement).toBe(t0); // focus lands on the active tab on open
        expect([t0.tabIndex, t1.tabIndex]).toEqual([0, -1]);
        await key(t0, 'ArrowRight');
        await flush();
        expect(t1.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(t1);
        expect([t0.tabIndex, t1.tabIndex]).toEqual([-1, 0]);
        await key(t1, 'ArrowRight'); // wraps
        await flush();
        expect(t0.getAttribute('aria-selected')).toBe('true');
        await key(t0, 'End');
        await flush();
        expect(t1.getAttribute('aria-selected')).toBe('true');
        await key(t1, 'Home');
        await flush();
        expect(t0.getAttribute('aria-selected')).toBe('true');
    });

    it('a stale response never overwrites a newer tab (race on quick tab switching)', async () => {
        let releaseFriends!: (b: FlappyBoard) => void;
        const { api } = fakeApi({ friends: () => new Promise<FlappyBoard | null>((r) => { releaseFriends = r; }), global: globalBoard() });
        await open(api);
        await click($$('[role="tab"]')[1]); // switch before friends has answered
        await flush();
        await act(async () => { releaseFriends(friends); });
        await flush();
        expect($('.fw-lb-list')!.getAttribute('aria-label')).toBe('Global top 100');
        expect($$('.fw-lb-name')[0].textContent).toBe('zed#0007');
    });

    it('Esc and the close button close it; Esc goes through the shared stack (one layer)', async () => {
        const { api } = fakeApi({ friends });
        const { onClose } = await open(api);
        expect(escapeLayerCount()).toBe(1);
        await click($('.fw-close'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('hands the server\'s standing up so the game\'s HUD can show a best from another device', async () => {
        const { api } = fakeApi({ friends: { ...friends, me: { best_score: 77, global_opt_in: false, rank: 1 } } });
        const { onMe } = await open(api);
        expect(onMe).toHaveBeenCalledWith(expect.objectContaining({ best_score: 77 }));
    });

    it('is a dialog with a name', async () => {
        const { api } = fakeApi({ friends });
        await open(api);
        expect($('[role="dialog"]')!.getAttribute('aria-label')).toBe('Firewall leaderboard');
    });
});
