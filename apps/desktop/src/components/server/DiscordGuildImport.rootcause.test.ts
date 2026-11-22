// @vitest-environment jsdom
/**
 * Root cause of the owner's "it says the bot is not in any server but it is"
 * (staging 0.1.3-staging.265).
 *
 * The old guide asked for an Application ID typed by hand, separately from the
 * bot token, and never checked that the two belonged together. The invite link
 * was built from the typed id, the server list was read with the token. Invite
 * application A's bot, paste application B's token, and B's bot really is in no
 * server, while the owner can see "a bot" in his server. The empty state's
 * "Open invite link" was built from the same typed id, so retrying never helped.
 * Forget + a new token also kept the old id. Commit c4037aaa4 reproduces all of
 * that against the shipped wizard (those tests passed on it).
 *
 * Here the REAL wizard and the REAL main-process handlers run against a mock
 * Discord that models applications, tokens and invite authorisation, and the
 * same scenarios now end with the server listed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDiscordImportHandlers } from '../../../electron/discord-import/ipc';
import { BOTH_INTENTS, MockDiscord, ownerApps, type MockApp } from '../../../electron/discord-import/__fixtures__/mock-discord';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView = function () {};

const { DiscordGuildImport } = await import('./DiscordGuildImport');
type Props = import('./DiscordGuildImport').DiscordGuildImportProps;
type Api = import('../../utils/discordImport/types').DiscordImportApi;

let root: Root;
let host: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
const text = () => host.textContent ?? '';
const button = (label: RegExp) => [...host.querySelectorAll('button')].find(b => label.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const type = async (el: HTMLInputElement, v: string) => {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); };

function realApi(discord: MockDiscord): Api {
    const mem = new Map<string, string>();
    const store = { status: () => 'ok', get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => { mem.set(k, v); }, delete: (k: string) => { mem.delete(k); } };
    const h = createDiscordImportHandlers({ store, clientOptions: { fetchFn: discord.fetch, sleep: async () => undefined } });
    return {
        status: () => h.status(), connect: (token: string) => h.connect({ token }), checkApp: () => h.checkApp(), forget: () => h.forget(),
        listGuilds: () => h.listGuilds(), snapshot: (guildId: string) => h.snapshot({ guildId }),
        image: (r) => h.image(r), cancel: () => h.cancel(), history: (r) => h.history(r), media: (r) => h.media(r),
    } as Api;
}

function mount(api: Api, onOpenExternal: (u: string) => void) {
    act(() => root.render(React.createElement(DiscordGuildImport, {
        api, host: {} as Props['host'], onBack: () => {}, onOpenServer: () => {}, onOpenExternal,
    })));
}

async function pasteToken(t: string) {
    await type(q('input[type="password"]') as HTMLInputElement, t);
    await click(button(/Check token/));
}
const inviteUrl = () => q('[data-testid="invite-url"]')!.textContent!;
const clientId = (u: string) => new URL(u).searchParams.get('client_id');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('FIXED: the invite always adds the bot whose token we hold', () => {
    it('the owner\'s two applications: there is no id to mistype; the invite is the token\'s app; the server shows up by itself', async () => {
        const { other, importer } = ownerApps();
        const discord = new MockDiscord([other, importer]);
        // The owner's OTHER bot is already in the server (what he saw there in the old flow).
        discord.authorize(`https://discord.com/oauth2/authorize?client_id=${other.appId}&scope=bot&permissions=8`);
        const opened: string[] = [];
        mount(realApi(discord), u => opened.push(u));
        await flush();
        expect(q('input[inputmode="numeric"]')).toBeNull();

        await pasteToken(importer.token);
        await click(button(/^Continue$/));
        // The list is read with the importer's token: honestly empty, and the copy says whose bot it means.
        expect(q('[data-testid="no-servers"]')!.textContent).toMatch(/Cipherline Importer isn’t in any server yet.*this exact bot/s);
        expect(clientId(inviteUrl())).toBe(importer.appId);
        expect(discord.log).toContain('GET /oauth2/applications/@me auth');

        await click(button(/^\s*Open invite link$/));
        expect(discord.authorize(opened.at(-1)!)).toMatchObject({ ok: true, botId: importer.botId, permissions: '8' });
        await advance(5000); // no click: the list refreshes itself
        expect(q('[data-testid="no-servers"]')).toBeNull();
        expect(text()).toContain('Pixel Farm Co-op');
        expect(q('[role="radio"][aria-checked="true"]')).not.toBeNull(); // the only server is picked for you
    });

    it('an old application whose bot user id differs from its application id still gets the right client_id', async () => {
        const legacy: MockApp = { appId: '600000000000000123', botId: '600000000000000999', botName: 'Old Importer', token: ['NjAwMDAwMDAwMDAwMDAwOTk5', 'Glegac', 'legacylegacylegacylegacylegacy1234'].join('.'), flags: BOTH_INTENTS };
        const discord = new MockDiscord([legacy]);
        const opened: string[] = [];
        mount(realApi(discord), u => opened.push(u));
        await flush();
        await pasteToken(legacy.token);
        await click(button(/^Continue$/));
        expect(clientId(inviteUrl())).toBe(legacy.appId);
        await click(button(/^\s*Open invite link$/));
        expect(discord.authorize(opened.at(-1)!)).toMatchObject({ ok: true, botId: legacy.botId });
        await advance(5000);
        expect(text()).toContain('Pixel Farm Co-op');
    });

    it('Use a different token: the invite switches to the NEW token\'s application', async () => {
        const { other, importer } = ownerApps();
        const discord = new MockDiscord([other, importer]);
        const api = realApi(discord);
        await api.connect(other.token); // saved on an earlier try
        mount(api, () => {});
        await flush();
        await click(button(/^Continue$/));
        expect(clientId(inviteUrl())).toBe(other.appId);
        await click(button(/^Back$/));
        await click(button(/Use a different token/));
        await pasteToken(importer.token);
        await click(button(/^Continue$/));
        expect(clientId(inviteUrl())).toBe(importer.appId);
    });

    it('a Discord outage is not reported as "the bot is in no server"', async () => {
        const { importer } = ownerApps();
        const discord = new MockDiscord([importer]);
        discord.authorize(`https://discord.com/oauth2/authorize?client_id=${importer.appId}&scope=bot&permissions=8`);
        discord.failGuildsWithNetwork = 99; // every retry inside the client fails too
        mount(realApi(discord), () => {});
        await flush();
        await pasteToken(importer.token);
        await click(button(/^Continue$/));
        await flush();
        expect(q('[data-testid="no-servers"]')).toBeNull();
        expect(q('[data-testid="unreachable"]')!.textContent).toMatch(/Couldn’t reach Discord/);
        discord.failGuildsWithNetwork = 0;
        await advance(15000);
        expect(text()).toContain('Pixel Farm Co-op');
    });

    it('Cipherline only ever sends GET to Discord through the whole flow', async () => {
        const { importer } = ownerApps();
        const discord = new MockDiscord([importer]);
        discord.authorize(`https://discord.com/oauth2/authorize?client_id=${importer.appId}&scope=bot&permissions=8`);
        mount(realApi(discord), () => {});
        await flush();
        await pasteToken(importer.token);
        await click(button(/^Continue$/));
        await click(button(/^\s*Refresh$/));
        expect(discord.log.length).toBeGreaterThan(3);
        expect(discord.log.every(l => l.startsWith('GET '))).toBe(true);
    });
});
