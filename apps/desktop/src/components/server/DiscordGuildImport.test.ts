// @vitest-environment jsdom
/**
 * "Import from Discord" wizard, mounted for real with the preload bridge and the
 * Cipherline API faked (a MOCK Discord guild; no token, no network). What must hold:
 *   - page one asks for the bot token (steps incl. the two privileged intents and why);
 *     there is NO typed application id anywhere;
 *   - the invite link is built from the application id main derived from the token,
 *     with Administrator (permissions=8), and the copy says why and that it only reads;
 *   - the pasted token goes to main exactly once, the field is emptied, never shown back;
 *   - the server list refreshes itself while the step is open, has a manual Refresh, and
 *     tells "the bot is in no server" apart from "couldn't reach Discord";
 *   - consent gates the run; the run makes ONE server, then offers "Open server";
 *   - "Copy" buttons go through the app clipboard path, say "Copied", and fall back to
 *     selected text when the clipboard refuses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView = function () {};

const { DiscordGuildImport } = await import('./DiscordGuildImport');
const { ANNOUNCEMENT_TEXT } = await import('../../utils/discordImport/steps');
const job = await import('../../utils/discordImport/backgroundImport');
type Props = import('./DiscordGuildImport').DiscordGuildImportProps;
type Api = import('../../utils/discordImport/types').DiscordImportApi;
type Snapshot = import('../../utils/discordImport/types').GuildSnapshot;
type Preview = import('../../utils/discordTemplate').DiscordTemplatePreview;

const BX8 = JSON.parse(readFileSync(join(process.cwd(), 'src/utils/__fixtures__/discordTemplatePreview.BX8.json'), 'utf8')) as Preview;
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const GID = '800000000000000001';
const APP_ID = '800000000000000950'; // deliberately NOT the bot user id: the invite must use the application id
const APP = { id: APP_ID, name: 'Cipherline Importer', intents: { messageContent: true, members: true } };

const SNAPSHOT: Snapshot = {
    guild: { id: GID, name: 'Pixel Farm Co-op', description: null, hasIcon: false, hasBanner: false },
    body: { name: 'Pixel Farm Co-op', roles: [], channels: [{ id: 1, type: 0, name: 'general', position: 0 }] },
    emojis: [],
    counts: { roles: 3, categories: 2, channels: 7, emojis: 0 },
    notMapped: [{ item: 'Threads', reason: 'Coming in a later import phase' }, { item: 'AutoMod rules', reason: 'Cipherline never scans messages' }],
};
const GUILDS = [{ id: GID, name: 'Pixel Farm Co-op', owner: false, hasIcon: false, admin: true }, { id: '800000000000000777', name: 'Second Guild', owner: false, hasIcon: false, admin: true }];

let root: Root;
let host: HTMLDivElement;
let api: { [K in keyof Required<Api>]: ReturnType<typeof vi.fn> };
let h: { preview: ReturnType<typeof vi.fn>; importGuild: ReturnType<typeof vi.fn>; listEmojiNames: ReturnType<typeof vi.fn>; createEmoji: ReturnType<typeof vi.fn>; upload: ReturnType<typeof vi.fn> };
const onBack = vi.fn();
const onOpenServer = vi.fn();
const onOpenExternal = vi.fn();
let writeClipboard: ReturnType<typeof vi.fn>;

const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); };
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

function mount(extra: Partial<Props> = {}) {
    act(() => root.render(React.createElement(DiscordGuildImport, {
        api: api as unknown as Api, host: h as unknown as Props['host'], onBack, onOpenServer, onOpenExternal,
        prepareImage: async (blob: Blob) => ({ blob, mime: 'image/jpeg' }), ...extra,
    })));
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const f of [onBack, onOpenServer, onOpenExternal]) f.mockReset();
    writeClipboard = vi.fn(async () => undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = { writeClipboard };
    api = {
        status: vi.fn(async () => ({ ok: true, hasToken: false, bot: null, app: null, storageReady: true })),
        connect: vi.fn(async () => ({ ok: true, bot: { id: '800000000000000900', name: 'Cipherline Importer' }, app: APP })),
        checkApp: vi.fn(async () => ({ ok: true, app: APP })),
        forget: vi.fn(async () => ({ ok: true })),
        listGuilds: vi.fn(async () => ({ ok: true, guilds: GUILDS })),
        snapshot: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
        history: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'x' } })),
        media: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'x' } })),
        image: vi.fn(async () => ({ ok: false, error: { code: 'x', message: 'no' } })),
        cancel: vi.fn(async () => ({ ok: true })),
        setRunning: vi.fn(async () => ({ ok: true })),
    };
    h = {
        preview: vi.fn(async () => ({ template: { name: 'Pixel Farm Co-op', description: null }, blueprint: BX8.blueprint })),
        importGuild: vi.fn(async () => ({ server_id: 'srv-1', name: 'Pixel Farm Co-op' })),
        listEmojiNames: vi.fn(async () => []),
        createEmoji: vi.fn(async () => undefined),
        upload: vi.fn(async () => ({ attachmentId: 'a', keyB64: 'k', nonceB64: 'n' })),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.useRealTimers();
    job.resetImportJobForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function pasteToken() {
    await type(q('input[type="password"]') as HTMLInputElement, TOKEN);
    await click(button(/Check token/));
}
async function toGuild() {
    mount();
    await flush();
    await pasteToken();
    await click(button(/^Continue$/));
}

describe('page one: the bot token', () => {
    it('asks for the token first, with numbered steps incl. both intents and why; no application id field anywhere', async () => {
        mount();
        await flush();
        expect(q('input[type="password"]')).not.toBeNull();
        expect(q('input[inputmode="numeric"]')).toBeNull();
        expect(text()).not.toMatch(/Application ID/i);
        const steps = q('ol[aria-label="Get a bot token"]')!.textContent!;
        expect(steps).toMatch(/New Application/);
        expect(steps).toMatch(/Server Members Intent.*roles land on the right people/);
        expect(steps).toMatch(/Message Content Intent.*blank/);
        expect(steps).toMatch(/Save Changes/);
        expect(steps).toMatch(/Reset Token/);
        expect(steps.indexOf('Turn on two switches')).toBeLessThan(steps.indexOf('Copy the token'));
        await click(button(/Open the Developer Portal/));
        expect(onOpenExternal).toHaveBeenCalledWith('https://discord.com/developers/applications');
        await click(button(/^Back$/));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('token: sent to main once, field emptied, never rendered back; both intents shown on; "Use a different token" calls forget', async () => {
        mount();
        await flush();
        await pasteToken();
        expect(api.connect).toHaveBeenCalledTimes(1);
        expect(api.connect).toHaveBeenCalledWith(TOKEN);
        expect(host.innerHTML).not.toContain(TOKEN);
        expect(q('[data-testid="saved-bot"]')!.textContent).toContain('Cipherline Importer');
        expect(q('input[type="password"]')).toBeNull();
        expect(host.querySelectorAll('[data-testid="intent-on"]').length).toBe(2);
        await click(button(/Use a different token/));
        expect(api.forget).toHaveBeenCalledTimes(1);
        expect(q('[data-testid="saved-bot"]')).toBeNull();
        expect(q('input[type="password"]')).not.toBeNull();
    });

    it('intents switched off: says which, why it matters, links the bot page, and Check again re-reads them', async () => {
        api.connect.mockResolvedValueOnce({ ok: true, bot: { id: '800000000000000900', name: 'Cipherline Importer' }, app: { ...APP, intents: { messageContent: false, members: false } } });
        mount();
        await flush();
        await pasteToken();
        expect(host.querySelectorAll('[data-testid="intent-off"]').length).toBe(2);
        expect(q('[data-testid="intents"]')!.textContent).toMatch(/blank/);
        await click(button(/Open the Bot page/));
        expect(onOpenExternal).toHaveBeenCalledWith(`https://discord.com/developers/applications/${APP_ID}/bot`);
        await click(button(/Check again/));
        expect(api.checkApp).toHaveBeenCalledTimes(1);
        expect(host.querySelectorAll('[data-testid="intent-on"]').length).toBe(2);
    });

    it('a rejected token shows the plain-words error and stays on the step', async () => {
        api.connect.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_token', message: 'Discord says that token is not valid.' } });
        mount();
        await flush();
        await pasteToken();
        expect(text()).toContain('Discord says that token is not valid.');
        expect(host.innerHTML).not.toContain(TOKEN);
        expect(button(/^Continue$/)).toBeUndefined();
    });

    it('a token saved before the application was recorded re-reads it once (status has no app)', async () => {
        api.status.mockResolvedValue({ ok: true, hasToken: true, bot: { id: '800000000000000900', name: 'Saved Bot' }, app: null, storageReady: true });
        mount();
        await flush();
        expect(q('[data-testid="saved-bot"]')!.textContent).toContain('Saved Bot');
        expect(api.checkApp).toHaveBeenCalledTimes(1);
        expect((button(/^Continue$/) as HTMLButtonElement).disabled).toBe(false);
    });
});

describe('page two: add the bot and pick the server', () => {
    it('invite link = the TOKEN\'s application id + Administrator (8); the copy says why, that it only reads, and what to do after', async () => {
        await toGuild();
        const url = q('[data-testid="invite-url"]')!.textContent!;
        expect(url).toBe(`https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot&permissions=8&integration_type=0`);
        await click(button(/^\s*Open invite link$/));
        expect(onOpenExternal).toHaveBeenCalledWith(url);
        const t = text();
        expect(t).toMatch(/Why Administrator\?/);
        expect(t).toMatch(/private ones too/);
        expect(t).toMatch(/roles and each\s+member’s permissions/);
        expect(t).toMatch(/only\s+reads/);
        expect(t).toMatch(/never posts, edits, deletes/);
        expect(t).toMatch(/token never leaves\s+this computer/);
        expect(t).toMatch(/kick the bot and reset its token/);
    });

    it('the list refreshes itself every 5 s while the step is open: the server appears with no click after the invite', async () => {
        api.listGuilds.mockResolvedValueOnce({ ok: true, guilds: [] });
        await toGuild();
        expect(api.listGuilds).toHaveBeenCalledTimes(1);
        expect(q('[data-testid="no-servers"]')!.textContent).toMatch(/Cipherline Importer isn’t in any server yet/);
        await advance(5000);
        expect(api.listGuilds).toHaveBeenCalledTimes(2);
        expect(q('[data-testid="no-servers"]')).toBeNull();
        expect(text()).toContain('Pixel Farm Co-op');
        // leaving the step stops the polling
        await click(button(/^Back$/));
        await advance(30000);
        expect(api.listGuilds).toHaveBeenCalledTimes(2);
    });

    it('manual Refresh asks again right away', async () => {
        await toGuild();
        expect(api.listGuilds).toHaveBeenCalledTimes(1);
        await click(button(/^\s*Refresh$/));
        expect(api.listGuilds).toHaveBeenCalledTimes(2);
    });

    it('"couldn\'t reach Discord" is NOT shown as "bot is in no server", and it keeps trying', async () => {
        api.listGuilds.mockResolvedValueOnce({ ok: false, error: { code: 'network', message: 'Could not reach Discord. Check your connection and try again.' } });
        await toGuild();
        expect(q('[data-testid="no-servers"]')).toBeNull();
        expect(q('[data-testid="unreachable"]')!.textContent).toMatch(/Couldn’t reach Discord/);
        await advance(15000);
        expect(api.listGuilds).toHaveBeenCalledTimes(2);
        expect(text()).toContain('Pixel Farm Co-op');
    });

    it('a rejected token stops the polling and offers to paste a new one', async () => {
        api.listGuilds.mockResolvedValue({ ok: false, error: { code: 'invalid_token', message: 'Discord says that token is not valid.' } });
        await toGuild();
        expect(q('[data-testid="token-problem"]')!.textContent).toMatch(/not valid/);
        await advance(60000);
        expect(api.listGuilds).toHaveBeenCalledTimes(1);
        await click(button(/Paste a new token/));
        expect(api.forget).toHaveBeenCalled();
        expect(q('input[type="password"]')).not.toBeNull();
    });

    it('a server where the bot lacks Administrator is flagged, with the fix', async () => {
        api.listGuilds.mockResolvedValue({ ok: true, guilds: [{ ...GUILDS[0], admin: false }] });
        await toGuild();
        expect(text()).toMatch(/Added without Administrator/);
        expect(q('[data-testid="not-admin"]')!.textContent).toMatch(/Open the invite link again/);
    });
});

async function toPreview(extra: Partial<Props> = {}) {
    mount(extra);
    await flush();
    await pasteToken();
    await click(button(/^Continue$/));
    expect(api.listGuilds).toHaveBeenCalled();
    expect(text()).toContain('Pixel Farm Co-op');
    expect((button(/^Preview$/) as HTMLButtonElement).disabled).toBe(true); // nothing picked yet (two servers)
    await click(host.querySelectorAll('[role="radio"]')[0]);
    await click(button(/^Preview$/));
}

const historyHost = {} as NonNullable<Props['history']>;

describe('preview, consent, run', () => {
    it('guild -> preview: snapshot read, API preview asked, counts and "won\'t come over" shown', async () => {
        await toPreview();
        expect(api.snapshot).toHaveBeenCalledWith(GID);
        expect(h.preview).toHaveBeenCalledWith(SNAPSHOT.body);
        expect(q('[data-testid="preview-counts"]')!.textContent).toMatch(/3 roles.*2 categories.*7 channels.*0 emojis/);
        const list = q('[data-testid="not-mapped"]')!.textContent!;
        expect(list).toContain('Threads');
        expect(list).toContain(BX8.blueprint.skipped[0].item);
        expect(h.importGuild).not.toHaveBeenCalled();
    });

    it('Message Content Intent off: the message copy is not offered, with the reason and the fix', async () => {
        api.connect.mockResolvedValueOnce({ ok: true, bot: { id: '800000000000000900', name: 'Cipherline Importer' }, app: { ...APP, intents: { messageContent: false, members: true } } });
        await toPreview({ history: historyHost });
        expect(q('[data-testid="content-intent-off"]')!.textContent).toMatch(/Message Content Intent is off/);
        expect(q('[data-testid="history-channels"]')).toBeNull();
        await click(button(/^Continue$/));
        expect(host.querySelectorAll('[role="checkbox"]').length).toBe(1); // structure consent only
    });

    it('consent gates the run; then ONE server is created and "Open server" is offered', async () => {
        await toPreview();
        await click(button(/^Continue$/));
        expect(text()).toContain('I administer this Discord server');
        const go = () => button(/Import server/) as HTMLButtonElement;
        expect(go().disabled).toBe(true);
        await click(go());
        expect(h.importGuild).not.toHaveBeenCalled();
        await click(host.querySelector('[role="checkbox"]'));
        expect(go().disabled).toBe(false);
        await click(go());
        await flush();
        expect(h.importGuild).toHaveBeenCalledTimes(1);
        expect(h.importGuild.mock.calls[0][0]).toMatchObject({ guild: SNAPSHOT.body, name: expect.any(String) });
        expect(text()).toContain('is ready');
        await click(button(/Open server/));
        expect(onOpenServer).toHaveBeenCalledWith('srv-1', 'Pixel Farm Co-op');
    });

    it('a failed create offers Try again and does not claim success', async () => {
        h.importGuild.mockRejectedValueOnce({ response: { status: 500 } });
        await toPreview();
        await click(button(/^Continue$/));
        await click(host.querySelector('[role="checkbox"]'));
        await click(button(/Import server/));
        await flush();
        expect(text()).toContain('Something went wrong');
        expect(text()).not.toContain('is ready');
        await click(button(/Try again/));
        await flush();
        expect(h.importGuild).toHaveBeenCalledTimes(2);
        expect(text()).toContain('is ready');
    });

    it('no Discord logo or brand mark: plain text only', async () => {
        mount();
        await flush();
        expect(host.querySelectorAll('img, svg image').length).toBe(0);
    });
});

describe('copy buttons (the owner: "copy announcement doesn\'t work")', () => {
    async function toConsentWithMessages() {
        await toPreview({ history: historyHost });
        await click(button(/^Continue$/));
        expect(q('[data-testid="copy-announcement"]')).not.toBeNull();
    }

    it('copies through the app clipboard path (Electron main), never navigator.clipboard, and says "Copied"', async () => {
        const web = vi.fn(async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); });
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: web }, configurable: true });
        await toConsentWithMessages();
        await click(q('[data-testid="copy-announcement"]'));
        expect(writeClipboard).toHaveBeenCalledWith(ANNOUNCEMENT_TEXT);
        expect(web).not.toHaveBeenCalled();
        expect(q('[data-testid="copy-announcement"]')!.textContent).toBe(' Copied');
        await advance(2000);
        expect(q('[data-testid="copy-announcement"]')!.textContent).toMatch(/Copy an announcement/);
    });

    it('when every clipboard path refuses: no fake "Copied"; the text is shown selected for Ctrl+C', async () => {
        writeClipboard.mockRejectedValue(new Error('no'));
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
        (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
        await toConsentWithMessages();
        await click(q('[data-testid="copy-announcement"]'));
        expect(q('[data-testid="copy-announcement"]')!.textContent).not.toMatch(/Copied/);
        const ta = q('[data-testid="announcement-fallback"]') as HTMLTextAreaElement;
        expect(ta.value).toBe(ANNOUNCEMENT_TEXT);
        expect(document.activeElement).toBe(ta);
        expect([ta.selectionStart, ta.selectionEnd]).toEqual([0, ANNOUNCEMENT_TEXT.length]);
        expect(text()).toMatch(/press Ctrl\+C/);
    });

    it('the invite link copy uses the same path', async () => {
        await toGuild();
        await click(button(/^\s*Copy link$/));
        expect(writeClipboard).toHaveBeenCalledWith(`https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot&permissions=8&integration_type=0`);
        expect(button(/^\s*Copied$/)).toBeTruthy();
    });
});

/**
 * The REAL host wiring (owner 2026-11-22: "no roles on claim"). Dashboard hands
 * the wizard `makeImportGuildHandler(importDiscordGuild, ...)`; here the same
 * factory wraps a fake POST that captures the body exactly as the API would get
 * it. What must reach the API: every member (roles, nickname, join day) and
 * every ban; what must come back to the wizard: the API's member_grants (the
 * "Saved for N people" line), role_refs (role icons, mentions), channel_refs.
 * Positive control: the closure Dashboard used before (it rebuilt the answer by
 * hand) loses the people line with the same API answer.
 */
describe('real host wiring: Dashboard -> makeImportGuildHandler -> wizard', () => {
    const PEOPLE: Snapshot = {
        ...SNAPSHOT,
        members: [
            { id: '800000000000000101', ref: 1, roles: [2, 3], nick: 'Sammy', joined_at: '2019-04-02' },
            { id: '800000000000000102', ref: 2, roles: [], joined_at: '2021-11-30' },
        ],
        bans: [{ id: '800000000000000199', reason: 'spam' }],
    };
    const API_ANSWER = {
        server_id: 'srv-9', name: 'Pixel Farm Co-op', owner_user_id: 'u-1',
        channel_refs: { 'c:1': 'ch-1' }, role_refs: { 'r:0': 'role-0', 'r:2': 'role-2', 'r:3': 'role-3' },
        member_grants: { status: 'saved', people: 3, roles: 2, overrides: 0, nicknames: 1, bans: 1, member_since: 2 },
        channel_settings: 'applied',
    };

    async function runWith(importGuild: Props['host']['importGuild']) {
        api.snapshot.mockResolvedValue({ ok: true, snapshot: PEOPLE });
        h.importGuild = vi.fn(importGuild) as unknown as typeof h.importGuild;
        await toPreview();
        await click(button(/^Continue$/));
        await click(host.querySelector('[role="checkbox"]'));
        await click(button(/Import server/));
        await flush();
    }

    it('members, roles, nicknames, join days and bans reach the API verbatim; the people line comes back', async () => {
        const { makeImportGuildHandler } = await import('../../utils/discordImport/importGuildHandler');
        const posted: unknown[] = [];
        const created = vi.fn();
        await runWith(makeImportGuildHandler(async (req) => { posted.push(structuredClone(req)); return API_ANSWER; }, created));
        expect(posted).toHaveLength(1);
        const body = posted[0] as Record<string, unknown>;
        expect(body.members).toEqual(PEOPLE.members);
        expect(body.bans).toEqual(PEOPLE.bans);
        expect(body.guild).toEqual(PEOPLE.body);
        expect(created).toHaveBeenCalledTimes(1);
        expect(text()).toContain('is ready');
        expect(text()).toMatch(/Saved for 3 people \(2 roles, 1 nickname, 1 ban, 2 “member since” dates\)/);
    });

    it('POSITIVE CONTROL: the old hand-built Dashboard answer drops member_grants, so the people line is missing', async () => {
        await runWith(async () => {
            const srv = API_ANSWER;
            return { server_id: srv.server_id, name: srv.name, channel_refs: srv.channel_refs, role_refs: srv.role_refs };
        });
        expect(text()).toContain('is ready');
        expect(text()).not.toMatch(/Saved for 3 people/);
    });
});

describe('background import (owner: "do other stuff while servers are importing")', () => {
    async function startImport(extra: Partial<Props> = {}) {
        await toPreview(extra);
        await click(button(/^Continue$/));
        await click(host.querySelector('[role="checkbox"]'));
        await click(button(/Import server/));
    }

    it('closing the wizard mid-run never stops it: no cancel to main, the server is still made, the report waits', async () => {
        let finishCreate!: () => void;
        h.importGuild.mockImplementationOnce(() => new Promise(r => { finishCreate = () => r({ server_id: 'srv-1', name: 'Pixel Farm Co-op' }); }));
        const onClose = vi.fn();
        await startImport({ onClose });
        expect(job.importJobRunning()).toBe(true);
        expect(text()).toMatch(/Closing this window doesn.t stop the import/);
        await click(button(/Keep using Cipherline/));
        expect(onClose).toHaveBeenCalledTimes(1);
        // The modal unmounts the wizard (what the host does on close).
        act(() => root.render(React.createElement('div')));
        await flush();
        expect(api.cancel).not.toHaveBeenCalled();
        expect(job.importJobRunning()).toBe(true);
        finishCreate();
        await flush();
        expect(job.getImportJob()?.phase).toBe('done');
        expect(h.importGuild).toHaveBeenCalledTimes(1);
        // Reopened (pill / toast / the Create Server choice): the SAME job's report, no second import.
        mount();
        await flush();
        expect(text()).toContain('is ready');
        expect(q('input[type="password"]')).toBeNull();
        await click(button(/Open server/));
        expect(onOpenServer).toHaveBeenCalledWith('srv-1', 'Pixel Farm Co-op');
        expect(job.getImportJob()).toBeNull();           // dismissed on open
        expect(h.importGuild).toHaveBeenCalledTimes(1);
    });

    it('POSITIVE CONTROL: closing during SETUP still cancels the wizard\'s own Discord requests', async () => {
        mount();
        await flush();
        act(() => root.render(React.createElement('div')));
        await flush();
        expect(api.cancel).toHaveBeenCalledTimes(1);
    });

    it('one at a time: a wizard opened while an import runs shows that import, not a new setup', async () => {
        let finishCreate!: () => void;
        h.importGuild.mockImplementationOnce(() => new Promise(r => { finishCreate = () => r({ server_id: 'srv-1', name: 'Pixel Farm Co-op' }); }));
        await startImport();
        act(() => root.render(React.createElement('div')));
        mount();
        await flush();
        expect(q('[data-testid="run-label"]')).not.toBeNull();
        expect(q('input[type="password"]')).toBeNull();
        finishCreate();
        await flush();
        expect(text()).toContain('is ready');
    });

    it('Cancel before the server exists goes back to the consent step with the message', async () => {
        // Cancel while the icon is being read (before the create request): nothing is made.
        api.snapshot.mockResolvedValueOnce({ ok: true, snapshot: { ...SNAPSHOT, guild: { ...SNAPSHOT.guild, hasIcon: true } } });
        let fail!: () => void;
        api.image.mockImplementationOnce(() => new Promise(r => { fail = () => r({ ok: false, error: { code: 'x', message: 'cancelled' } }); }));
        await startImport();
        await click(button(/^Cancel$/));
        fail();
        await flush();
        await flush();
        expect(api.cancel).toHaveBeenCalled();
        expect(text()).toContain('Cancelled. Nothing was created.');
        expect(button(/Import server/)).toBeTruthy();    // the consent step again
        expect(job.getImportJob()).toBeNull();
        expect(h.importGuild).not.toHaveBeenCalled();
    });
});

describe('"Watch a video" link (owner: "a link that says watch a video in the instructions")', () => {
    it('hidden while DISCORD_IMPORT_VIDEO_URL is empty (the default)', async () => {
        const { DISCORD_IMPORT_VIDEO_URL } = await import('../../utils/discordImport/invite');
        expect(DISCORD_IMPORT_VIDEO_URL).toBe('');
        mount();
        await flush();
        expect(q('[data-testid="video-link"]')).toBeNull();
        expect(text()).not.toMatch(/Watch a video/);
        await pasteToken();
        await click(button(/^Continue$/));
        expect(q('[data-testid="video-link"]')).toBeNull();
    });

    it('set to a YouTube link: shown on the instruction pages, with a play icon, and opened in the system browser', async () => {
        mount({ videoUrl: 'https://youtu.be/dQw4w9WgXcQ' });
        await flush();
        const link = q('[data-testid="video-link"]')!;
        expect(link.textContent).toMatch(/Watch a video/);
        expect(link.querySelector('svg')).not.toBeNull();
        await click(link);
        expect(onOpenExternal).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ');
        await pasteToken();
        await click(button(/^Continue$/));
        expect(q('[data-testid="video-link"]')).not.toBeNull(); // the add-the-bot page too
    });

    it('anything that is not an https YouTube link is never shown (so never opened)', async () => {
        for (const bad of ['http://youtube.com/watch?v=x', 'https://evil.example/watch?v=x', 'https://youtube.com.evil.example/x', 'javascript:alert(1)']) {
            mount({ videoUrl: bad });
            await flush();
            expect(q('[data-testid="video-link"]')).toBeNull();
        }
    });
});

describe('message copy: a channel that did not come over is a FAILURE with a Retry, never a success line (2026-11-22)', () => {
    const MSG = (id: string) => ({
        id, ts: '2026-11-20T10:00:00.000Z', edited: false, author: { id: '900000000000000001', name: 'Alex', username: 'alex_92', kind: 'user', avatarRef: null },
        content: `hello ${id}`, mentionNames: {}, replyTo: null, files: [], embeds: [], stickers: [], forwarded: null, poll: null, pinned: false, reactions: [],
    });
    const OK_HISTORY = { ok: true, messages: [MSG('900000000000000101'), MSG('900000000000000102')], pins: [], truncated: false, ceilingHit: false, reactionRequests: 0, names: { roles: {}, channels: {} } };

    function historyFake() {
        let next = 0;
        const hapi = {
            createSession: vi.fn(async () => ({ id: 'imp-1' })),
            registerAuthors: vi.fn(async (_i: string, a: unknown[]) => ({ author_ids: a.map(() => '44444444-4444-4444-8444-444444444444') })),
            postBatch: vi.fn(async (_i: string, b: { rows: unknown[] }) => { const ids = b.rows.map((_r, k) => `row-${next + k}`); next += b.rows.length; return { ids, seq_next: next }; }),
            initiateFiles: vi.fn(async () => []),
            save: vi.fn(async () => ({ results: [], used_bytes: 0, limit_bytes: 0 })),
            complete: vi.fn(async () => ({})),
        };
        const history = {
            api: () => hapi,
            prepareChannelKeys: vi.fn(async () => undefined),
            sealRow: vi.fn(async (json: string) => ({ epoch: 1, nonce_b64: 'bg==', ciphertext_b64: btoa(json.slice(0, 20)), signature_b64: 'c2ln' })),
            encryptFile: vi.fn(),
            upload: vi.fn(),
            storage: vi.fn(async () => ({ used_bytes: 0, limit_bytes: 0 })),
            emojiIds: vi.fn(async () => ({})),
            cancel: vi.fn(async () => ({ deleted: 0 })),
            deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            maxFileBytes: 100 * 1024 * 1024,
        };
        return { hapi, history: history as unknown as NonNullable<Props['history']> };
    }

    async function runWithMessages(history: NonNullable<Props['history']>) {
        h.importGuild = vi.fn(async () => ({ server_id: 'srv-9', name: 'Pixel Farm Co-op', channel_refs: { 'c:1': 'ch-1' } })) as unknown as typeof h.importGuild;
        await toPreview({ history });
        await click(button(/^Continue$/));
        for (const box of [...host.querySelectorAll('[role="checkbox"]')]) await click(box);
        await click(button(/Import server/));
        await flush(); await flush();
    }

    it('the channel Discord would not give us is listed as not copied, with the reason and a Retry that brings it over', async () => {
        api.history.mockResolvedValueOnce({ ok: false, error: { code: 'history_hidden', message: 'Discord sent no messages for this channel, but it has some: the bot can’t read its history.' } });
        const { hapi, history } = historyFake();
        await runWithMessages(history);
        // Owner 2026-11-22: the report says "issues found" in the danger colour, first thing.
        expect(q('[data-testid="import-issues"]')?.className).toMatch(/dlg-note--danger/);
        expect(q('[data-testid="import-issues-title"]')?.textContent).toBe('Import finished — issues found');
        const alert = q('[data-testid="history-failed"]');
        expect(alert?.textContent).toMatch(/#general didn’t come over: Discord sent no messages for this channel/);
        expect(q('[data-testid="history-line-failed"]')?.textContent).toMatch(/#general — not copied: Discord sent no messages for this channel/);
        expect(q('[data-testid="history-line"]')).toBeNull();
        expect(hapi.complete).not.toHaveBeenCalled(); // kept open for the retry
        api.history.mockResolvedValueOnce(OK_HISTORY);
        expect(q('[data-testid="history-retry-one"]')?.textContent).toBe('Retry #general');
        await click(q('[data-testid="history-retry-one"] button'));
        await flush(); await flush();
        expect(q('[data-testid="history-failed"]')).toBeNull();
        expect(q('[data-testid="import-issues"]')).toBeNull();
        expect(q('[data-testid="history-line"]')?.textContent).toMatch(/#general — 2 messages/);
        expect(hapi.createSession).toHaveBeenCalledTimes(1); // the same session
        expect(hapi.complete).toHaveBeenCalledTimes(1);
    });

    it('Open server with a channel still to retry KEEPS the job (pill + Retry later); only Dismiss -> confirm closes the session', async () => {
        api.history.mockResolvedValueOnce({ ok: false, error: { code: 'discord_down', message: 'Discord is having trouble right now. Try again in a minute.' } });
        const { hapi, history } = historyFake();
        await runWithMessages(history);
        expect(q('[data-testid="history-failed"]')).not.toBeNull();
        await click(button(/^Open server$/));
        await flush();
        // The job (and its session) survive: the title-bar pill says "1 channel failed · Retry".
        expect(hapi.complete).not.toHaveBeenCalled();
        expect(job.getImportJob()?.phase).toBe('done');
        expect(job.importJobIssues(job.getImportJob()).retryable).toHaveLength(1);
    });

    it('Dismiss asks first ("you can still copy it later") and only then closes the session', async () => {
        api.history.mockResolvedValueOnce({ ok: false, error: { code: 'discord_down', message: 'Discord is having trouble right now. Try again in a minute.' } });
        const { hapi, history } = historyFake();
        await runWithMessages(history);
        await click(q('[data-testid="import-dismiss"] button'));
        expect(q('[data-testid="dismiss-ask"]')?.textContent).toMatch(/Dismiss without retrying\?.*Copy messages from Discord/);
        expect(hapi.complete).not.toHaveBeenCalled();
        await click(button(/^Keep it$/));
        expect(q('[data-testid="dismiss-ask"]')).toBeNull();
        expect(job.getImportJob()).not.toBeNull();
        await click(q('[data-testid="import-dismiss"] button'));
        await click(q('[data-testid="dismiss-confirm"] button'));
        await flush();
        expect(hapi.complete).toHaveBeenCalledTimes(1);
        expect(job.getImportJob()).toBeNull();
    });
});

describe('"Copy messages from Discord" into an existing server (owner 2026-11-22)', () => {
    const COPY_SNAPSHOT: Snapshot = {
        ...SNAPSHOT,
        body: { name: 'Pixel Farm Co-op', roles: [], channels: [
            { id: 1, type: 0, name: 'general_chat', position: 0 },
            { id: 2, type: 0, name: 'files_pictures', position: 1 },
            { id: 3, type: 0, name: 'rules', position: 2 },
            { id: 4, type: 2, name: 'Voice', position: 3 },
        ] },
        channelKeys: { 1: 'a'.repeat(64), 2: 'b'.repeat(64), 3: 'c'.repeat(64) },
    };
    const TARGETS = [
        { channel_id: 'ch-general', name: 'general_chat' },
        { channel_id: 'ch-files', name: 'files_pictures' },
        { channel_id: 'ch-rules', name: 'rules' },
    ];
    function copyHistory(map: unknown) {
        const sessions: Array<Record<string, unknown>> = [];
        const hapi = {
            createSession: vi.fn(async (b: Record<string, unknown>) => { sessions.push(b); return { id: 'imp-c' }; }),
            registerAuthors: vi.fn(async (_i: string, a: unknown[]) => ({ author_ids: a.map(() => '44444444-4444-4444-8444-444444444444') })),
            postBatch: vi.fn(async (_i: string, b: { rows: unknown[]; seq_start: number }) => ({ ids: b.rows.map((_r, k) => `row-${b.seq_start + k}`), seq_next: b.seq_start + b.rows.length })),
            initiateFiles: vi.fn(async () => []),
            save: vi.fn(async () => ({ results: [], used_bytes: 0, limit_bytes: 0 })),
            complete: vi.fn(async () => ({})),
        };
        const history = {
            api: () => hapi,
            prepareChannelKeys: vi.fn(async () => undefined),
            existingChannelKeys: vi.fn(async () => []),
            channelMap: vi.fn(async () => map),
            endActive: vi.fn(async () => ({ ended: true, rows_posted: 3 })),
            sealRow: vi.fn(async (json: string) => ({ epoch: 1, nonce_b64: 'bg==', ciphertext_b64: btoa(json.slice(0, 20)), signature_b64: 'c2ln' })),
            encryptFile: vi.fn(), upload: vi.fn(),
            storage: vi.fn(async () => ({ used_bytes: 0, limit_bytes: 0 })),
            emojiIds: vi.fn(async () => ({})),
            cancel: vi.fn(async () => ({ deleted: 0 })),
            deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            maxFileBytes: 100 * 1024 * 1024,
        };
        return { hapi, sessions, history };
    }
    const MSG = (id: string) => ({
        id, ts: '2026-11-20T10:00:00.000Z', edited: false, author: { id: '900000000000000001', name: 'Alex', username: 'alex_92', kind: 'user', avatarRef: null },
        content: `hello ${id}`, mentionNames: {}, replyTo: null, files: [], embeds: [], stickers: [], forwarded: null, poll: null, pinned: false, reactions: [],
    });

    async function toCopyMap(c: ReturnType<typeof copyHistory>) {
        api.snapshot.mockResolvedValue({ ok: true, snapshot: COPY_SNAPSHOT });
        mount({ history: c.history as unknown as NonNullable<Props['history']>, copyInto: { serverId: 'srv-old', serverName: 'Pixel Farm', channels: TARGETS } });
        await flush();
        await pasteToken();
        await click(button(/^Continue$/));
        await click(host.querySelectorAll('[role="radio"]')[0]);
        await click(button(/^Choose channels$/));
        await flush();
    }

    it('THE OWNER\'S CASE: the channels that already got messages are skipped, the two empty ones are filled; the import quota is shown', async () => {
        const c = copyHistory({
            channels: [{ channel_id: 'ch-rules', imported_rows: 40, from: [], unknown_source_rows: 40 }],
            imports: { used: 1, limit: 3, window_days: 30 }, active: null,
        });
        await toCopyMap(c);
        expect(text()).toMatch(/Copy messages from Discord/);
        expect(h.preview).not.toHaveBeenCalled();                 // no new server is previewed
        expect(c.history.channelMap).toHaveBeenCalledWith('srv-old', ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
        const rows = [...host.querySelectorAll('[data-testid="copy-row"]')];
        expect(rows.map(r => r.getAttribute('data-status'))).toEqual(['ready', 'ready', 'unknown']);   // the voice channel is not offered
        expect(rows[2].textContent).toMatch(/already has 40 imported messages.*skipped so nothing is copied twice/);
        expect(q('[data-testid="copy-picked"]')?.textContent).toBe('2 of 2 channels to copy');
        expect(q('[data-testid="copy-quota"]')?.textContent).toMatch(/one of the server’s 3 message imports per 30 days \(1 used, 2 left\)/);
        await click(button(/^Continue$/));
        expect(q('[data-testid="copy-consent-list"]')?.textContent).toMatch(/2 Discord channels.*#general_chat, #files_pictures.*Pixel Farm/);
        expect(button(/^Copy messages$/)?.disabled).toBe(true);
        for (const box of [...host.querySelectorAll('[role="checkbox"]')]) await click(box);
        api.history.mockResolvedValue({ ok: true, messages: [MSG('900000000000000101'), MSG('900000000000000102')], pins: [], truncated: false, ceilingHit: false, reactionRequests: 0, names: { roles: {}, channels: {} } });
        await click(button(/^Copy messages$/));
        await flush(); await flush(); await flush();
        expect(c.sessions).toHaveLength(1);
        expect(c.sessions[0]).toMatchObject({
            channel_ids: ['ch-general', 'ch-files'],
            channel_sources: [{ channel_id: 'ch-general', source_key: 'a'.repeat(64) }, { channel_id: 'ch-files', source_key: 'b'.repeat(64) }],
        });
        expect(api.history.mock.calls.map(x => (x[0] as { channel: number }).channel)).toEqual([1, 2]);   // never #rules
        expect(h.importGuild).not.toHaveBeenCalled();
        expect(c.history.prepareChannelKeys).not.toHaveBeenCalled();
        expect(c.history.existingChannelKeys).toHaveBeenCalledWith('srv-old', ['ch-general', 'ch-files']);
        expect(q('[data-testid="copy-done"]')?.textContent).toMatch(/4 messages copied into Pixel Farm/);
    });

    it('nothing copyable and the quota used up: Continue stays off', async () => {
        await toCopyMap(copyHistory({
            channels: [
                { channel_id: 'ch-general', imported_rows: 5, from: [{ source: 0, rows: 5 }], unknown_source_rows: 0 },
                { channel_id: 'ch-files', imported_rows: 5, from: [], unknown_source_rows: 5 },
                { channel_id: 'ch-rules', imported_rows: 5, from: [], unknown_source_rows: 5 },
            ],
            imports: { used: 3, limit: 3, window_days: 30 }, active: null,
        }));
        expect([...host.querySelectorAll('[data-testid="copy-row"]')].map(r => r.getAttribute('data-status'))).toEqual(['copied', 'unknown', 'unknown']);
        expect(q('[data-testid="copy-quota"]')?.textContent).toMatch(/already used its 3 message imports/);
        expect(button(/^Continue$/)?.disabled).toBe(true);
    });

    it('an import of this account still open here: "End that import now" ends it (keeps what it copied)', async () => {
        const c = copyHistory({ channels: [], imports: { used: 1, limit: 3, window_days: 30 }, active: { idle_minutes: 3, supersedable: false } });
        await toCopyMap(c);
        expect(q('[data-testid="copy-active"]')?.textContent).toMatch(/still running here \(active 3 minutes ago\)/);
        await click(q('[data-testid="copy-end-active"]'));
        expect(c.history.endActive).toHaveBeenCalledWith('srv-old');
        expect(q('[data-testid="copy-active"]')).toBeNull();
    });

    it('an older API without the channel map (404): matched by name, still copyable, no quota line', async () => {
        const c = copyHistory(null);
        c.history.channelMap.mockRejectedValueOnce(Object.assign(new Error('nf'), { response: { status: 404 } }));
        await toCopyMap(c);
        expect([...host.querySelectorAll('[data-testid="copy-row"]')].map(r => r.getAttribute('data-status'))).toEqual(['ready', 'ready', 'ready']);
        expect(q('[data-testid="copy-quota"]')).toBeNull();
    });
});
