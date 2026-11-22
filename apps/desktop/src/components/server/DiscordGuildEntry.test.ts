// @vitest-environment jsdom
/** The "Import from a Discord server" card in Create a Server: only in the desktop app, only when wired. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView = function () {};

vi.mock('../../hooks/useAttachments', () => ({ useAttachments: () => ({ uploadEncryptedFile: vi.fn() }) }));
const { CreateServerModal } = await import('./CreateServerModal');

let root: Root;
let host: HTMLDivElement;
const noop = vi.fn();
const bridge = {
    status: vi.fn(async () => ({ ok: true, hasToken: false, bot: null, storageReady: true })),
    connect: vi.fn(), forget: vi.fn(), listGuilds: vi.fn(), snapshot: vi.fn(), image: vi.fn(), cancel: vi.fn(async () => ({ ok: true })),
};
type W = { electronAPI?: unknown };

const mount = (props: Record<string, unknown> = {}) => act(() => root.render(React.createElement(CreateServerModal as never, {
    token: 'jwt', onClose: noop, onCreateServer: noop, ...props,
})));
const card = () => document.querySelector('[data-testid="import-discord-server"]') as HTMLElement | null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; delete (window as unknown as W).electronAPI; vi.useRealTimers(); });

describe('Import from a Discord server entry', () => {
    it('is not offered without the desktop bridge (website / no Electron)', () => {
        mount({ onPreviewGuild: vi.fn(), onImportGuild: vi.fn() });
        expect(card()).toBeNull();
    });

    it('is not offered when the host did not wire the API calls', () => {
        (window as unknown as W).electronAPI = { discordImport: bridge };
        mount();
        expect(card()).toBeNull();
    });

    it('is offered with the bridge + handlers, and opens the wizard on the token page', async () => {
        (window as unknown as W).electronAPI = { discordImport: bridge, openExternal: vi.fn() };
        mount({ onPreviewGuild: vi.fn(), onImportGuild: vi.fn() });
        expect(card()).not.toBeNull();
        expect(card()!.textContent).toContain('Import from a Discord server');
        await act(async () => { card()!.click(); });
        expect(document.body.textContent).toContain('Import from Discord');
        expect(document.body.textContent).toContain('Create the bot');
    });
});
