/**
 * A MOCK Discord that models the part the import wizard depends on: several
 * applications (each with its own bot user and token), the bot's application
 * flags (privileged intents), guild membership, and what an invite link does
 * when someone authorises it (Discord adds the bot of the link's `client_id`).
 *
 * Used by the root-cause test for "the bot is not in any server" and by the
 * visual harness. Nothing here came from a real server; no real token exists.
 */
import type { FetchLike } from '../discord-client';
import { MOCK_GUILD_ID, mockChannels, mockGuild } from './mock-guild';

export interface MockApp {
    /** The application id (the OAuth2 `client_id`). */
    appId: string;
    /** The bot user's id. Equal to appId for modern apps; different for some old ones. */
    botId: string;
    botName: string;
    token: string;
    /** Application flags (privileged intents live here). */
    flags: number;
}

export interface MockGuildEntry { id: string; name: string; owner: boolean; icon: string | null }

/** Application flags, as Discord documents them. */
export const APP_FLAG = {
    GATEWAY_GUILD_MEMBERS: 1 << 14,
    GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
    GATEWAY_MESSAGE_CONTENT: 1 << 18,
    GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
} as const;

export const BOTH_INTENTS = APP_FLAG.GATEWAY_GUILD_MEMBERS_LIMITED | APP_FLAG.GATEWAY_MESSAGE_CONTENT_LIMITED;

export type AuthorizeResult = { ok: true; guildId: string; botId: string; permissions: string } | { ok: false; reason: string };

export class MockDiscord {
    readonly apps: MockApp[];
    readonly guilds: MockGuildEntry[];
    /** guild id -> (bot user id -> the permissions integer it was invited with). */
    readonly members = new Map<string, Map<string, string>>();
    /** Every request: "METHOD path auth?" (token never recorded). */
    readonly log: string[] = [];
    /** Force answers for a path prefix (status + body), e.g. a 503 for the guild list. */
    readonly overrides = new Map<string, { status: number; body: unknown }>();
    /** The next N guild-list requests fail as network errors (to test "couldn't reach Discord"). */
    failGuildsWithNetwork = 0;

    constructor(apps: MockApp[], guilds: MockGuildEntry[] = [{ id: MOCK_GUILD_ID, name: 'Pixel Farm Co-op', owner: true, icon: 'a_1234abcd' }]) {
        this.apps = apps;
        this.guilds = guilds;
        for (const g of guilds) this.members.set(g.id, new Map());
    }

    /** What happens when the server owner opens an invite URL and clicks Authorize on `guildId`. */
    authorize(inviteUrl: string, guildId: string = this.guilds[0].id): AuthorizeResult {
        const u = new URL(inviteUrl);
        if (u.origin !== 'https://discord.com' || u.pathname !== '/oauth2/authorize') return { ok: false, reason: 'not an authorize URL' };
        const clientId = u.searchParams.get('client_id');
        const app = this.apps.find(a => a.appId === clientId);
        if (!app) return { ok: false, reason: 'Unknown application' };
        if (!(u.searchParams.get('scope') ?? '').split(/[ +]/).includes('bot')) return { ok: false, reason: 'no bot scope' };
        const perms = u.searchParams.get('permissions') ?? '0';
        this.members.get(guildId)?.set(app.botId, perms);
        return { ok: true, guildId, botId: app.botId, permissions: perms };
    }

    /** Kick a bot (or every bot) from a guild. */
    kick(botId: string, guildId: string = this.guilds[0].id): void { this.members.get(guildId)?.delete(botId); }

    private appByToken(auth: string): MockApp | undefined {
        const m = /^Bot (.+)$/.exec(auth);
        return m ? this.apps.find(a => a.token === m[1]) : undefined;
    }

    readonly fetch: FetchLike = async (url, init) => {
        const auth = init.headers.Authorization ?? '';
        const path = url.replace('https://discord.com/api/v10', '');
        this.log.push(`${init.method} ${path.split('?')[0]}${auth ? ' auth' : ''}`);
        const res = (status: number, body: unknown) => ({
            status, headers: { get: () => null }, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0),
        });
        if (init.method !== 'GET') return res(405, { code: 0, message: '405: Method Not Allowed' });
        for (const [prefix, o] of this.overrides) if (path.startsWith(prefix)) return res(o.status, o.body);
        if (url.startsWith('https://cdn.discordapp.com')) return res(404, {});
        const app = this.appByToken(auth);
        if (!app) return res(401, { code: 0, message: '401: Unauthorized' });
        if (path === '/users/@me') return res(200, { id: app.botId, username: app.botName, bot: true });
        if (path === '/oauth2/applications/@me') {
            return res(200, { id: app.appId, name: app.botName, flags: app.flags, bot_public: true, bot: { id: app.botId, username: app.botName } });
        }
        if (path.startsWith('/users/@me/guilds')) {
            if (this.failGuildsWithNetwork > 0) { this.failGuildsWithNetwork--; throw new TypeError('fetch failed'); }
            return res(200, this.guilds
                .filter(g => this.members.get(g.id)?.has(app.botId))
                .map(g => ({ id: g.id, name: g.name, owner: false, icon: g.icon, permissions: this.members.get(g.id)!.get(app.botId) })));
        }
        const gm = /^\/guilds\/(\d+)(\/channels)?$/.exec(path);
        if (gm) {
            if (!this.members.get(gm[1])?.has(app.botId)) return res(403, { code: 50001, message: 'Missing Access' });
            if (gm[1] !== MOCK_GUILD_ID) return res(404, { code: 10004, message: 'Unknown Guild' });
            return res(200, gm[2] ? mockChannels() : mockGuild());
        }
        return res(404, { code: 0, message: '404: Not Found' });
    };
}

/** The owner's two applications: an older one they already had, and the new "Cipherline Importer". */
export function ownerApps(): { other: MockApp; importer: MockApp } {
    return {
        other: { appId: '700000000000000111', botId: '700000000000000111', botName: 'My Music Bot', token: ['NzAwMDAwMDAwMDAwMDAwMTEx', 'Gother', 'otherotherotherotherotherother12'].join('.'), flags: 0 },
        importer: { appId: '800000000000000900', botId: '800000000000000900', botName: 'Cipherline Importer', token: ['ODAwMDAwMDAwMDAwMDAwOTAw', 'Gimpor', 'importerimporterimporterimporter12'].join('.'), flags: BOTH_INTENTS },
    };
}
