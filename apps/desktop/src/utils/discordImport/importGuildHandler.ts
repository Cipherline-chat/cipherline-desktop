/**
 * The host side of "Import from Discord": the ONE function Dashboard hands to
 * CreateServerModal -> DiscordGuildImport as `onImportGuild`.
 *
 * Why this is its own module (2026-11-22, owner: "no roles on claim"): the
 * Dashboard used to inline this closure and rebuild the API's answer field by
 * field, which silently dropped `member_grants` (the wizard's "Saved for N
 * people" line) and would drop any field added later. Here:
 *   - the REQUEST goes to the API exactly as the wizard built it (members,
 *     bans, nicknames, join days, every field: no re-shaping);
 *   - the RESPONSE keeps every field the wizard reads (see
 *     GuildImportResponse), validated, not cast.
 * `importGuildHandler.test.ts` pins both, and pins that Dashboard uses this.
 */
import type { GuildImportRequest, GuildImportResponse, MemberGrantsResult } from './types';

const isRecordOfStrings = (v: unknown): v is Record<string, string> =>
    !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every(x => typeof x === 'string');

const GRANT_STATUSES = new Set(['saved', 'none', 'disabled', 'unavailable', 'failed']);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function grantsOf(v: unknown): MemberGrantsResult | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const g = v as Record<string, unknown>;
    if (typeof g.status !== 'string' || !GRANT_STATUSES.has(g.status)) return undefined;
    return {
        status: g.status as MemberGrantsResult['status'],
        people: num(g.people), roles: num(g.roles), overrides: num(g.overrides),
        nicknames: num(g.nicknames), bans: num(g.bans), member_since: num(g.member_since),
    };
}

/** The API's import-guild answer (whatever the HTTP layer returned) as the wizard's response. */
export function toGuildImportResponse(raw: unknown): GuildImportResponse {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.server_id !== 'string' || typeof r.name !== 'string') throw new Error('The server answered without a server id');
    const out: GuildImportResponse = { server_id: r.server_id, name: r.name };
    if (isRecordOfStrings(r.channel_refs)) out.channel_refs = r.channel_refs;
    if (isRecordOfStrings(r.role_refs)) out.role_refs = r.role_refs;
    const grants = grantsOf(r.member_grants);
    if (grants) out.member_grants = grants;
    if (r.channel_settings === 'none' || r.channel_settings === 'applied' || r.channel_settings === 'unavailable' || r.channel_settings === 'failed') {
        out.channel_settings = r.channel_settings;
    }
    return out;
}

/**
 * `post` = useServers().importDiscordGuild (POST the request verbatim, reload
 * the server list). `onCreated` runs after the server exists (Dashboard: the
 * owned-server counter), never before and never on failure.
 */
export function makeImportGuildHandler(
    post: (req: GuildImportRequest) => Promise<unknown>,
    onCreated?: () => void,
): (req: GuildImportRequest) => Promise<GuildImportResponse> {
    return async (req) => {
        const res = toGuildImportResponse(await post(req));
        onCreated?.();
        return res;
    };
}
