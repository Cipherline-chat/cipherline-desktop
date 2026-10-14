// @vitest-environment jsdom
/**
 * useMentionRoster, rendered for real against the real roster cache.
 *
 * The owner's bug: "when someone joins a server I have to close and reopen the
 * server to @mention them". The member list beside the composer subscribed to
 * the roster cache and stayed live; the @mention picker copied the roster into
 * state once per channel switch. These tests drive the exact sequence the
 * Dashboard runs on `server:member_joined` / `server:members_changed`
 * (invalidateRoster + a forced refreshRoster) with the server STAYING OPEN —
 * no remount, same serverId — and read what the picker would offer.
 *
 * The "snapshot" probe is the negative control: it reproduces the old shape
 * (roster read once per server id) and must NOT see the joiner, proving the
 * scenario really would have failed before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act, useEffect, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...a) } }));

import { useMentionRoster } from './useMentionRoster';
import { deriveMentionRoster, type MentionRosterView } from '../utils/mentionRoster';
import {
    refreshRoster, peekRoster, invalidateRoster, __resetRosterCache,
    type RosterMember, type RosterRole,
} from '../utils/serverRosterCache';
import { rankMentionCandidates } from '../utils/mentionSuggestions';

const TOKEN = 'tok';
const ME = 'me';
const member = (id: string, extra: Partial<RosterMember> = {}): RosterMember => ({
    user_id: id, username: `user${id}`, discriminator: 1, nickname: null, avatar_url: null,
    status: 'online', joined_at: '2026-01-01T00:00:00Z', muted_until: null, role_ids: [], ...extra,
});
const role = (id: string, extra: Partial<RosterRole> = {}): RosterRole => ({
    role_id: id, name: `role${id}`, color: -1, position: 1, hoisted: false, is_everyone: false, mentionable: true, ...extra,
});

let server: { members: RosterMember[]; roles: RosterRole[] };
beforeEach(() => {
    __resetRosterCache();
    axiosGet.mockReset();
    server = { members: [member(ME), member('a')], roles: [role('r1')] };
    axiosGet.mockImplementation(async (url: string) => {
        const m = /\/servers\/([^/]+)\/(members|roles)$/.exec(url);
        if (!m) throw new Error(`unexpected GET ${url}`);
        return { data: JSON.parse(JSON.stringify(m[2] === 'members' ? server.members : server.roles)) };
    });
});

let live: MentionRosterView | null;
let snapshot: MentionRosterView | null;
let renders: number;
// Components report what they rendered through these sinks (committed in an
// effect), not by assigning module variables during render.
const seeLive = (v: MentionRosterView) => { live = v; };
const seeSnapshot = (v: MentionRosterView) => { snapshot = v; };
const countRender = () => { renders++; };

/** What the picker offers for "@<query>", exactly as ChatPane builds it. */
const offered = (view: MentionRosterView, query: string) =>
    rankMentionCandidates(
        [
            ...view.members.map(m => ({ type: 'user' as const, id: m.user_id, label: m.username, discriminator: m.discriminator })),
            ...view.roles.map(r => ({ type: 'role' as const, id: r.role_id, label: r.name })),
        ],
        query,
        10,
    ).map(c => c.label);

const Live: React.FC<{ serverId: string }> = ({ serverId }) => {
    const view = useMentionRoster(serverId, ME);
    useEffect(() => { seeLive(view); countRender(); });
    return null;
};
/** OLD behaviour: the roster read once per server id and held (state-copy shape). */
const Snapshot: React.FC<{ serverId: string }> = ({ serverId }) => {
    const view = useMemo(() => deriveMentionRoster(peekRoster(serverId), ME), [serverId]);
    useEffect(() => { seeSnapshot(view); });
    return null;
};
const Both: React.FC<{ serverId: string }> = ({ serverId }) =>
    React.createElement(React.Fragment, null,
        React.createElement(Live, { serverId }), React.createElement(Snapshot, { serverId }));

let root: Root;
async function openServer(serverId = 'S') {
    live = null; snapshot = null; renders = 0;
    await act(async () => { await refreshRoster(serverId, TOKEN); });   // the open's first fetch lands
    root = createRoot(document.createElement('div'));
    await act(async () => { root.render(React.createElement(Both, { serverId })); });
}
/** The Dashboard's reaction to a roster-changing WS event, minus the WS. */
async function rosterEvent(serverId = 'S') {
    invalidateRoster(serverId);
    await act(async () => { await refreshRoster(serverId, TOKEN, { force: true }); });
}

describe('@mention candidates track the live roster while the server stays open', () => {
    it('a member who JOINS appears in the picker (and the send-time token map) with no reopen', async () => {
        await openServer();
        expect(offered(live!, 'userb')).toEqual([]);                      // control: not a member yet
        expect(live!.tokenMap.userb).toBeUndefined();

        server.members = [...server.members, member('b')];                // B joins via invite
        await rosterEvent();

        expect(offered(live!, 'userb')).toEqual(['userb']);
        expect(live!.tokenMap.userb).toBe('<@u:b:userb>');                // typed @userb also converts on send
    });

    it('NEGATIVE CONTROL: the old snapshot shape never sees the joiner', async () => {
        await openServer();
        server.members = [...server.members, member('b')];
        await rosterEvent();
        expect(offered(live!, 'userb')).toEqual(['userb']);               // live: yes
        expect(offered(snapshot!, 'userb')).toEqual([]);                  // snapshot: the reported bug
    });

    it('a member who LEAVES / is kicked / banned disappears from the picker', async () => {
        await openServer();
        expect(offered(live!, 'usera')).toEqual(['usera']);
        server.members = server.members.filter(m => m.user_id !== 'a');
        await rosterEvent();
        expect(offered(live!, 'usera')).toEqual([]);
        expect(live!.tokenMap.usera).toBeUndefined();
    });

    it('role created / renamed / deleted is reflected', async () => {
        await openServer();
        expect(offered(live!, 'role')).toEqual(['roler1']);
        server.roles = [role('r1', { name: 'mods' }), role('r2', { name: 'role-new' })];
        await rosterEvent();
        expect(offered(live!, 'mods')).toEqual(['mods']);
        expect(offered(live!, 'role-new')).toEqual(['role-new']);
        server.roles = [];
        await rosterEvent();
        expect(offered(live!, 'mods')).toEqual([]);
    });

    it("the viewer's own role ids follow a role assignment", async () => {
        await openServer();
        expect(live!.myRoleIds).toEqual([]);
        server.members = server.members.map(m => (m.user_id === ME ? { ...m, role_ids: ['r1'] } : m));
        await rosterEvent();
        expect(live!.myRoleIds).toEqual(['r1']);
    });

    it('a no-change revalidation does not re-render (identity follows content)', async () => {
        await openServer();
        const before = renders;
        const view = live;
        await rosterEvent();                                              // same data
        expect(live).toBe(view);
        expect(renders).toBe(before);
    });

    it('no server -> empty candidates; another server never leaks in', async () => {
        await openServer();
        await act(async () => { root.render(React.createElement(Live, { serverId: 'OTHER' })); });
        expect(live!.members).toEqual([]);                                // OTHER not cached: nothing from S
    });
});
