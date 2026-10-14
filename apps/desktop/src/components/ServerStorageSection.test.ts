// @vitest-environment jsdom
/**
 * Settings -> Storage -> "Server storage": the rows, the shared purge menu, the
 * server-specific confirm copy, and that confirming purges exactly the picked
 * server's channels through `onPurge` and nothing else.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

// The real icon decrypts a network blob; the test only cares that a row mounts one.
vi.mock('./server/ServerIcon', () => ({
    ServerIcon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }),
}));

import { ServerStorageSection, type ServerStorageData } from './ServerStorageSection';
import { SERVER_PURGE_WARNING } from '../utils/serverStorage';
import { formatBytes } from '../utils/formatBytes';
import { calcConversationStorage } from '../utils/storageCalc';

const DAY = 24 * 3600 * 1000;
const text = (id: string, ageDays: number) => ({
    id, timestamp: Date.now() - ageDays * DAY, content: { type: 'text', text: id },
});

function data(over: Partial<ServerStorageData> = {}): ServerStorageData {
    return {
        servers: [
            { server_id: 'A', name: 'Alpha' },
            { server_id: 'B', name: 'Beta' },
            { server_id: 'E', name: 'Empty' },
        ],
        serverChannels: {
            A: [{ channel_id: 'a1' }, { channel_id: 'a2' }],
            B: [{ channel_id: 'b1' }],
            E: [{ channel_id: 'e1' }],
        },
        channelMessages: {
            a1: [text('a1-old', 400), text('a1-new', 1), text('a1-pinned', 400)],
            a2: [text('a2-old', 40)],
            b1: [text('b1-old', 400), text('b1-new', 1)],
        },
        protectedIds: { a1: ['a1-pinned'] },
        onPurge: vi.fn(async () => ({ purged: 3, skippedChannels: 0 })),
        ...over,
    };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const mount = (d: ServerStorageData) => act(() => { root.render(React.createElement(ServerStorageSection, { data: d })); });
const rowsEl = () => [...host.querySelectorAll('.space-y-2')] as HTMLElement[];
const rowFor = (name: string) => rowsEl().find(r => r.textContent?.includes(name))!;
const triggerIn = (row: HTMLElement) => row.querySelector('button.purge-trigger') as HTMLButtonElement;
const menuItem = (label: string) =>
    [...document.querySelectorAll('[role="menuitem"]')].find(i => i.querySelector('.clabel')?.textContent === label) as HTMLButtonElement;
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const buttonByText = (t: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

function pickPurge(serverName: string, optionLabel: string) {
    act(() => { triggerIn(rowFor(serverName)).click(); });
    act(() => { menuItem(optionLabel).click(); });
}

describe('empty, loading and error states', () => {
    it('renders a calm empty state with zero servers (and no purge controls)', () => {
        mount(data({ servers: [], serverChannels: {}, channelMessages: {} }));
        const sec = host.querySelector('[data-testid="server-storage"]')!;
        expect(sec.textContent).toContain('Server storage');
        expect(sec.textContent).toContain('You aren’t in any servers.');
        expect(host.querySelector('button.purge-trigger')).toBeNull();
    });

    it('says it is loading while the server list is being fetched', () => {
        mount(data({ servers: [], serverChannels: {}, channelMessages: {}, loading: true }));
        expect(host.textContent).toContain('Loading your servers…');
        expect(host.textContent).not.toContain('You aren’t in any servers.');
    });

    it('says so when the server list failed to load', () => {
        mount(data({ servers: [], serverChannels: {}, channelMessages: {}, error: true }));
        expect(host.textContent).toContain('Couldn’t load your servers');
        expect(host.querySelector('button.purge-trigger')).toBeNull();
    });

    it('does not offer cached threads as "Other channels" while the list is not final', () => {
        mount(data({ servers: [], serverChannels: {}, loading: true }));
        expect(host.textContent).not.toContain('Other channels');
        expect(host.querySelector('button.purge-trigger')).toBeNull();
    });
});

describe('rows', () => {
    it('shows one row per server with its icon, name, size and message count', () => {
        const d = data();
        mount(d);
        expect(rowsEl()).toHaveLength(3);
        const alpha = rowFor('Alpha');
        expect(alpha.querySelector('[data-icon="Alpha"]')).not.toBeNull();
        const bytes = calcConversationStorage('a1', d.channelMessages.a1 as unknown[]).totalBytes
            + calcConversationStorage('a2', d.channelMessages.a2 as unknown[]).totalBytes;
        expect(alpha.textContent).toContain(formatBytes(bytes));
        expect(alpha.textContent).toContain('4 msgs');
        expect(alpha.textContent).toContain('2 channels');
        expect(rowFor('Beta').textContent).toContain('2 msgs');
        // Section header carries the grand total.
        expect(host.textContent).toContain('6 msgs');
    });

    it('uses the same row markup and purge trigger as the DM list', () => {
        mount(data());
        const trig = triggerIn(rowFor('Alpha'));
        expect(trig.textContent).toContain('Purge older than…');
        expect(rowFor('Alpha').querySelector('.h-1\\.5.rounded-full')).not.toBeNull();   // the usage bar
    });

    it('disables purge for a server with nothing cached and for one whose channels have not loaded', () => {
        const d = data({ serverChannels: { A: [{ channel_id: 'a1' }, { channel_id: 'a2' }], E: [{ channel_id: 'e1' }] } });
        mount(d);
        expect(triggerIn(rowFor('Empty')).disabled).toBe(true);
        const beta = rowFor('Beta');
        expect(beta.textContent).toContain('Loading…');
        expect(triggerIn(beta).disabled).toBe(true);
        expect(triggerIn(rowFor('Alpha')).disabled).toBe(false);
    });

    it('labels a departed server "Left" and only while it has data', () => {
        const d = data({
            channelMessages: { ...data().channelMessages, g1: [text('g', 5)] },
            leftServerChannels: { L: [{ channel_id: 'g1', name: 'lobby' }] },
        });
        mount(d);
        const left = rowFor('Left server');
        expect(left.textContent).toContain('Left');
        expect(left.textContent).toContain('#lobby');
        expect(rowsEl()).toHaveLength(4);
    });
});

describe('purging a server you have left', () => {
    const leftData = () => data({
        channelMessages: { ...data().channelMessages, g1: [text('g', 5), text('g2', 9)] },
        leftServerChannels: { L: [{ channel_id: 'g1', name: 'lobby' }] },
    });

    it('uses the left-server wording (saved messages cannot be checked) and flags member:false', async () => {
        const d = leftData();
        mount(d);
        pickPurge('Left server', 'Everything');
        const t = dialog()!.textContent!;
        expect(t).toContain('You are no longer in this server');
        expect(t).toContain('can’t be checked');
        expect(t).toContain('Other members keep their copies');
        expect(t).not.toContain('Pinned and saved messages are kept');
        await act(async () => { buttonByText('Delete 2')!.click(); });
        expect(d.onPurge).toHaveBeenCalledWith(['g1'], 0, { member: false });
    });

    it('a joined server never gets the left-server wording', () => {
        mount(leftData());
        pickPurge('Alpha', 'Everything');
        expect(dialog()!.textContent).not.toContain('no longer in this server');
    });
});

describe('purging a server', () => {
    it('per-option counts in the menu are the real ones (pins excluded)', () => {
        mount(data());
        act(() => { triggerIn(rowFor('Alpha')).click(); });
        const hint = (label: string) => menuItem(label).querySelector('.ctxm-acc')?.textContent ?? '';
        // Alpha: a1-old(400d), a1-pinned(400d, kept), a1-new(1d), a2-old(40d)
        expect(hint('Everything')).toMatch(/3\b/);        // old, new, a2-old - not the pinned one
        expect(hint('1 year')).toMatch(/1\b/);            // only a1-old
        expect(hint('1 month')).toMatch(/2\b/);           // a1-old, a2-old
    });

    it('confirm names the server and says what is true for server history', () => {
        mount(data());
        pickPurge('Alpha', 'Everything');
        const d = dialog()!;
        expect(d).not.toBeNull();
        expect(d.textContent).toContain('Alpha');
        expect(d.textContent).toMatch(/permanently delete\s*3\s*messages/);
        expect(d.textContent).toContain(SERVER_PURGE_WARNING);
        expect(d.textContent).not.toMatch(/recipients keep their copies/);
        expect(buttonByText('Delete 3')).toBeDefined();
    });

    it('confirming purges exactly that server\'s channels via onPurge, with the chosen window', async () => {
        const d = data();
        mount(d);
        pickPurge('Alpha', 'Everything');
        await act(async () => { buttonByText('Delete 3')!.click(); });
        expect(d.onPurge).toHaveBeenCalledTimes(1);
        expect(d.onPurge).toHaveBeenCalledWith(['a1', 'a2'], 0, { member: true });   // not b1, not e1
        expect(dialog()).toBeNull();
        expect(rowFor('Alpha').querySelector('[role="status"]')?.textContent).toBe('Removed 3 messages from this device.');
    });

    it('passes the age window through for a timed purge', async () => {
        const d = data();
        mount(d);
        pickPurge('Beta', '1 month');
        await act(async () => { buttonByText('Delete 1')!.click(); });
        expect(d.onPurge).toHaveBeenCalledWith(['b1'], 30 * DAY, { member: true });
    });

    it('cancel deletes nothing', () => {
        const d = data();
        mount(d);
        pickPurge('Alpha', 'Everything');
        act(() => { buttonByText('Cancel')!.click(); });
        expect(d.onPurge).not.toHaveBeenCalled();
        expect(dialog()).toBeNull();
    });

    it('a window that matches nothing offers only Close', () => {
        // Beta's only message is a day old, so "1 year" matches none of it.
        mount(data({ channelMessages: { b1: [text('b1-new', 1)] } }));
        pickPurge('Beta', '1 year');
        expect(dialog()!.textContent).toContain('Nothing to delete');
        expect(buttonByText('Close')).toBeDefined();
        expect(buttonByText('Delete 0')).toBeUndefined();
    });

    it('surfaces a partial result (channels skipped while offline) as a warning', async () => {
        const d = data({ onPurge: vi.fn(async () => ({ purged: 1, skippedChannels: 1 })) });
        mount(d);
        pickPurge('Alpha', 'Everything');
        await act(async () => { buttonByText('Delete 3')!.click(); });
        const status = rowFor('Alpha').querySelector('[role="status"]')!;
        expect(status.textContent).toContain('1 channel skipped');
    });

    it('surfaces a thrown error and re-enables the row', async () => {
        const d = data({ onPurge: vi.fn(async () => { throw new Error('boom'); }) });
        mount(d);
        pickPurge('Alpha', 'Everything');
        await act(async () => { buttonByText('Delete 3')!.click(); });
        expect(rowFor('Alpha').querySelector('[role="status"]')!.textContent).toContain('Something went wrong');
        expect(triggerIn(rowFor('Alpha')).disabled).toBe(false);
    });
});
