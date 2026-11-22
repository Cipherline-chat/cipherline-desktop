/**
 * Server Settings > Roles: the Discord import's held roles / overrides /
 * nicknames / bans per imported person (plan D5b). API calls + pure helpers.
 */
import axios from 'axios';
import { apiUrl } from './apiPath';

export interface ImportGrantItem { id: string; kind: 'role' | 'channel' | 'category' | 'nickname' | 'ban'; target_id: string; name: string | null; state: string }
export interface ImportGrantPerson {
    author_id: string;
    claimed_user: { user_id: string; username: string; discriminator: number | null } | null;
    member: boolean;
    items: ImportGrantItem[];
}

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** [] when the server was not imported, the caller cannot manage roles, or the API predates it. */
export async function fetchImportMemberGrants(token: string, serverId: string): Promise<ImportGrantPerson[]> {
    const r = await axios.get(apiUrl`/servers/${serverId}/imports/member-grants`, auth(token));
    if (r.data?.available !== true || !Array.isArray(r.data?.people)) return [];
    return (r.data.people as ImportGrantPerson[]).filter(p => p && typeof p.author_id === 'string' && Array.isArray(p.items));
}

export async function revokeImportMemberGrants(token: string, serverId: string, authorId: string): Promise<number> {
    const r = await axios.delete(apiUrl`/servers/${serverId}/imports/member-grants/${authorId}`, auth(token));
    return Number(r.data?.revoked ?? 0);
}

/** "Discord import: waiting for 12 people, given to 3, 1 ban". */
export function grantsBarLabel(people: ImportGrantPerson[]): string {
    let waiting = 0; let given = 0; let bans = 0;
    for (const p of people) {
        const live = p.items.filter(i => i.state !== 'revoked');
        if (live.some(i => i.kind === 'ban')) { bans++; continue; }
        if (live.length === 0) continue;
        if (live.some(i => i.state === 'applied' || i.state === 'held')) given++; else waiting++;
    }
    const parts: string[] = [];
    if (waiting) parts.push(`waiting for ${waiting} ${waiting === 1 ? 'person' : 'people'}`);
    if (given) parts.push(`given to ${given}`);
    if (bans) parts.push(`${bans} ban${bans === 1 ? '' : 's'}`);
    return parts.length ? `Discord import roles: ${parts.join(', ')}` : 'Discord import roles: all revoked';
}
