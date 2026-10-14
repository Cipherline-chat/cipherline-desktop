// @vitest-environment jsdom
/**
 * Settings -> Storage with the new "Server storage" section: it sits beside
 * "Conversation storage", uses the same row + purge menu, and the two purge
 * paths stay separate - a DM purge never reaches the server handler and vice
 * versa.
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
vi.mock('./server/ServerIcon', () => ({
    ServerIcon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }),
}));

import { StorageSettings } from './StorageSettings';

const DAY = 24 * 3600 * 1000;
const msg = (id: string, ageDays: number) => ({ id, timestamp: Date.now() - ageDays * DAY, content: { type: 'text', text: id } });

const retention = {
    policy: {
        attachmentRetention: 'never', messageRetention: 'never',
        savedAttachmentIds: [], unsavedAttachmentIds: [], savedMessageIds: [], unsavedMessageIds: [],
        unsavedMessageTimestamps: {}, unsavedAttachmentTimestamps: {},
    },
} as never;

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

function mount(serverStorage: unknown, handlers: { dm?: (convId: string, ms: number) => void } = {}) {
    act(() => {
        root.render(React.createElement(StorageSettings, {
            retention,
            messagesState: { dm1: [msg('d1', 400), msg('d2', 1)] },
            conversations: [{ conversation_id: 'dm1', type: 'dm', title: 'Alice' }],
            onClearAllMessages: () => {},
            onPurgeConversation: handlers.dm ?? (() => {}),
            onPurgeTypeNow: () => {},
            serverStorage: serverStorage as never,
        }));
    });
}

const serverStorage = (onPurge = vi.fn(async () => ({ purged: 1, skippedChannels: 0 }))) => ({
    servers: [{ server_id: 'A', name: 'Alpha' }],
    serverChannels: { A: [{ channel_id: 'a1' }] },
    channelMessages: { a1: [msg('s1', 400), msg('s2', 1)] },
    onPurge,
});

const headings = () => [...host.querySelectorAll('h3')].map(h => h.textContent);
const rowFor = (name: string) => ([...host.querySelectorAll('.space-y-2')] as HTMLElement[]).find(r => r.textContent?.includes(name))!;
const buttonByText = (t: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
const menuItem = (label: string) =>
    [...document.querySelectorAll('[role="menuitem"]')].find(i => i.querySelector('.clabel')?.textContent === label) as HTMLButtonElement;

describe('StorageSettings with servers', () => {
    it('shows "Server storage" right after "Conversation storage"', () => {
        mount(serverStorage());
        const h = headings();
        expect(h).toContain('Conversation storage');
        expect(h.indexOf('Server storage')).toBe(h.indexOf('Conversation storage') + 1);
    });

    it('shows no server section when the caller supplies none', () => {
        mount(undefined);
        expect(headings()).not.toContain('Server storage');
        expect(headings()).toContain('Conversation storage');
    });

    it('a server row is built from the same row component and purge trigger as a DM row', () => {
        mount(serverStorage());
        const dm = rowFor('Alice');
        const sv = rowFor('Alpha');
        expect(dm.querySelector('button.purge-trigger')!.textContent).toBe(sv.querySelector('button.purge-trigger')!.textContent);
        expect(dm.className).toBe(sv.className);
        expect(dm.querySelector('.h-1\\.5')!.className).toBe(sv.querySelector('.h-1\\.5')!.className);
    });

    it('purging a DM row reaches only the DM handler; purging a server row only the server handler', async () => {
        const onPurgeConversation = vi.fn();
        const onPurge = vi.fn(async () => ({ purged: 1, skippedChannels: 0 }));
        mount(serverStorage(onPurge), { dm: onPurgeConversation });

        act(() => { (rowFor('Alice').querySelector('button.purge-trigger') as HTMLButtonElement).click(); });
        act(() => { menuItem('Everything').click(); });
        await act(async () => { buttonByText('Delete 2')!.click(); });
        expect(onPurgeConversation).toHaveBeenCalledWith('dm1', 0);
        expect(onPurge).not.toHaveBeenCalled();

        act(() => { (rowFor('Alpha').querySelector('button.purge-trigger') as HTMLButtonElement).click(); });
        act(() => { menuItem('Everything').click(); });
        await act(async () => { buttonByText('Delete 2')!.click(); });
        expect(onPurge).toHaveBeenCalledWith(['a1'], 0, { member: true });
        expect(onPurgeConversation).toHaveBeenCalledTimes(1);
    });

    it('DM confirm keeps its own wording; the server one differs', () => {
        mount(serverStorage());
        act(() => { (rowFor('Alice').querySelector('button.purge-trigger') as HTMLButtonElement).click(); });
        act(() => { menuItem('Everything').click(); });
        expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Other devices and recipients keep their copies.');
        act(() => { buttonByText('Cancel')!.click(); });

        act(() => { (rowFor('Alpha').querySelector('button.purge-trigger') as HTMLButtonElement).click(); });
        act(() => { menuItem('Everything').click(); });
        const t = document.querySelector('[role="dialog"]')!.textContent!;
        expect(t).toContain('other members');
        expect(t).not.toContain('recipients');
    });
});
