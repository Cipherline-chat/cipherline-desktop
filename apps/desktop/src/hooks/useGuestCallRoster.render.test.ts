// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A member dragged into a call whose channel they cannot see must get the same
 * call card as anyone else in it. Runs the real useServers state, the real
 * useGuestCallRoster, the real displayHuddleCalls and the real FloatingHuddleCard
 * against a fake API that behaves like HuddlesService.listCalls: it answers a
 * guest with their own call and refuses them once they are out of it.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    window.scrollTo = (() => {}) as typeof window.scrollTo; // jsdom: motion measures through it
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

vi.mock('../components/EncryptedAvatar', () => ({
    EncryptedAvatar: () => React.createElement('span', { 'data-avatar': '1' }),
}));

const api = vi.hoisted(() => ({
    get: vi.fn(),
}));
vi.mock('axios', () => {
    const client = { get: api.get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
    return { default: client, ...client };
});

import { useServers, type HuddleCallInfo } from './useServers';
import { useGuestCallRoster } from './useGuestCallRoster';
import { displayHuddleCalls } from '../utils/joinView';
import { buildCallIdentityMap, unresolvedCallParticipants } from '../utils/callIdentity';
import { __resetRosterCache } from '../utils/serverRosterCache';
import { FloatingHuddleCard } from '../components/call/FloatingHuddleCard';

const ME = 'u-guest';
const ANA = 'u-ana';
const BEN = 'u-ben';
const CARA = 'u-cara';
const SRV = 's-1';
const PRIV = 'ch-private';
const CALL = 'call-staff';
const GUEST = { callId: CALL, huddleId: PRIV };

const members = [
    { user_id: ME, username: 'guest', nickname: null, avatar_url: null, discriminator: null, status: 'online' },
    { user_id: ANA, username: 'ana', nickname: 'Ana N', avatar_url: 'att-ana', discriminator: null, status: 'online' },
    { user_id: BEN, username: 'ben', nickname: null, avatar_url: null, discriminator: null, status: 'online' },
    { user_id: CARA, username: 'cara', nickname: null, avatar_url: null, discriminator: null, status: 'online' },
];
const row = (participants: string[]): HuddleCallInfo => ({
    call_id: CALL, huddle_id: PRIV, name: 'Staff call', spawner_user_id: ANA,
    spawned_at: '2026-10-31T00:00:00.000Z', participants,
});

/** What the fake server says about GET /huddles/:hid/calls for this client. */
let server: { isGuest: boolean; roster: string[] };
let pending: Array<() => void> | null;

function fakeGet(url: string) {
    if (url.endsWith(`/huddles/${PRIV}/calls`)) {
        const answer = () => (server.isGuest
            ? Promise.resolve({ data: [row(server.roster)] })
            : Promise.reject(Object.assign(new Error('forbidden'), { response: { status: 403 } })));
        if (!pending) return answer();
        return new Promise((resolve, reject) => { pending!.push(() => { answer().then(resolve, reject); }); });
    }
    if (url.endsWith(`/servers/${SRV}/members`)) return Promise.resolve({ data: members });
    return Promise.resolve({ data: [] });
}

let hooks: ReturnType<typeof useServers>;
let setGuest: (g: typeof GUEST | null) => void;
let setToken: (t: string) => void;

interface ClientProps {
    /** False = an ordinary participant, or a guest before this fix. */
    guestEnabled?: boolean;
    canServerMute?: boolean;
    /** Names as the presence seed's `users` delivers them on the ordinary path. */
    seedNames?: Record<string, string>;
}

/** Dashboard's derivation of the floating card, without the other 15k lines. */
const Client: React.FC<ClientProps> = ({ guestEnabled = true, canServerMute = false, seedNames = {} }) => {
    const [token, setTok] = useState('tok-1');
    const s = useServers(token, ME, 'dev-1');
    const [guest, setG] = useState<typeof GUEST | null>(GUEST);
    useEffect(() => { hooks = s; setToken = setTok; setGuest = setG; }, [s]);
    const [names, setNames] = useState<Record<string, string>>(seedNames);
    const [avatars, setAvatars] = useState<Record<string, string>>({});
    const live = displayHuddleCalls(s.huddleCalls, null, ME, guest?.callId ?? null).calls[PRIV]?.find(c => c.call_id === CALL) ?? null;
    useGuestCallRoster({
        guest: guestEnabled ? guest : null,
        serverId: SRV,
        token,
        unresolvedIds: unresolvedCallParticipants(live?.participants ?? [], ME, { voiceNames: names }),
        load: s.loadGuestCallRoster,
        drop: s.dropGuestCallRoster,
        onIdentities: ids => {
            setNames(p => ({ ...p, ...Object.fromEntries(ids.map(i => [i.userId, i.name])) }));
            setAvatars(p => ({ ...p, ...Object.fromEntries(ids.filter(i => i.avatarId).map(i => [i.userId, i.avatarId!])) }));
        },
    });
    const ids = live?.participants ?? [ME];
    return guest ? React.createElement(FloatingHuddleCard, {
        channelName: 'Staff call', iconName: null, iconEmoji: null, maxCalls: null,
        callId: CALL, callName: live?.name ?? 'Staff call', spawnedAt: live?.spawned_at,
        participantIds: ids, canRename: false, token, userId: ME, myUsername: 'guest', myAvatarUrl: null,
        friendNameMap: buildCallIdentityMap(ids, { voiceNames: names, voiceAvatars: avatars }),
        expanded: true, onToggleExpanded: () => {}, canServerMute, onServerMuteTrack: canServerMute ? () => {} : undefined,
    }) : null;
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    server = { isGuest: true, roster: [ANA, BEN, ME] };
    pending = null;
    api.get.mockReset();
    api.get.mockImplementation(fakeGet);
    __resetRosterCache();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0)); });
async function mount(props: ClientProps = {}) {
    await act(async () => { root.render(React.createElement(Client, props)); });
    await settle();
}
/** The roster as the user reads it: every row's name, sorted. */
function rosterText(): string[] {
    return [...host.querySelectorAll('span.flex-1.truncate')].map(n => n.textContent ?? '').sort();
}
function rowFor(name: string): HTMLElement {
    const el = [...host.querySelectorAll('span.flex-1.truncate')].find(n => n.textContent === name);
    if (!el) throw new Error(`no row for ${name}; have ${rosterText().join(', ')}`);
    return el.parentElement as HTMLElement;
}

describe('the call card of a member moved into a private call', () => {
    it('lists everyone in the call, by name, not just themselves', async () => {
        await mount();
        expect(rosterText()).toEqual(['Ana N', 'ben', 'guest (you)']);
    });

    it('is the card someone who joined by clicking sees for the same call', async () => {
        await mount();
        const guestRoster = rosterText();
        const guestCounts = host.textContent?.match(/\d+ in (voice|call)/g);
        expect(guestCounts).toEqual(['3 in voice', '3 in call']);

        // The ordinary path: the row and the names arrive in the presence seed.
        act(() => { root.unmount(); });
        root = createRoot(host);
        await mount({ guestEnabled: false, seedNames: { [ANA]: 'Ana N', [BEN]: 'ben' } });
        await act(async () => { hooks.applyHuddleCallsSnapshot({ [PRIV]: [row([ANA, BEN, ME])] }); });
        await settle();
        expect(rosterText()).toEqual(guestRoster);
        expect(host.textContent?.match(/\d+ in (voice|call)/g)).toEqual(guestCounts);
    });

    it('without the roster load the card shows only themselves (the bug)', async () => {
        await mount({ guestEnabled: false });
        // Events do not help: a channel with no bucket drops them.
        await act(async () => { hooks.applyHuddleParticipant(PRIV, CALL, ANA, 'join'); });
        expect(rosterText()).toEqual(['guest (you)']);
        expect(host.textContent?.match(/\d+ in (voice|call)/g)).toEqual(['1 in voice', '1 in call']);
    });

    it('follows joins and leaves after the first load', async () => {
        await mount();
        await act(async () => { hooks.applyHuddleParticipant(PRIV, CALL, CARA, 'join'); });
        await settle();
        expect(rosterText()).toContain('cara');
        await act(async () => { hooks.applyHuddleParticipant(PRIV, CALL, BEN, 'leave'); });
        expect(rosterText()).not.toContain('ben');
    });

    it('right-clicking a member opens the normal menu with their volume', async () => {
        await mount();
        await act(async () => {
            rowFor('Ana N').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        const menu = document.querySelector('[role="menu"]');
        expect(menu?.textContent).toContain('Ana N');
        expect(menu?.textContent).toContain('Volume');
    });

    it('adds no moderator rows for a guest who holds no moderation permission', async () => {
        await mount();
        await act(async () => {
            rowFor('Ana N').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Server Mute');
    });

    it('moderator rows follow the permission, as for anyone else (control)', async () => {
        await mount({ canServerMute: true });
        await act(async () => {
            rowFor('Ana N').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        });
        expect(document.querySelector('[role="menu"]')?.textContent).toContain('Server Mute');
    });

    it('survives the presence seed, which never contains this call', async () => {
        await mount();
        await act(async () => { hooks.applyHuddleCallsSnapshot({}, GUEST); });
        expect(rosterText()).toEqual(['Ana N', 'ben', 'guest (you)']);
    });

    it('a seed for someone who is not a guest still replaces the map (control)', async () => {
        await mount();
        await act(async () => { hooks.applyHuddleCallsSnapshot({}); });
        expect(hooks.huddleCalls[PRIV]).toBeUndefined();
    });

    it('a token refresh does not blank the roster', async () => {
        await mount();
        await act(async () => { setToken('tok-2'); });
        await settle();
        expect(rosterText()).toEqual(['Ana N', 'ben', 'guest (you)']);
    });
});

describe('moved out, or leaving', () => {
    it('forgets the roster the moment they are out of the call', async () => {
        await mount();
        expect(hooks.huddleCalls[PRIV]?.[0].participants).toContain(ANA);
        await act(async () => { setGuest(null); });
        expect(hooks.huddleCalls[PRIV]).toBeUndefined();
    });

    it('an answer that lands after they left does not bring it back', async () => {
        pending = [];
        await mount();
        const inFlight = pending;
        await act(async () => { setGuest(null); });
        pending = null;
        await act(async () => { inFlight.forEach(release => release()); });
        await settle();
        expect(hooks.huddleCalls[PRIV]).toBeUndefined();
    });

    it('a refusal from the server (no longer a guest) leaves nothing behind', async () => {
        server.isGuest = false;
        await mount();
        expect(hooks.huddleCalls[PRIV]).toBeUndefined();
        expect(rosterText()).toEqual(['guest (you)']);
    });

    it('moved straight into another guest call: only the new call is held', async () => {
        await mount();
        const other = { callId: 'call-board', huddleId: 'ch-board' };
        await act(async () => { setGuest(other); });
        await settle();
        expect(hooks.huddleCalls[PRIV]).toBeUndefined();
    });
});

describe('Dashboard wiring (no render harness of its own)', () => {
    const dash = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');

    it('runs the roster hook for the ACTIVE guest call, against the real loaders', () => {
        expect(dash).toMatch(/useGuestCallRoster\(\{\s*guest: activeGuestCall,/);
        expect(dash).toContain('load: loadGuestCallRoster,');
        expect(dash).toContain('dropGuestCallRoster(guest);');
    });

    it('the presence seed carries the guest row over and re-reads it', () => {
        expect(dash).toContain('applyHuddleCallsSnapshot(nextHuddles, guest);');
        expect(dash).toMatch(/if \(guest\) void loadGuestCallRoster\(guest,/);
    });
});
