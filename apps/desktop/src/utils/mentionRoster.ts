/**
 * mentionRoster — what the composer's @mention autocomplete (and the
 * `@label` -> `<@u:id:label>` wire-token map) is built FROM, derived purely
 * from the shared server roster (utils/serverRosterCache).
 *
 * Why this is a derivation and not state: ChatPane used to copy the roster
 * into component state once per channel switch. The member list beside it
 * subscribed to the same cache and stayed live, so a member who joined (or
 * left, was banned, or a role that was created / renamed) while the server was
 * open appeared in the list but NOT in the @mention picker until the server
 * was closed and reopened. Deriving from the live roster means the two cannot
 * disagree.
 */
import type { Roster } from './serverRosterCache';

export interface MentionMember {
    user_id: string;
    username: string;
    discriminator: number | null;
}

export interface MentionRole {
    role_id: string;
    name: string;
    color: number;
    mentionable: boolean;
}

export interface MentionRosterView {
    members: MentionMember[];
    roles: MentionRole[];
    /** display label -> wire token (`<@u:id:label>`, `<@r:id:label>`, @everyone, @here). */
    tokenMap: Record<string, string>;
    /** The viewer's own role ids in this server (mention-highlight check). */
    myRoleIds: string[];
}

export const EMPTY_MENTION_VIEW: MentionRosterView = {
    members: [],
    roles: [],
    tokenMap: { everyone: '@everyone', here: '@here' },
    myRoleIds: [],
};

/** Role ids as the wire delivers them: an array, or (defensively) a "{a,b}" pg string. */
function parseRoleIds(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter(Boolean) as string[];
    if (typeof raw === 'string' && raw.startsWith('{')) return raw.slice(1, -1).split(',').filter(Boolean);
    return [];
}

export function deriveMentionRoster(roster: Roster | null | undefined, viewerUserId: string | null | undefined): MentionRosterView {
    if (!roster) return EMPTY_MENTION_VIEW;
    const members: MentionMember[] = roster.members.map(m => ({
        user_id: m.user_id,
        username: m.username,
        discriminator: m.discriminator ?? null,
    }));
    const roles: MentionRole[] = roster.roles
        .filter(r => !r.is_everyone)
        .map(r => ({ role_id: r.role_id, name: r.name, color: r.color, mentionable: !!r.mentionable }));
    const tokenMap: Record<string, string> = { everyone: '@everyone', here: '@here' };
    for (const m of members) tokenMap[m.username] = `<@u:${m.user_id}:${m.username}>`;
    for (const r of roles) tokenMap[r.name] = `<@r:${r.role_id}:${r.name}>`;
    const me = viewerUserId ? roster.members.find(m => m.user_id === viewerUserId) : undefined;
    return { members, roles, tokenMap, myRoleIds: parseRoleIds(me?.role_ids) };
}
