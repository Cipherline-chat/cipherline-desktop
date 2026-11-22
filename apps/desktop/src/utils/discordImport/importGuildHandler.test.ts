/**
 * The host half of "Import from Discord" (owner 2026-11-22: tested on staging,
 * "NO roles on claim").
 *
 * The real app path is Dashboard -> CreateServerModal -> DiscordGuildImport ->
 * runStructureImport -> host.importGuild (= Dashboard's onImportGuild) ->
 * useServers.importDiscordGuild -> POST /server-templates/discord/import-guild.
 * Dashboard cannot be mounted in a unit test (the Electron E2EE engine), so the
 * wiring is pinned in three layers:
 *   1. makeImportGuildHandler: the request reaches `post` VERBATIM (members,
 *      bans, nicknames, join days) and every field of the answer comes back;
 *   2. Dashboard.tsx's onImportGuild IS makeImportGuildHandler(importDiscordGuild, ...)
 *      and builds no answer of its own (the old closure dropped member_grants);
 *   3. useServers.importDiscordGuild POSTs the request object itself and
 *      returns the response body unchanged.
 * Each has a positive control: a handler that drops the field fails layer 1's
 * check; the old Dashboard source fails layer 2's.
 * (The mounted wizard + this factory: DiscordGuildImport.test.ts "real host wiring".)
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeImportGuildHandler, toGuildImportResponse } from './importGuildHandler';
import type { GuildImportRequest, GuildImportResponse } from './types';

const REQ: GuildImportRequest = {
    guild: { name: 'Pixel Farm', roles: [{ id: 0 }, { id: 1, name: 'Farmhand' }], channels: [] },
    name: 'Pixel Farm',
    members: [
        { id: '800000000000000101', ref: 1, roles: [1], nick: 'Sammy', joined_at: '2019-04-02' },
        { id: '800000000000000102', ref: 2, roles: [], joined_at: '2021-11-30' },
    ],
    bans: [{ id: '800000000000000199', reason: 'spam' }],
};
const ANSWER = {
    server_id: 'srv-1', name: 'Pixel Farm', owner_user_id: 'u-1', icon_attachment: null,
    channel_refs: { 'c:1': 'ch-1' }, role_refs: { 'r:0': 'role-0', 'r:1': 'role-1' },
    member_grants: { status: 'saved', people: 3, roles: 1, overrides: 0, nicknames: 1, bans: 1, member_since: 2 },
    channel_settings: 'applied',
};

/** What the wizard needs from the host: the people side as sent and as recorded. */
async function assertWiring(handler: (req: GuildImportRequest) => Promise<GuildImportResponse>, posted: unknown[]) {
    const res = await handler(REQ);
    expect(posted).toEqual([REQ]);
    expect((posted[0] as GuildImportRequest).members).toEqual(REQ.members);
    expect((posted[0] as GuildImportRequest).bans).toEqual(REQ.bans);
    expect(res.member_grants).toEqual(ANSWER.member_grants);
    expect(res.role_refs).toEqual(ANSWER.role_refs);
    expect(res.channel_refs).toEqual(ANSWER.channel_refs);
    expect(res.channel_settings).toBe('applied');
}

describe('makeImportGuildHandler', () => {
    it('posts the request verbatim and returns every field the wizard reads', async () => {
        const posted: unknown[] = [];
        const onCreated = vi.fn();
        await assertWiring(makeImportGuildHandler(async (req) => { posted.push(req); return ANSWER; }, onCreated), posted);
        expect(onCreated).toHaveBeenCalledTimes(1);
    });

    it('POSITIVE CONTROL: a handler that rebuilds the answer without member_grants fails the same check', async () => {
        const posted: unknown[] = [];
        const legacy = async (req: GuildImportRequest): Promise<GuildImportResponse> => {
            posted.push(req);
            const srv = ANSWER;
            return { server_id: srv.server_id, name: srv.name, channel_refs: srv.channel_refs, role_refs: srv.role_refs };
        };
        await expect(assertWiring(legacy, posted)).rejects.toThrow();
    });

    it('onCreated never runs when the create fails', async () => {
        const onCreated = vi.fn();
        const h = makeImportGuildHandler(async () => { throw new Error('500'); }, onCreated);
        await expect(h(REQ)).rejects.toThrow('500');
        expect(onCreated).not.toHaveBeenCalled();
    });

    it('validates the answer instead of casting it', () => {
        expect(() => toGuildImportResponse({ name: 'x' })).toThrow();
        const r = toGuildImportResponse({ server_id: 's', name: 'n', role_refs: { 'r:1': 5 }, member_grants: { status: 'bogus' }, channel_settings: 'weird' });
        expect(r).toEqual({ server_id: 's', name: 'n' });
        // An older API: no people fields at all.
        expect(toGuildImportResponse({ server_id: 's', name: 'n' })).toEqual({ server_id: 's', name: 'n' });
    });
});

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** The JSX attribute block `onImportGuild={...}` handed to CreateServerModal. */
function onImportGuildBlock(dashboard: string): string {
    const start = dashboard.indexOf('onImportGuild={');
    expect(start).toBeGreaterThan(-1);
    const end = dashboard.indexOf('historyDeps={', start);
    expect(end).toBeGreaterThan(start);
    return dashboard.slice(start, end);
}

function assertDashboardWiring(dashboard: string) {
    const block = onImportGuildBlock(dashboard);
    expect(block).toMatch(/makeImportGuildHandler\(\s*importDiscordGuild\s*,/);
    expect(block).toMatch(/\)\(req\)/);
    // No hand-built answer (that is what dropped member_grants).
    expect(block).not.toMatch(/server_id\s*:/);
    expect(dashboard).toMatch(/import \{ makeImportGuildHandler \} from '\.\.\/utils\/discordImport\/importGuildHandler';/);
}

describe('Dashboard wiring (source)', () => {
    it("Dashboard's onImportGuild is makeImportGuildHandler(importDiscordGuild, ...) and builds no answer itself", () => {
        assertDashboardWiring(read('components/Dashboard.tsx'));
    });

    it('POSITIVE CONTROL: the pre-fix Dashboard closure fails the same check', () => {
        const before = `
                    onImportGuild={async (req) => {
                        const ownedBefore = null;
                        const srv = await importDiscordGuild(req);
                        noteServerCreated(ownedBefore);
                        return { server_id: srv.server_id, name: srv.name, channel_refs: (srv as { channel_refs?: Record<string, string> }).channel_refs, role_refs: (srv as { role_refs?: Record<string, string> }).role_refs };
                    }}
                    historyDeps={importHistoryDeps}`;
        expect(() => assertDashboardWiring(before)).toThrow();
    });

    it('CreateServerModal hands onImportGuild to the wizard unchanged', () => {
        const modal = read('components/server/CreateServerModal.tsx');
        expect(modal).toMatch(/importGuild: onImportGuild,/);
    });

    it('useServers.importDiscordGuild POSTs the request object itself and returns the body unchanged', () => {
        const hook = read('hooks/useServers.ts');
        const start = hook.indexOf('const importDiscordGuild = useCallback(');
        expect(start).toBeGreaterThan(-1);
        const body = hook.slice(start, hook.indexOf('}, [token, loadServers]);', start));
        expect(body).toMatch(/`\$\{API_BASE\}\/server-templates\/discord\/import-guild`,\s*req,/);
        expect(body).toMatch(/const server = res\.data as ServerInfo;/);
        expect(body).toMatch(/return server;/);
    });
});
