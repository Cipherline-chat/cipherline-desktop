// @vitest-environment jsdom
/**
 * The post-import popup (owner decision 3, D19) and the "Not on Cipherline
 * yet" card (plan B6.2 rule 5), mounted for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { ImportKeepStep } = await import('./ImportKeepStep');
const { UnclaimedAuthorCard } = await import('./ImportedAuthor');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

const rows = (n: number, bytes: number) => Array.from({ length: n }, (_, i) => ({ message_id: `m${i}`, attachment_ids: [], bytes }));

describe('ImportKeepStep', () => {
    it('shows usage; "Save all" only enabled for a channel that fits the remaining storage (D19)', async () => {
        const saveAll = vi.fn(async () => ({ saved: 3, noRoom: 0 }));
        act(() => root.render(React.createElement(ImportKeepStep, {
            channels: [
                { channelId: 'c1', name: 'general', rows: rows(3, 1000) },            // 3 KB: fits
                { channelId: 'c2', name: 'media', rows: rows(10, 5 * 1024 * 1024) },  // 50 MB: does not
                { channelId: 'c3', name: 'empty', rows: [] },                           // nothing to save: not listed
            ],
            loadStorage: async () => ({ used_bytes: 1024 * 1024, limit_bytes: 25 * 1024 * 1024 }),
            saveAll, onDone: () => {},
        })));
        await flush();
        expect(host.textContent).toContain('Server save messages you don’t want deleted');
        expect(host.querySelector('[data-testid=keep-storage]')!.textContent).toContain('1.0 MB of 25.0 MB used');
        const buttons = [...host.querySelectorAll('[data-testid=keep-channels] button')] as HTMLButtonElement[];
        expect(buttons).toHaveLength(2);
        expect(buttons[0].disabled).toBe(false);
        expect(buttons[1].disabled).toBe(true);
        expect(buttons[1].getAttribute('aria-label')).toMatch(/not enough storage/);
        await act(async () => { buttons[0].click(); });
        await flush();
        expect(saveAll).toHaveBeenCalledWith('c1', rows(3, 1000));
        expect(host.textContent).toContain('saved 3');
    });

    it('loading, then an error with Try again', async () => {
        let fail = true;
        act(() => root.render(React.createElement(ImportKeepStep, {
            channels: [{ channelId: 'c1', name: 'general', rows: rows(1, 10) }],
            loadStorage: async () => { if (fail) throw new Error('x'); return { used_bytes: 0, limit_bytes: 100 }; },
            saveAll: async () => ({ saved: 1, noRoom: 0 }), onDone: () => {},
        })));
        expect(host.textContent).toContain('Checking this server’s storage');
        await flush();
        expect(host.querySelector('[role=alert]')!.textContent).toMatch(/Couldn’t load/);
        expect((host.querySelector('[data-testid=keep-channels] button') as HTMLButtonElement).disabled).toBe(true);
        fail = false;
        const retry = [...host.querySelectorAll('button')].find(b => /Try again/.test(b.textContent ?? ''))!;
        await act(async () => { retry.click(); });
        await flush();
        expect((host.querySelector('[data-testid=keep-channels] button') as HTMLButtonElement).disabled).toBe(false);
    });
});

describe('UnclaimedAuthorCard', () => {
    it('says "Not on Cipherline yet", offers no profile / message / claim action, closes on Escape', async () => {
        const onClose = vi.fn();
        act(() => root.render(React.createElement(UnclaimedAuthorCard, {
            target: { authorRef: '44444444-4444-4444-8444-444444444444', name: 'Sam', username: 'samwise.k', avatar: null, authorKind: 'user', x: 100, y: 100 },
            token: null, onClose,
        })));
        const card = document.querySelector('[data-imported-author-card]')!;
        expect(card.textContent).toContain('Not on Cipherline yet');
        expect(card.textContent).toContain('@samwise.k');
        const labels = [...card.querySelectorAll('button')].map(b => b.textContent);
        expect(labels).toEqual(['Close']);
        expect(card.querySelector('a')).toBeNull();
        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(onClose).toHaveBeenCalled();
    });
    it('an app / webhook author says so', () => {
        act(() => root.render(React.createElement(UnclaimedAuthorCard, {
            target: { authorRef: '44444444-4444-4444-8444-444444444444', name: 'FarmBot', username: null, avatar: null, authorKind: 'app', x: 0, y: 0 },
            token: null, onClose: () => {},
        })));
        expect(document.querySelector('[data-imported-author-card]')!.textContent).toContain('An app, not a person');
    });
});
