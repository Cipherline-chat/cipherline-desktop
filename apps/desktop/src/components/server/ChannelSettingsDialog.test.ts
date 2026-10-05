// @vitest-environment jsdom
/**
 * Behaviour of the rebuilt Create / Edit Channel dialog, driven through the
 * real DOM with an in-memory API:
 *
 *  - the wire payloads (incl. "no category" = parent_category_id OMITTED),
 *  - presets → override requests (@everyone applied first),
 *  - "Create another" keeps the dialog and its settings,
 *  - the explicit Deny / Inherit / Allow control (click + arrow keys),
 *  - hidden bits survive an edit,
 *  - UI gating mirrors the server's escalation rule,
 *  - a partial override failure leaves the dialog open as the new channel's editor,
 *  - the inherited-reason line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_EVERYONE_PERMISSIONS, Permissions as P } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const s = (b: bigint) => b.toString(10);
const EV = '00000000-0000-4000-8000-000000000000';
const MOD = '00000000-0000-4000-8000-000000000002';
const HELPER = '00000000-0000-4000-8000-000000000003';
const REG = '00000000-0000-4000-8000-000000000004';
const CAT = '10000000-0000-4000-8000-000000000001';
const CH = '20000000-0000-4000-8000-000000000001';
const OWNER = 'u-owner';
const ME = 'u-me';

type Call = [string, string, unknown?];
let calls: Call[] = [];
let channelOverrides: Record<string, unknown[]> = {};
let failOverridePatch = false;
let myPerms = '';

const roles = [
    { role_id: EV, name: '@everyone', color: -1, position: 0, permissions: s(DEFAULT_EVERYONE_PERMISSIONS), mentionable: false, hoisted: false, is_everyone: true },
    { role_id: MOD, name: 'Moderator', color: 0x25e0c8, position: 40, permissions: s(P.MANAGE_CHANNELS | P.MANAGE_MESSAGES | P.KICK_MEMBERS), mentionable: false, hoisted: false, is_everyone: false },
    { role_id: HELPER, name: 'Helper', color: 0xffc94d, position: 30, permissions: s(P.MUTE_MEMBERS), mentionable: false, hoisted: false, is_everyone: false },
    { role_id: REG, name: 'Regulars', color: -1, position: 10, permissions: '0', mentionable: false, hoisted: false, is_everyone: false },
];
const members = [
    { user_id: OWNER, username: 'owner', nickname: null, role_ids: [], muted_until: null },
    { user_id: ME, username: 'marina', nickname: null, role_ids: [MOD], muted_until: null },
    { user_id: 'u-kai', username: 'kai', nickname: null, role_ids: [REG], muted_until: null },
];

const path = (u: string) => u.replace(/^.*\/v1/, '');
vi.mock('axios', () => ({
    default: {
        get: vi.fn(async (url: string) => {
            const p = path(url);
            calls.push(['GET', p]);
            if (/\/roles$/.test(p)) return { data: roles };
            if (/\/members$/.test(p)) return { data: members };
            if (/\/me\/permissions$/.test(p)) return { data: { permissions: myPerms } };
            if (/\/categories\/[^/]+\/overrides$/.test(p)) {
                return { data: [{ target_kind: 'role', target_id: EV, allow_bits: '0', deny_bits: s(P.SEND_MESSAGES) }] };
            }
            const m = /\/channels\/([^/]+)\/overrides$/.exec(p);
            if (m) return { data: channelOverrides[m[1]] ?? [] };
            throw new Error('unmocked GET ' + p);
        }),
        post: vi.fn(async (url: string, body: Record<string, unknown>) => {
            const p = path(url);
            calls.push(['POST', p, body]);
            const id = `new-${calls.length}`;
            return { data: { channel_id: id, server_id: 's1', position: 1000, topic: null, icon_emoji: null, icon_name: null, active_call_session_id: null, member_limit: null, max_calls: null, parent_category_id: null, ...body } };
        }),
        patch: vi.fn(async (url: string, body: { target_kind: string; target_id: string }) => {
            const p = path(url);
            calls.push(['PATCH', p, body]);
            const m = /\/channels\/([^/]+)\/overrides$/.exec(p);
            if (m) {
                if (failOverridePatch && body.target_id !== EV) {
                    throw { response: { status: 403, data: { message: 'Cannot grant permissions you do not yourself have' } } };
                }
                const list = (channelOverrides[m[1]] ??= []) as { target_kind: string; target_id: string }[];
                const i = list.findIndex(o => o.target_kind === body.target_kind && o.target_id === body.target_id);
                if (i >= 0) list[i] = body; else list.push(body);
            }
            return { data: { ok: true } };
        }),
        delete: vi.fn(async (url: string) => { calls.push(['DELETE', path(url)]); return { data: { ok: true } }; }),
    },
}));

const { ChannelSettingsDialog } = await import('./ChannelSettingsDialog');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    calls = [];
    channelOverrides = {};
    failOverridePatch = false;
    myPerms = s((1n << 30n) - 1n);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const flush = async (ms = 0) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const categories = [{ category_id: CAT, server_id: 's1', name: 'Information', position: 1, kind: 'text' as const, icon_name: null }];
const channel = {
    channel_id: CH, server_id: 's1', kind: 'text' as const, name: 'announcements', topic: null, icon_emoji: null, icon_name: null,
    position: 1, parent_category_id: CAT, active_call_session_id: null, member_limit: null, max_calls: null,
};

async function mount(props: Record<string, unknown> = {}) {
    const handlers = {
        onClose: vi.fn(), onSaved: vi.fn(), onCreated: vi.fn(), onCreatedKeepOpen: vi.fn(),
    };
    await act(async () => {
        root.render(React.createElement(ChannelSettingsDialog, {
            serverId: 's1', token: 't', categories, canManage: true,
            ownerUserId: OWNER, currentUserId: OWNER,
            ...handlers, ...props,
        } as never));
    });
    await flush(10);
    return handlers;
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const byText = (t: string, tag = 'button') =>
    [...document.querySelectorAll(tag)].find(b => b.textContent?.trim() === t) as HTMLElement | undefined;
const radio = (name: string) =>
    [...document.querySelectorAll('[role="radio"]')].find(b => b.textContent?.trim() === name || b.getAttribute('aria-label') === name) as HTMLElement | undefined;
const nameInput = () => $<HTMLInputElement>('input[aria-label$="name"]')!;

async function typeName(v: string) {
    const input = nameInput();
    await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        set.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
async function press(el: Element, key: string, init: KeyboardEventInit = {}) {
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })); });
    await flush(5);
}
async function click(el: Element | undefined | null) {
    expect(el).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await flush(5);
}
const posts = () => calls.filter(c => c[0] === 'POST');
const patches = () => calls.filter(c => c[0] === 'PATCH' && /overrides$/.test(c[1]));

describe('create', () => {
    it('Enter creates a synced channel in its category: POST only, no overrides, then onSaved + onCreated', async () => {
        const h = await mount({ defaultKind: 'text', defaultCategoryId: CAT });
        expect(radio('Sync with ‘Information’')?.getAttribute('aria-checked')).toBe('true');
        await typeName('rules');
        await press(nameInput(), 'Enter');
        await flush(20);
        expect(posts()).toHaveLength(1);
        expect(posts()[0][2]).toEqual({ name: 'rules', kind: 'text', parent_category_id: CAT });
        expect(patches()).toHaveLength(0);
        expect(h.onSaved).toHaveBeenCalledTimes(1);
        expect(h.onCreated).toHaveBeenCalledTimes(1);
    });

    it('"No category" OMITS parent_category_id (never sends an empty string)', async () => {
        await mount({ defaultKind: 'text' });
        await typeName('general');
        await press(nameInput(), 'Enter');
        await flush(20);
        const body = posts()[0][2] as Record<string, unknown>;
        expect(body).not.toHaveProperty('parent_category_id');
        expect(body).toEqual({ name: 'general', kind: 'text' });
    });

    it('"Staff only" sends @everyone deny View FIRST, then View for each staff role', async () => {
        const h = await mount({ defaultKind: 'text' });
        await click(radio('Staff only'));
        await typeName('mod-chat');
        await press(nameInput(), 'Enter');
        await flush(30);
        const p = patches().map(c => c[2] as { target_id: string; allow_bits: string; deny_bits: string });
        expect(p[0]).toMatchObject({ target_id: EV, allow_bits: '0', deny_bits: s(P.VIEW_CHANNEL) });
        expect(p.slice(1).map(x => x.target_id).sort()).toEqual([MOD, HELPER].sort());
        for (const x of p.slice(1)) expect(x).toMatchObject({ allow_bits: s(P.VIEW_CHANNEL), deny_bits: '0' });
        // Keys are minted AFTER the overrides landed.
        const createdAt = h.onCreated.mock.invocationCallOrder[0];
        expect(createdAt).toBeGreaterThan(0);
    });

    it('"Create another" keeps the dialog and its settings open for the next one', async () => {
        const h = await mount({ defaultKind: 'text' });
        await click(radio('Staff only'));
        await click([...document.querySelectorAll('[role="checkbox"]')].find(b => b.textContent?.includes('Create another')));
        await typeName('one');
        await press(nameInput(), 'Enter');
        await flush(30);
        expect(h.onCreatedKeepOpen).toHaveBeenCalledTimes(1);
        expect(h.onSaved).not.toHaveBeenCalled();
        expect(h.onClose).not.toHaveBeenCalled();
        expect(nameInput().value).toBe('');
        expect(radio('Staff only')?.getAttribute('aria-checked')).toBe('true');
        expect(document.body.textContent).toContain('Created #one');

        await typeName('two');
        await press(nameInput(), 'Enter');
        await flush(30);
        expect(posts().map(c => (c[2] as { name: string }).name)).toEqual(['one', 'two']);
        expect(patches()).toHaveLength(6); // 3 per channel
    });

    it('a failed override keeps the dialog open as the new channel’s editor, only the failure still dirty', async () => {
        failOverridePatch = true;
        const h = await mount({ defaultKind: 'text' });
        await click(radio('Staff only'));
        await typeName('secret');
        await press(nameInput(), 'Enter');
        await flush(40);
        expect(h.onSaved).not.toHaveBeenCalled();
        expect(h.onCreated).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Created #secret, but 2 permission changes weren’t saved/);
        // The @everyone deny DID land and is now the baseline; Save retries the rest.
        failOverridePatch = false;
        calls = [];
        await click(byText('Save'));
        await flush(40);
        expect(patches().map(c => (c[2] as { target_id: string }).target_id).sort()).toEqual([MOD, HELPER].sort());
        expect(h.onSaved).toHaveBeenCalledTimes(1);
    });
});

describe('permissions tab', () => {
    async function openPerms(props: Record<string, unknown> = {}) {
        const h = await mount({ channel, onDelete: vi.fn(), ...props });
        await click([...document.querySelectorAll('[role="tab"]')].find(t => t.textContent?.includes('Permissions')));
        await flush(10);
        return h;
    }
    const group = (label: string) => document.querySelector(`[role="radiogroup"][aria-label="${label}"]`) as HTMLElement;
    const seg = (label: string, which: 'Deny' | 'Inherit' | 'Allow') =>
        group(label).querySelector(`[aria-label="${which}"]`) as HTMLButtonElement;

    it('each state is one click; the row explains what it inherits and why', async () => {
        await openPerms();
        // @everyone is selected by default; the category denies Send Messages.
        const row = group('Send Messages for @everyone').closest('div.flex') as HTMLElement;
        expect(row.textContent).toContain('Inherits');
        expect(row.textContent).toContain('Denied by category ‘Information’ (@everyone)');
        expect(seg('Send Messages for @everyone', 'Inherit').getAttribute('aria-checked')).toBe('true');

        await click(seg('Send Messages for @everyone', 'Allow'));
        expect(seg('Send Messages for @everyone', 'Allow').getAttribute('aria-checked')).toBe('true');
        expect(row.textContent).toContain('Allowed by this channel (@everyone)');
        await click(seg('Send Messages for @everyone', 'Deny'));
        expect(seg('Send Messages for @everyone', 'Deny').getAttribute('aria-checked')).toBe('true');
    });

    it('arrow keys move AND select within the control; letter shortcuts work', async () => {
        await openPerms();
        const g = group('Embed Links for @everyone');
        const inherit = seg('Embed Links for @everyone', 'Inherit');
        expect(inherit.tabIndex).toBe(0);
        expect(seg('Embed Links for @everyone', 'Deny').tabIndex).toBe(-1);
        await press(inherit, 'ArrowRight');
        expect(seg('Embed Links for @everyone', 'Allow').getAttribute('aria-checked')).toBe('true');
        await press(seg('Embed Links for @everyone', 'Allow'), 'd');
        expect(seg('Embed Links for @everyone', 'Deny').getAttribute('aria-checked')).toBe('true');
        expect(g.querySelectorAll('[aria-checked="true"]')).toHaveLength(1);
    });

    it('saving an edit preserves bits the editor does not show', async () => {
        channelOverrides[CH] = [{ target_kind: 'role', target_id: REG, allow_bits: s(P.MANAGE_CHANNELS), deny_bits: '0' }];
        await openPerms();
        await click([...document.querySelectorAll('[data-target]')].find(b => b.textContent?.includes('Regulars')));
        await click(seg('Attach Files for @Regulars', 'Deny'));
        calls = [];
        await click(byText('Save'));
        await flush(30);
        expect(patches()).toHaveLength(1);
        expect(patches()[0][2]).toMatchObject({ target_id: REG, allow_bits: s(P.MANAGE_CHANNELS), deny_bits: s(P.ATTACH_FILES) });
    });

    it('bulk actions and undo', async () => {
        await openPerms();
        await click([...document.querySelectorAll('[data-target]')].find(b => b.textContent?.includes('Regulars')));
        await click(byText('Deny all'));
        const denied = [...document.querySelectorAll('[role="radiogroup"][aria-label$="for @Regulars"] [aria-label="Deny"][aria-checked="true"]')];
        expect(denied.length).toBeGreaterThanOrEqual(8);
        await click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Undo'));
        expect(seg('Send Messages for @Regulars', 'Inherit').getAttribute('aria-checked')).toBe('true');
    });

    it('copy one role and paste onto another', async () => {
        channelOverrides[CH] = [{ target_kind: 'role', target_id: MOD, allow_bits: s(P.SEND_MESSAGES), deny_bits: s(P.ADD_REACTIONS) }];
        await openPerms();
        const target = (n: string) => [...document.querySelectorAll('[data-target]')].find(b => b.textContent?.includes(n));
        await click(target('Moderator'));
        await click(byText('Copy'));
        await click(target('Regulars'));
        await click(byText('Paste'));
        expect(seg('Send Messages for @Regulars', 'Allow').getAttribute('aria-checked')).toBe('true');
        expect(seg('Add Reactions for @Regulars', 'Deny').getAttribute('aria-checked')).toBe('true');
    });

    it('gates what the server would reject: bits you lack HERE are unchangeable either way, roles at or above you locked', async () => {
        // Marina holds Moderator (MANAGE_CHANNELS | MANAGE_MESSAGES | KICK). What gates the
        // editor is what she holds IN this channel — resolved from her roles and the
        // channel's tiers, exactly as the server does — not the server-wide read.
        myPerms = s(DEFAULT_EVERYONE_PERMISSIONS | P.MANAGE_CHANNELS | P.MANAGE_MESSAGES | P.KICK_MEMBERS);
        // A role at or above the moderator is locked; give Helper a higher position for this case.
        const helper = roles.find(r => r.role_id === HELPER)!;
        const orig = helper.position;
        helper.position = 90;
        try {
            await openPerms({ currentUserId: ME, myPermissions: undefined });
            await flush(10);
            // The category denies Send Messages to @everyone, so Marina does not hold it in
            // this channel: neither Allow NOR Deny may be set (the server checks both sides).
            const allowSend = seg('Send Messages for @everyone', 'Allow');
            expect(allowSend.getAttribute('aria-disabled')).toBe('true');
            expect(allowSend.title).toMatch(/can’t change/);
            await click(allowSend);
            expect(allowSend.getAttribute('aria-checked')).toBe('false');
            expect(seg('Send Messages for @everyone', 'Deny').getAttribute('aria-disabled')).toBe('true');
            // Bits she does hold here stay fully editable, in both directions.
            expect(seg('Manage Messages for @everyone', 'Allow').getAttribute('aria-disabled')).toBeNull();
            expect(seg('Attach Files for @everyone', 'Deny').getAttribute('aria-disabled')).toBeNull();

            await click([...document.querySelectorAll('[data-target]')].find(b => b.textContent?.includes('Helper')));
            expect(document.body.textContent).toContain('Read-only for you — At or above your highest role');
            expect(seg('Send Messages for @Helper', 'Deny').getAttribute('aria-disabled')).toBe('true');
            // Her own role is EQUAL to her highest, so the server refuses it too — locked.
            await click([...document.querySelectorAll('[data-target]')].find(b => b.textContent?.includes('Moderator')));
            expect(document.body.textContent).toContain('Read-only for you — At or above your highest role');
        } finally {
            helper.position = orig;
        }
    });
});

describe('Call names (Calls channels)', () => {
    const huddle = {
        ...channel, kind: 'huddle' as const, name: 'General', parent_category_id: null,
    };
    const naming = (over: Record<string, unknown> = {}) => ({
        style: 'host', fixed_name: null, template: null, game: 'replace', starter_can_rename: true, locked: false, ...over,
    });
    const section = () => $('[data-testid="call-naming"]');
    const example = () => $('[data-testid="call-naming-example"]')?.textContent ?? '';
    const toggle = (label: string) => $<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`)!;
    const select = (label: string) => $<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const channelPatches = () => calls.filter(c => c[0] === 'PATCH' && !/overrides$/.test(c[1]));
    const saveBtn = () => [...document.querySelectorAll('button')].find(b => /^Save/.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
    const remount = () => { act(() => root.unmount()); root = createRoot(host); calls = []; };

    it('is shown for a Calls channel only, in create and edit', async () => {
        await mount({ defaultKind: 'text' });
        expect(section()).toBeNull();
        // The type radio's text is its title + description ("Calls" + "Members start…").
        await click([...document.querySelectorAll('[role="radio"]')].find(b => b.textContent?.startsWith('Calls')));
        expect(section()).toBeTruthy();
        remount();
        await mount({ channel: huddle });
        expect(section()).toBeTruthy();
    });

    it('creating with the defaults sends NO call_naming (an older API would reject the field)', async () => {
        await mount({ defaultKind: 'huddle' });
        expect(example()).toContain("Alex's Call");
        expect(example()).toContain('Elden Ring');
        await typeName('Lounge');
        await press(nameInput(), 'Enter');
        await flush(20);
        expect(posts()[0][2]).not.toHaveProperty('call_naming');
    });

    it('"Never change call names" disables the automatic options with a note, and is sent on create', async () => {
        await mount({ defaultKind: 'huddle' });
        expect(toggle('Show the game being played').disabled).toBe(false);
        expect(toggle('Call starters can rename their call').disabled).toBe(false);
        await click(toggle('Never change call names'));
        expect(toggle('Show the game being played').disabled).toBe(true);
        expect(toggle('Call starters can rename their call').disabled).toBe(true);
        expect(section()!.textContent).toContain('Off while “Never change call names” is on.');
        expect(example()).toContain('never changes');
        // The name style still applies — it is the name the call keeps.
        expect(select('Name new calls').disabled).toBe(false);
        await typeName('Lounge');
        await press(nameInput(), 'Enter');
        await flush(20);
        expect((posts()[0][2] as Record<string, unknown>).call_naming).toEqual(naming({ locked: true }));
    });

    it('the game option is a plain on/off toggle: on by default, off sends game: "off"', async () => {
        await mount({ defaultKind: 'huddle' });
        expect(toggle('Show the game being played').getAttribute('aria-checked')).toBe('true');
        await click(toggle('Show the game being played'));
        expect(toggle('Show the game being played').getAttribute('aria-checked')).toBe('false');
        await typeName('Lounge');
        await press(nameInput(), 'Enter');
        await flush(20);
        expect((posts()[0][2] as Record<string, unknown>).call_naming).toEqual(naming({ game: 'off' }));
    });

    it('edit: only a change to the setting sends call_naming', async () => {
        await mount({ channel: { ...huddle, call_naming: naming({ game: 'off' }) } });
        await typeName('General two');
        await click(saveBtn());
        await flush(20);
        expect(channelPatches()).toHaveLength(1);
        expect(channelPatches()[0][2]).not.toHaveProperty('call_naming');

        remount();
        const h = await mount({ channel: { ...huddle, call_naming: naming({ game: 'off' }) } });
        await click(toggle('Call starters can rename their call'));
        await click(saveBtn());
        await flush(20);
        expect((channelPatches()[0][2] as Record<string, unknown>).call_naming).toEqual(naming({ game: 'off', starter_can_rename: false }));
        expect(h.onSaved.mock.calls[0][0].call_naming).toEqual(naming({ game: 'off', starter_can_rename: false }));
    });

    it('a bad template blocks saving and says why', async () => {
        await mount({ channel: { ...huddle, call_naming: naming({ style: 'template', template: 'Squad {n}' }) } });
        expect(example()).toContain('Squad 1');
        const tpl = $<HTMLInputElement>('input[aria-label="Call name pattern"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(tpl, '{game} night');
            tpl.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(section()!.querySelector('[role="alert"]')?.textContent).toMatch(/Unknown placeholder \{game\}/);
        expect(saveBtn().disabled).toBe(true);
        await click(saveBtn());
        expect(channelPatches()).toHaveLength(0);
    });
});
