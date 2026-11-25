/**
 * Discord sign-in and claiming (Discord import phase 3; plan B6.3), the
 * client half. Everything that decides WHO a Discord account belongs to
 * happens on the server: this client never sees, sends or stores a Discord id,
 * a hash or a token. It only
 *   - asks the server for a one-time sign-in URL and opens it in the system
 *     browser (after checking it is OUR start page, below),
 *   - polls whether the link landed,
 *   - lists / claims / unclaims / reviews / deletes / reports through the API.
 *
 * Pure helpers (no React) so they are unit tested on their own.
 */
import { parseMemberSinceDay } from './memberSince';
import axios from 'axios';
import { API_BASE } from '../constants';
import { apiUrl } from './apiPath';

export interface DiscordLinkStatus {
    available: boolean;
    linked: boolean;
    auto_claim: boolean;
    verified_at: string | null;
    /**
     * Your Discord link was MOVED to another Cipherline account (someone signed
     * in to that Discord account there and confirmed). Only when not linked
     * and not yet acknowledged; nothing about the other account, ever.
     */
    moved_away_at: string | null;
}

export interface ImporterView {
    import_id: string;
    imported_at: string;
    importer: { user_id: string; username: string; discriminator: number | null } | null;
}

/** A role this Discord person had, given to the claimant while a member (D5b). */
export interface ImportedGrantRole { role_id: string; name: string; color: number; position: number; administrator: boolean; state: string }

/**
 * What the Discord person had besides their messages: roles, per-channel
 * permissions, nickname, or a ban. The server decides all of it; the client
 * only says it before Claim (owner: "the claim confirm dialog must say which
 * roles they will get").
 */
export interface ImportedGrants {
    roles: ImportedGrantRole[];
    overrides: number;
    nickname: string | null;
    banned: boolean;
    granted_by: { user_id: string; username: string; discriminator: number | null } | null;
    granted_at: string | null;
    given: boolean;
    /** The day they joined the Discord server (`YYYY-MM-DD`): "Member since" here. Newer APIs only. */
    member_since?: string | null;
}

export interface ClaimableAuthor {
    author_id: string;
    server_id: string;
    server_name: string | null;
    claimed: boolean;
    claim_source: 'manual' | 'auto' | null;
    claimed_at: string | null;
    message_count: number;
    imports: ImporterView[];
    member: boolean;
    /** null = nothing but messages (or an older API). */
    grants: ImportedGrants | null;
}

export interface ReviewChannel {
    channel_id: string;
    count: number;
    first_at: string | null;
    last_at: string | null;
    message_ids: string[];
}

/** What the UI says when the server answers 503 (feature not set up there yet). */
export const CLAIMS_UNAVAILABLE_MESSAGE = 'Claiming imported messages isn\'t available on this Cipherline server yet. Try again later.';

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** A failure the UI can show: a 503 becomes the clear "not available yet" line. */
export function claimErrorMessage(err: unknown, fallback: string): string {
    if (axios.isAxiosError(err)) {
        if (err.response?.status === 503) return CLAIMS_UNAVAILABLE_MESSAGE;
        if (err.response?.status === 429) return 'Too many tries. Wait a few seconds and try again.';
        const m = (err.response?.data as { message?: unknown } | undefined)?.message;
        const first = Array.isArray(m) ? m[0] : m;
        if (typeof first === 'string' && first && err.response && err.response.status < 500) return first;
    }
    return fallback;
}

export function isUnavailable(err: unknown): boolean {
    return axios.isAxiosError(err) && err.response?.status === 503;
}

/**
 * The server hands back a one-time URL to open in the system browser. Only
 * OUR sign-in start page is ever opened: https, the same host as the API this
 * client talks to, the exact path, and nothing but a well-formed `state`.
 * Anything else (a compromised or confused response) is refused, so this can
 * never become a way to open an arbitrary link.
 */
export function isOurDiscordStartUrl(url: unknown, apiBase: string = API_BASE): url is string {
    if (typeof url !== 'string' || url.length > 512) return false;
    let u: URL; let api: URL;
    try { u = new URL(url); api = new URL(apiBase); } catch { return false; }
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) return false;
    if (u.hostname !== api.hostname) return false;
    if (u.pathname !== '/v1/discord/oauth/start') return false;
    const keys = [...u.searchParams.keys()];
    return keys.length === 1 && keys[0] === 'state' && /^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get('state') ?? '');
}

export async function fetchDiscordLink(token: string): Promise<DiscordLinkStatus> {
    const r = await axios.get(`${API_BASE}/discord/link`, auth(token));
    const d = r.data ?? {};
    return {
        available: d.available === true,
        linked: d.linked === true,
        auto_claim: d.auto_claim !== false,
        verified_at: typeof d.verified_at === 'string' ? d.verified_at : null,
        moved_away_at: d.linked !== true && typeof d.moved_away_at === 'string' && Number.isFinite(Date.parse(d.moved_away_at))
            ? d.moved_away_at : null,
    };
}

/** "OK" on the moved-away notice: the server forgets it (for every device of yours). */
export async function ackDiscordMovedNotice(token: string): Promise<void> {
    await axios.delete(`${API_BASE}/discord/link/moved-notice`, auth(token));
}

export async function startDiscordLink(token: string): Promise<string> {
    const r = await axios.post(`${API_BASE}/discord/link`, {}, auth(token));
    const url = r.data?.url;
    if (!isOurDiscordStartUrl(url)) throw new Error('unexpected sign-in URL');
    return url;
}

export async function unlinkDiscord(token: string): Promise<number> {
    const r = await axios.delete(`${API_BASE}/discord/link`, auth(token));
    return Number(r.data?.unclaimed ?? 0);
}

export async function setDiscordAutoClaim(token: string, on: boolean): Promise<boolean> {
    const r = await axios.put(`${API_BASE}/discord/auto-claim`, { on }, auth(token));
    return r.data?.auto_claim === true;
}

/** Strict-ish read of the server's grants summary; junk becomes null (= "nothing besides messages"). */
export function parseGrants(raw: unknown): ImportedGrants | null {
    if (!raw || typeof raw !== 'object') return null;
    const g = raw as Record<string, unknown>;
    const roles = (Array.isArray(g.roles) ? g.roles : [])
        .filter((r): r is ImportedGrantRole => !!r && typeof (r as ImportedGrantRole).role_id === 'string' && typeof (r as ImportedGrantRole).name === 'string')
        .map(r => ({
            role_id: r.role_id, name: r.name, color: Number.isFinite(Number(r.color)) ? Number(r.color) : -1,
            position: Number(r.position) || 0, administrator: r.administrator === true, state: typeof r.state === 'string' ? r.state : 'pending',
        }));
    const out: ImportedGrants = {
        roles,
        overrides: Math.max(0, Number(g.overrides) || 0),
        nickname: typeof g.nickname === 'string' && g.nickname ? g.nickname : null,
        banned: g.banned === true,
        granted_by: g.granted_by && typeof (g.granted_by as { username?: unknown }).username === 'string'
            ? g.granted_by as ImportedGrants['granted_by'] : null,
        granted_at: typeof g.granted_at === 'string' ? g.granted_at : null,
        given: g.given === true,
        member_since: parseMemberSinceDay(g.member_since),
    };
    return out.roles.length || out.overrides || out.nickname || out.banned || out.member_since ? out : null;
}

/** Anything besides messages: roles, channel permissions, a nickname or a ban. */
export function hasGrants(a: Pick<ClaimableAuthor, 'grants'>): boolean {
    return !!a.grants && (a.grants.roles.length > 0 || a.grants.overrides > 0 || !!a.grants.nickname || a.grants.banned || !!a.grants.member_since);
}

function parseAuthors(raw: unknown): ClaimableAuthor[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((a): a is ClaimableAuthor => !!a && typeof (a as ClaimableAuthor).author_id === 'string' && typeof (a as ClaimableAuthor).server_id === 'string')
        .map(a => ({
            ...a,
            message_count: Number(a.message_count) || 0,
            imports: Array.isArray(a.imports) ? a.imports : [],
            grants: parseGrants((a as { grants?: unknown }).grants),
        }));
}

export async function fetchMyClaims(token: string): Promise<{ linked: boolean; authors: ClaimableAuthor[] }> {
    const r = await axios.get(`${API_BASE}/discord/claims`, auth(token));
    return { linked: r.data?.linked === true, authors: parseAuthors(r.data?.authors) };
}

export async function fetchClaimable(token: string, serverId: string): Promise<{ linked: boolean; authors: ClaimableAuthor[] }> {
    const r = await axios.get(apiUrl`/servers/${serverId}/imports/claimable`, auth(token));
    return { linked: r.data?.linked === true, authors: parseAuthors(r.data?.authors) };
}

export async function claimAuthor(token: string, serverId: string, authorId: string): Promise<void> {
    await axios.post(apiUrl`/servers/${serverId}/imports/authors/${authorId}/claim`, {}, auth(token));
}

export async function unclaimAuthor(token: string, serverId: string, authorId: string): Promise<void> {
    await axios.delete(apiUrl`/servers/${serverId}/imports/authors/${authorId}/claim`, auth(token));
}

export async function reviewAuthor(token: string, serverId: string, authorId: string): Promise<ReviewChannel[]> {
    const r = await axios.get(apiUrl`/servers/${serverId}/imports/authors/${authorId}/messages`, auth(token));
    const list = Array.isArray(r.data?.channels) ? r.data.channels : [];
    return list.filter((c: ReviewChannel) => c && typeof c.channel_id === 'string').map((c: ReviewChannel) => ({
        channel_id: c.channel_id, count: Number(c.count) || 0, first_at: c.first_at ?? null, last_at: c.last_at ?? null,
        message_ids: Array.isArray(c.message_ids) ? c.message_ids.filter((x): x is string => typeof x === 'string') : [],
    }));
}

export async function deleteMyImportedMessages(token: string, serverId: string, authorId: string): Promise<number> {
    const r = await axios.delete(apiUrl`/servers/${serverId}/imports/authors/${authorId}/messages`, auth(token));
    return Number(r.data?.deleted ?? 0);
}

export async function reportImportedAuthor(token: string, serverId: string, authorId: string, description?: string): Promise<{ reported: boolean }> {
    const r = await axios.post(apiUrl`/servers/${serverId}/imports/authors/${authorId}/report`, description ? { description } : {}, auth(token));
    return { reported: r.data?.reported === true };
}

/** "@admin", plus the account's four-digit number when it has one. */
export function importerLabel(i: ImporterView | undefined): string {
    if (!i?.importer) return 'a former member';
    const d = i.importer.discriminator;
    return `@${i.importer.username}${typeof d === 'number' ? `#${String(d).padStart(4, '0')}` : ''}`;
}

/** "5 messages" / "1 message". */
export function messageCountLabel(n: number): string {
    return `${n.toLocaleString()} message${n === 1 ? '' : 's'}`;
}

/** "12 messages · 2 roles", "2 roles", "1 message": what a claim brings, in a few words. */
export function claimContentsLabel(a: Pick<ClaimableAuthor, 'message_count' | 'grants'>): string {
    const parts: string[] = [];
    if (a.message_count > 0 || !hasGrants(a)) parts.push(messageCountLabel(a.message_count));
    const roles = a.grants?.roles.length ?? 0;
    if (roles) parts.push(`${roles} role${roles === 1 ? '' : 's'}`);
    else if (a.grants?.overrides) parts.push('channel permissions');
    else if (a.grants?.nickname && parts.length === 0) parts.push('a nickname');
    else if (a.grants?.member_since && parts.length === 0) parts.push('a member-since date');
    return parts.join(' · ');
}

/** Window event Dashboard listens for: open a server channel at a message ("Review them" → Show). */
export const OPEN_IMPORTED_MESSAGE_EVENT = 'cl:open-imported-message';

export function requestOpenImportedMessage(serverId: string, channelId: string, messageId: string): void {
    window.dispatchEvent(new CustomEvent(OPEN_IMPORTED_MESSAGE_EVENT, { detail: { serverId, channelId, messageId } }));
}

// ── Auto-map notices: which ones this account has already acknowledged ──

/** secureLocalStore key (classified in services/backupRegistry.ts). */
export const claimNoticesSeenKey = (uid: string) => `cipherline_discord_claims_seen_${uid}`;

/** Parse the stored list (author ids), tolerating junk. */
export function parseSeen(raw: string | null | undefined): Set<string> {
    if (!raw) return new Set();
    try {
        const v = JSON.parse(raw);
        return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-500) : []);
    } catch {
        return new Set();
    }
}

/**
 * The notices to show now: an AUTO claim the user has not acknowledged
 * ("now show as you"), or something they can claim in a server they belong
 * to that they have not been told about yet ("you can claim").
 */
export function pendingClaimNotices(authors: ClaimableAuthor[], seen: Set<string>): Array<{ kind: 'auto' | 'claimable'; author: ClaimableAuthor }> {
    const out: Array<{ kind: 'auto' | 'claimable'; author: ClaimableAuthor }> = [];
    for (const a of authors) {
        if (seen.has(a.author_id) || (a.message_count === 0 && !hasGrants(a))) continue;
        if (a.claimed && a.claim_source === 'auto' && a.member) out.push({ kind: 'auto', author: a });
        else if (!a.claimed && a.member) out.push({ kind: 'claimable', author: a });
    }
    return out;
}
