/**
 * Read a live Discord guild (with the user's own bot) and turn it into the
 * "template wire shape" the Cipherline API already knows how to map
 * (apps/api/src/servers/discord-template/*): ids renumbered to small integers
 * (@everyone = 0), roles ordered lowest to highest, permission strings kept
 * verbatim. The API re-validates and maps it; nothing here decides what
 * Cipherline builds.
 *
 * Read: guild, roles, channels (+ overwrites), emojis, and the PEOPLE side
 * (plan D5b): the member list (role ids, nickname) and the ban list. People
 * never enter `body` (it stays id-free, like the preview): they travel in
 * `members` / `bans`, Discord user ids included, which the API hashes with its
 * keyed hash at once (D27, the same pattern as imported authors) and keeps
 * only as grants for whoever later proves that Discord account. Bots are left
 * out entirely (their members, overwrites and bans).
 */
import { createHash } from 'crypto';
import { DiscordApiError, type DiscordClient } from './discord-client';
import { isSnowflake } from './redact';

// ── What Discord returns (only the fields we read) ───────────────────────

interface RawRole {
    id: string; name: string; permissions: string; color?: number; colors?: unknown;
    hoist?: boolean; mentionable?: boolean; position?: number; managed?: boolean;
    icon?: string | null; unicode_emoji?: string | null;
}
interface RawOverwrite { id: string; type: number; allow: string; deny: string }
interface RawChannel {
    id: string; type: number; name?: string; position?: number; parent_id?: string | null;
    topic?: string | null; nsfw?: boolean; rate_limit_per_user?: number; user_limit?: number;
    permission_overwrites?: RawOverwrite[];
}
interface RawEmoji { id: string | null; name: string | null; animated?: boolean; managed?: boolean; available?: boolean }
interface RawUserRef { id?: unknown; bot?: unknown }
export interface RawMember { user?: RawUserRef; roles?: unknown; nick?: unknown; communication_disabled_until?: unknown; joined_at?: unknown }
export interface RawBan { user?: RawUserRef; reason?: unknown }
/** GET /guilds/:id/stickers. format_type: 1 PNG, 2 APNG, 3 LOTTIE, 4 GIF. */
export interface RawSticker { id?: unknown; name?: unknown; description?: unknown; tags?: unknown; format_type?: unknown; available?: unknown }
interface RawGuild {
    id: string; name: string; description?: string | null; icon?: string | null; banner?: string | null;
    splash?: string | null; discovery_splash?: string | null;
    verification_level?: number; default_message_notifications?: number; explicit_content_filter?: number;
    afk_channel_id?: string | null; afk_timeout?: number; system_channel_id?: string | null;
    system_channel_flags?: number; preferred_locale?: string; features?: string[];
    premium_tier?: number; premium_subscription_count?: number; vanity_url_code?: string | null;
    rules_channel_id?: string | null;
    roles?: RawRole[]; emojis?: RawEmoji[]; stickers?: unknown[];
}

// ── Output ───────────────────────────────────────────────────────────────

export interface NotMappedItem { item: string; reason: string }

/**
 * A Discord member whose roles / member overwrites / nickname come over.
 * `id` is the Discord user id: sent to the API once, which keeps only its
 * keyed hash. `ref` is the local number type-1 overwrites in `body` use.
 */
export interface SnapshotMember {
    id: string; ref: number; roles: number[]; nick?: string;
    /** The day they joined the Discord server (`YYYY-MM-DD`, UTC): "Member since" on claim. */
    joined_at?: string;
}
/** A Discord ban: whoever links that Discord account is banned in the new server. */
export interface SnapshotBan { id: string; reason?: string }
/**
 * A guild sticker Cipherline can carry (PNG, APNG, GIF: pictures). `name` is
 * already a Cipherline sticker name (`[a-z0-9_]{2,32}`, unique in this list);
 * Lottie (vector animation) stickers are left out and counted in notMapped.
 */
export interface SnapshotSticker { id: string; name: string; description?: string; tags: string[]; animated: boolean }

export interface GuildSnapshot {
    guild: { id: string; name: string; description: string | null; hasIcon: boolean; hasBanner: boolean };
    /** Template-shaped object for POST .../preview-guild and .../import-guild. */
    body: Record<string, unknown>;
    emojis: Array<{ id: string; name: string; animated: boolean }>;
    /** Members with a role, a member overwrite or a nickname (bots never). */
    members: SnapshotMember[];
    bans: SnapshotBan[];
    /** Snapshot role numbers whose role has an icon PICTURE (fetched by kind 'role_icon'). */
    roleIcons: number[];
    /** Guild stickers that come over (fetched by kind 'sticker'). */
    stickers: SnapshotSticker[];
    /**
     * Snapshot channel number -> an opaque, stable SOURCE KEY for that Discord channel ("Copy messages from
     * Discord" into an existing server: the API's no-duplicates rule and the next copy's auto-match).
     * `channelSourceKey`: a SHA-256 of the guild + channel ids, so the Discord channel id still never leaves
     * main; the API keys it again (HMAC) before storing. Message channels only.
     */
    channelKeys: Record<number, string>;
    counts: { roles: number; categories: number; channels: number; emojis: number; members: number; bans: number };
    /** Things Cipherline has no counterpart for, or that later phases cover. */
    notMapped: NotMappedItem[];
}

/**
 * What the main process remembers about a guild it read, so the renderer can
 * only ask for THIS guild's images by kind/id, and its channels' history by the
 * snapshot's small channel number (the Discord channel id never leaves main).
 */
export interface ImageRefs {
    iconHash: string | null; bannerHash: string | null; emojiIds: Set<string>; animatedEmoji: Set<string>;
    /** Snapshot channel number -> the Discord channel (history import, phase 2). */
    channels?: Map<number, { id: string; type: number; name: string }>;
    /** Discord role / channel id -> name, to write mentions as text. */
    roleNames?: Map<string, string>;
    channelNames?: Map<string, string>;
    /** Discord role / channel id -> the snapshot's number for it (`r:N` / `c:N` in the API's refs). */
    roleNums?: Map<string, number>;
    channelNums?: Map<string, number>;
    /** Snapshot role number -> its Discord role id + icon hash (CDN role-icons/<id>/<hash>). */
    roleIcons?: Map<number, { id: string; hash: string }>;
    /** Guild sticker id -> 'png' | 'gif' (the CDN file kind), for the stickers that come over. */
    stickers?: Map<string, 'png' | 'gif'>;
}

const TYPE_CATEGORY = 4;
/** Discord channel types whose messages can be copied: text (0) and announcement (5). */
const MESSAGE_TYPES = new Set([0, 5]);

/**
 * The source key of one Discord channel: lower-case hex SHA-256 of a versioned, domain-separated string.
 * Stable across reads (the same channel always gives the same key), different per guild + channel.
 */
export function channelSourceKey(guildId: string, channelId: string): string {
    return createHash('sha256').update(`cipherline-discord-channel:v1:${guildId}:${channelId}`, 'utf8').digest('hex');
}
const MAX_ROLES = 250;
const MAX_CHANNELS = 500;
/** People the API accepts per import (members / bans): its MAX_GUILD_IMPORT_MEMBERS / _BANS. */
export const MAX_IMPORT_MEMBERS = 10_000;
export const MAX_IMPORT_BANS = 10_000;
/** GET /guilds/:id/members pages (1,000 each): the member list is read up to 50,000 people. */
export const MEMBER_PAGES = 50;
export const BAN_PAGES = 10;

const cmpSnowflake = (a: string, b: string): number => {
    const x = BigInt(a); const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
};

const str = (v: unknown, max: number): string | null =>
    typeof v === 'string' ? Array.from(v).slice(0, max).join('') : null;

/** Discord's public launch: no membership is older. */
const DISCORD_EPOCH_DAY = '2015-05-13';
/** A member's `joined_at` as its UTC day (`YYYY-MM-DD`), or undefined when implausible. */
export function joinedDay(v: unknown, now = Date.now()): string | undefined {
    if (typeof v !== 'string' || v.length > 40) return undefined;
    const t = Date.parse(v);
    if (!Number.isFinite(t) || t > now) return undefined;
    const day = new Date(t).toISOString().slice(0, 10);
    return day >= DISCORD_EPOCH_DAY ? day : undefined;
}
/** A Discord sticker name as a Cipherline sticker name: `[a-z0-9_]{2,32}`. */
export function stickerNameOf(raw: unknown): string {
    const base = (typeof raw === 'string' ? raw : '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32).replace(/_+$/, '');
    return base.length >= 2 ? base : 'sticker';
}
/** Discord sticker tags (comma-separated words; a guild sticker's is often one unicode emoji) as Cipherline tags. */
export function stickerTagsOf(raw: unknown): string[] {
    if (typeof raw !== 'string') return [];
    const out: string[] = [];
    for (const t of raw.split(',')) {
        const c = t.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
        if (c && !out.includes(c)) out.push(c);
        if (out.length >= 5) break;
    }
    return out;
}
/** A CDN asset hash (role icon / guild icon): letters, digits, `_` (animated ones start `a_`). */
const ASSET_HASH = /^[A-Za-z0-9_]{1,64}$/;

export function buildSnapshot(
    guild: RawGuild, channels: RawChannel[],
    people: { members?: RawMember[]; bans?: RawBan[]; bansUnavailable?: boolean; stickers?: RawSticker[] | null } = {},
): { snapshot: GuildSnapshot; images: ImageRefs } {
    const notMapped: NotMappedItem[] = [];
    // Bots (from the member and ban lists): never carried, nor their overwrites.
    const botIds = new Set<string>();
    for (const m of people.members ?? []) if (m?.user && m.user.bot === true && isSnowflake(m.user.id)) botIds.add(m.user.id);
    for (const b of people.bans ?? []) if (b?.user && b.user.bot === true && isSnowflake(b.user.id)) botIds.add(b.user.id);

    // ── Roles: skip managed (bot/integration) roles, order low -> high ────
    const rawRoles = Array.isArray(guild.roles) ? guild.roles : [];
    const managed = rawRoles.filter(r => r?.managed === true);
    const human = rawRoles.filter(r => r && r.managed !== true && isSnowflake(r.id) && r.id !== guild.id);
    human.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || cmpSnowflake(a.id, b.id));
    const rolesKept = human.slice(0, MAX_ROLES);
    if (human.length > MAX_ROLES) {
        notMapped.push({ item: `${human.length - MAX_ROLES} roles`, reason: `Over Cipherline's ${MAX_ROLES} role limit; the lowest-ranked ${MAX_ROLES} were kept` });
    }
    if (managed.length > 0) {
        notMapped.push({ item: `Bot and integration roles (${managed.length})`, reason: 'Created by Discord bots and integrations; they only make sense with those bots' });
    }
    const everyone = rawRoles.find(r => r?.id === guild.id);
    const roleId = new Map<string, number>([[guild.id, 0]]);
    rolesKept.forEach((r, i) => roleId.set(r.id, i + 1));

    const roles: Array<Record<string, unknown>> = [];
    const roleIcons = new Map<number, { id: string; hash: string }>();
    roles.push({
        id: 0, name: '@everyone', permissions: everyone?.permissions ?? '0',
        color: 0, hoist: false, mentionable: false,
    });
    for (const r of rolesKept) {
        roles.push({
            id: roleId.get(r.id), name: r.name, permissions: r.permissions,
            color: typeof r.color === 'number' ? r.color : 0, colors: r.colors,
            hoist: r.hoist === true, mentionable: r.mentionable === true,
            icon: r.icon ?? null, unicode_emoji: r.unicode_emoji ?? null,
        });
        if (typeof r.icon === 'string' && ASSET_HASH.test(r.icon)) roleIcons.set(roleId.get(r.id)!, { id: r.id, hash: r.icon });
    }

    // ── Channels: ids renumbered in snowflake (= creation) order ─────────
    const chanSorted = (Array.isArray(channels) ? channels : [])
        .filter(c => c && isSnowflake(c.id))
        .sort((a, b) => cmpSnowflake(a.id, b.id))
        .slice(0, MAX_CHANNELS);
    if (Array.isArray(channels) && channels.length > MAX_CHANNELS) {
        notMapped.push({ item: `${channels.length - MAX_CHANNELS} channels`, reason: `Over Cipherline's ${MAX_CHANNELS} channel limit` });
    }
    const chanId = new Map<string, number>();
    chanSorted.forEach((c, i) => chanId.set(c.id, i));
    let memberSeq = 0;
    const memberId = new Map<string, number>();
    /** Discord ids named by a member (type 1) overwrite, before the member list adds more numbers. */
    const memberOverwriteTargets: string[] = [];

    const outChannels = chanSorted.map(c => {
        const ows: Array<Record<string, unknown>> = [];
        for (const o of Array.isArray(c.permission_overwrites) ? c.permission_overwrites : []) {
            if (!o || typeof o.allow !== 'string' || typeof o.deny !== 'string') continue;
            if (o.type === 0) {
                const rid = roleId.get(o.id);
                if (rid === undefined) continue; // bot role or unknown: dropped (reported via the roles note)
                ows.push({ id: rid, type: 0, allow: o.allow, deny: o.deny });
            } else if (o.type === 1) {
                // Member overwrites: the body names the member by a local number only; the
                // Discord id goes in `members` (hashed by the API at once). Bots: dropped.
                if (!isSnowflake(o.id) || botIds.has(o.id)) continue;
                if (!memberId.has(o.id)) { memberId.set(o.id, ++memberSeq); memberOverwriteTargets.push(o.id); }
                ows.push({ id: memberId.get(o.id), type: 1, allow: o.allow, deny: o.deny });
            }
        }
        return {
            id: chanId.get(c.id),
            type: c.type,
            name: c.name ?? 'channel',
            position: c.position ?? 0,
            parent_id: c.parent_id && chanId.has(c.parent_id) ? chanId.get(c.parent_id) : null,
            topic: str(c.topic, 1024),
            nsfw: c.nsfw === true,
            rate_limit_per_user: c.rate_limit_per_user ?? 0,
            user_limit: c.user_limit ?? 0,
            permission_overwrites: ows,
        };
    });

    const mapChan = (id: unknown) => (typeof id === 'string' && chanId.has(id) ? chanId.get(id)! : null);

    const body: Record<string, unknown> = {
        name: str(guild.name, 100) ?? 'Imported server',
        description: str(guild.description, 1000),
        verification_level: guild.verification_level ?? 0,
        default_message_notifications: guild.default_message_notifications ?? 0,
        explicit_content_filter: guild.explicit_content_filter ?? 0,
        afk_channel_id: mapChan(guild.afk_channel_id),
        afk_timeout: guild.afk_timeout ?? 0,
        system_channel_id: mapChan(guild.system_channel_id),
        system_channel_flags: guild.system_channel_flags ?? 0,
        preferred_locale: guild.preferred_locale,
        roles,
        channels: outChannels,
    };

    // ── Emojis ───────────────────────────────────────────────────────────
    const emojis: GuildSnapshot['emojis'] = [];
    const emojiIds = new Set<string>();
    const animatedEmoji = new Set<string>();
    let unavailableEmoji = 0;
    for (const e of Array.isArray(guild.emojis) ? guild.emojis : []) {
        if (!e || !isSnowflake(e.id) || typeof e.name !== 'string') continue;
        if (e.available === false) { unavailableEmoji++; continue; }
        emojis.push({ id: e.id, name: e.name, animated: e.animated === true });
        emojiIds.add(e.id);
        if (e.animated === true) animatedEmoji.add(e.id);
    }
    if (unavailableEmoji > 0) {
        notMapped.push({ item: `${unavailableEmoji} unavailable emoji`, reason: 'Locked by Discord (boost level); the image cannot be fetched' });
    }

    // ── Stickers (server stickers): PNG / APNG / GIF come over; Lottie cannot ──
    const stickers: SnapshotSticker[] = [];
    const stickerFiles = new Map<string, 'png' | 'gif'>();
    const stickerNames = new Set<string>();
    let lottie = 0; let lockedStickers = 0;
    for (const st of Array.isArray(people.stickers) ? people.stickers : []) {
        if (!st || !isSnowflake(st.id) || stickerFiles.has(st.id)) continue;
        if (st.format_type === 3) { lottie++; continue; }
        if (st.format_type !== 1 && st.format_type !== 2 && st.format_type !== 4) continue;
        if (st.available === false) { lockedStickers++; continue; }
        let name = stickerNameOf(st.name);
        for (let n = 2; stickerNames.has(name); n++) name = `${stickerNameOf(st.name).slice(0, 32 - String(n).length - 1)}_${n}`;
        stickerNames.add(name);
        const description = str(typeof st.description === 'string' ? st.description.trim() : null, 100);
        stickers.push({ id: st.id, name, ...(description ? { description } : {}), tags: stickerTagsOf(st.tags), animated: st.format_type !== 1 });
        stickerFiles.set(st.id, st.format_type === 4 ? 'gif' : 'png');
    }
    if (lottie > 0) notMapped.push({ item: `Stickers (${lottie} Lottie)`, reason: 'Moving vector (Lottie) stickers cannot be turned into a picture; the other stickers come over' });
    if (lockedStickers > 0) notMapped.push({ item: `${lockedStickers} unavailable sticker${lockedStickers === 1 ? '' : 's'}`, reason: 'Locked by Discord (boost level); the image cannot be fetched' });
    if (people.stickers === null) notMapped.push({ item: 'Stickers', reason: 'The bot could not read the server\'s stickers' });

    // ── People (D5b): roles, member overwrites, nicknames, bans ──────────
    const members: SnapshotMember[] = [];
    const seenMember = new Set<string>();
    let timeouts = 0;
    for (const m of people.members ?? []) {
        const id = m?.user?.id;
        if (!isSnowflake(id) || botIds.has(id) || seenMember.has(id)) continue;
        seenMember.add(id);
        const roles = (Array.isArray(m.roles) ? m.roles : [])
            .map(r => (typeof r === 'string' ? roleId.get(r) : undefined))
            .filter((n): n is number => typeof n === 'number' && n > 0);
        const nick = typeof m.nick === 'string' ? Array.from(m.nick.trim()).slice(0, 32).join('') : '';
        const joined = joinedDay(m.joined_at);
        if (typeof m.communication_disabled_until === 'string' && Date.parse(m.communication_disabled_until) > Date.now()) timeouts++;
        // Everyone with a join day comes over (their "Member since"); without
        // one, only people with a role, a nickname or a member overwrite.
        if (roles.length === 0 && !nick && !memberId.has(id) && !joined) continue;
        if (!memberId.has(id)) memberId.set(id, ++memberSeq);
        members.push({ id, ref: memberId.get(id)!, roles: [...new Set(roles)], ...(nick ? { nick } : {}), ...(joined ? { joined_at: joined } : {}) });
    }
    // Overwrite targets who are no longer members on Discord still get theirs.
    const memberOverwriteIds = new Set(memberOverwriteTargets);
    for (const [id, ref] of memberId) {
        if (!seenMember.has(id)) { seenMember.add(id); members.push({ id, ref, roles: [] }); }
    }
    if (members.length > MAX_IMPORT_MEMBERS) {
        // Over the cap: people with a role, nickname or member overwrite are
        // kept first (what they get is permissions); "member since"-only people
        // fill what is left, oldest members first.
        const weight = (x: SnapshotMember) => (x.roles.length > 0 || x.nick || memberOverwriteIds.has(x.id) ? 0 : 1);
        members.sort((a, b) => weight(a) - weight(b) || (a.joined_at ?? '9999').localeCompare(b.joined_at ?? '9999'));
        const dropped = members.length - MAX_IMPORT_MEMBERS;
        const droppedRoles = members.slice(MAX_IMPORT_MEMBERS).filter(x => weight(x) === 0).length;
        notMapped.push(droppedRoles > 0
            ? { item: `${droppedRoles.toLocaleString('en-US')} people's roles`, reason: `Over the ${MAX_IMPORT_MEMBERS.toLocaleString('en-US')} people an import can carry roles for` }
            : { item: `${dropped.toLocaleString('en-US')} people's “member since” dates`, reason: `Over the ${MAX_IMPORT_MEMBERS.toLocaleString('en-US')} people an import can carry; the longest-standing members were kept` });
        members.length = MAX_IMPORT_MEMBERS;
    }
    const bans: SnapshotBan[] = [];
    const seenBan = new Set<string>();
    for (const b of people.bans ?? []) {
        const id = b?.user?.id;
        if (!isSnowflake(id) || botIds.has(id) || seenBan.has(id)) continue;
        seenBan.add(id);
        const reason = typeof b.reason === 'string' ? Array.from(b.reason.trim()).slice(0, 500).join('') : '';
        bans.push({ id, ...(reason ? { reason } : {}) });
    }
    if (bans.length > MAX_IMPORT_BANS) {
        notMapped.push({ item: `${bans.length - MAX_IMPORT_BANS} bans`, reason: `Over the ${MAX_IMPORT_BANS.toLocaleString('en-US')} bans an import can carry` });
        bans.length = MAX_IMPORT_BANS;
    }
    if (people.bansUnavailable) {
        notMapped.push({ item: 'Bans', reason: 'The bot cannot read the ban list (it needs Ban Members or Administrator)' });
    }
    if (timeouts > 0) {
        notMapped.push({ item: `Timeouts (${timeouts})`, reason: 'They end on their own within 28 days; time someone out again here if needed' });
    }

    // ── What has no Cipherline counterpart (shown in the preview) ────────
    const features = new Set(Array.isArray(guild.features) ? guild.features : []);
    if ((guild.premium_subscription_count ?? 0) > 0 || (guild.premium_tier ?? 0) > 0) {
        notMapped.push({ item: 'Server boosts and boost tier', reason: 'Cipherline has no boosting' });
    }
    notMapped.push({ item: 'Integrations, bots and webhooks', reason: 'They run on Discord and have no Cipherline equivalent' });
    notMapped.push({ item: 'AutoMod rules', reason: 'Cipherline never scans messages (they are end-to-end encrypted)' });
    if (features.has('WELCOME_SCREEN_ENABLED') || features.has('GUILD_ONBOARDING') || features.has('COMMUNITY')) {
        notMapped.push({ item: 'Welcome screen, onboarding and community settings', reason: 'Cipherline has no equivalent yet' });
    }
    if (guild.vanity_url_code) notMapped.push({ item: 'Vanity invite URL', reason: 'Create a new Cipherline invite link instead' });
    if (guild.splash || guild.discovery_splash) notMapped.push({ item: 'Invite and discovery splash images', reason: 'Not supported' });
    notMapped.push({ item: 'Scheduled events and soundboard', reason: 'Cipherline has no equivalent yet' });
    notMapped.push({ item: 'Threads', reason: 'Coming in a later import phase' });
    notMapped.push({ item: 'Reactions, polls as live polls, voice messages', reason: 'Messages come over as text: reactions are dropped, polls become their results, voice messages a note' });
    notMapped.push({ item: 'Member accounts', reason: 'Nobody is copied: people join with an invite, and get their roles, nickname and channel permissions (or their ban) when they link the same Discord account' });

    const categories = chanSorted.filter(c => c.type === TYPE_CATEGORY).length;
    return {
        snapshot: {
            guild: {
                id: guild.id,
                name: str(guild.name, 100) ?? 'Imported server',
                description: str(guild.description, 1000),
                hasIcon: typeof guild.icon === 'string' && guild.icon.length > 0,
                hasBanner: typeof guild.banner === 'string' && guild.banner.length > 0,
            },
            body,
            emojis,
            members,
            bans,
            roleIcons: [...roleIcons.keys()].sort((a, b) => a - b),
            stickers,
            channelKeys: Object.fromEntries(chanSorted
                .filter(c => MESSAGE_TYPES.has(c.type))
                .map(c => [chanId.get(c.id)!, channelSourceKey(guild.id, c.id)])),
            counts: {
                roles: rolesKept.length, categories, channels: chanSorted.length - categories, emojis: emojis.length,
                members: members.length, bans: bans.length,
            },
            notMapped,
        },
        images: {
            iconHash: typeof guild.icon === 'string' && /^[A-Za-z0-9_]+$/.test(guild.icon) ? guild.icon : null,
            bannerHash: typeof guild.banner === 'string' && /^[A-Za-z0-9_]+$/.test(guild.banner) ? guild.banner : null,
            emojiIds, animatedEmoji,
            channels: new Map(chanSorted.map(c => [chanId.get(c.id)!, { id: c.id, type: c.type, name: c.name ?? 'channel' }])),
            roleNames: new Map(rawRoles.filter(r => r && isSnowflake(r.id) && typeof r.name === 'string').map(r => [r.id, r.name])),
            channelNames: new Map(chanSorted.map(c => [c.id, c.name ?? 'channel'])),
            roleNums: new Map(roleId),
            channelNums: new Map(chanId),
            roleIcons,
            stickers: stickerFiles,
        },
    };
}

/**
 * The member list, 1,000 per request (`after` = the last user id). Needs the
 * bot's privileged Server Members Intent: without it Discord answers 403
 * (50001 Missing Access), turned into the clear `members_intent` error.
 */
export async function fetchGuildMembers(client: DiscordClient, guildId: string, signal?: AbortSignal): Promise<RawMember[]> {
    const all: RawMember[] = [];
    let after = '0';
    for (let page = 0; page < MEMBER_PAGES; page++) {
        let rows: RawMember[];
        try {
            rows = await client.getJson<RawMember[]>(`/guilds/${guildId}/members?limit=1000&after=${after}`, signal);
        } catch (e) {
            if (e instanceof DiscordApiError && e.kind === 'forbidden') {
                throw new DiscordApiError('members_intent', 'Server Members Intent is off.', 403, e.discordCode);
            }
            throw e;
        }
        if (!Array.isArray(rows)) throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
        all.push(...rows);
        if (rows.length < 1000) break;
        const last = rows[rows.length - 1]?.user?.id;
        if (!isSnowflake(last)) break;
        after = last;
    }
    return all;
}

/** The ban list (1,000 per request). Needs Ban Members: null when the bot may not read it. */
export async function fetchGuildBans(client: DiscordClient, guildId: string, signal?: AbortSignal): Promise<RawBan[] | null> {
    const all: RawBan[] = [];
    let after = '0';
    for (let page = 0; page < BAN_PAGES; page++) {
        let rows: RawBan[];
        try {
            rows = await client.getJson<RawBan[]>(`/guilds/${guildId}/bans?limit=1000&after=${after}`, signal);
        } catch (e) {
            if (e instanceof DiscordApiError && e.kind === 'forbidden') return null;
            throw e;
        }
        if (!Array.isArray(rows)) throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
        all.push(...rows);
        if (rows.length < 1000) break;
        const last = rows[rows.length - 1]?.user?.id;
        if (!isSnowflake(last)) break;
        after = last;
    }
    return all;
}

/** The guild's stickers (GET /guilds/:id/stickers). null when the bot may not read them (the import goes on). */
export async function fetchGuildStickers(client: DiscordClient, guildId: string, signal?: AbortSignal): Promise<RawSticker[] | null> {
    try {
        const rows = await client.getJson<RawSticker[]>(`/guilds/${guildId}/stickers`, signal);
        return Array.isArray(rows) ? rows.slice(0, 500) : null;
    } catch (e) {
        if (e instanceof DiscordApiError && (e.kind === 'forbidden' || e.kind === 'not_found')) return null;
        throw e;
    }
}

/** Read the guild: guild (roles + emojis), channels, members, bans, stickers. */
export async function fetchGuildSnapshot(client: DiscordClient, guildId: string, signal?: AbortSignal) {
    if (!isSnowflake(guildId)) throw new DiscordApiError('invalid_response', 'Bad server id.');
    const guild = await client.getJson<RawGuild>(`/guilds/${guildId}`, signal);
    if (!guild || typeof guild !== 'object' || guild.id !== guildId || typeof guild.name !== 'string') {
        throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
    }
    const channels = await client.getJson<RawChannel[]>(`/guilds/${guildId}/channels`, signal);
    if (!Array.isArray(channels)) throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
    const members = await fetchGuildMembers(client, guildId, signal);
    const bans = await fetchGuildBans(client, guildId, signal);
    const stickers = await fetchGuildStickers(client, guildId, signal);
    return buildSnapshot(guild, channels, { members, bans: bans ?? [], bansUnavailable: bans === null, stickers });
}

// ── Images ───────────────────────────────────────────────────────────────

export type ImageRequest =
    | { kind: 'icon' } | { kind: 'banner' }
    | { kind: 'emoji'; emojiId: string }
    | { kind: 'role_icon'; role: number }
    | { kind: 'sticker'; stickerId: string };

export interface FetchedImage { mime: string; bytes: Uint8Array; note?: string }

const IMG_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const EMOJI_FETCH_MAX_BYTES = 1024 * 1024;
export const GUILD_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Raw sticker bytes accepted (Cipherline's own upload cap for stickers: STICKER_UPLOAD_MAX_BYTES). */
export const STICKER_FETCH_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Fetch one image from Discord's CDN for a guild already read. The path is
 * built here from remembered hashes/ids, never from renderer text, so the
 * renderer can only ask "the icon / the banner / emoji N of this guild".
 * Icons and banners are requested as PNG (the CDN serves a still frame for an
 * animated one: the plan's "animated becomes its first frame"). An animated
 * emoji is fetched as a GIF; when that is over the byte cap the still PNG is
 * used instead and the note says so.
 */
export async function fetchGuildImage(
    client: DiscordClient, guildId: string, refs: ImageRefs, req: ImageRequest, signal?: AbortSignal,
): Promise<FetchedImage> {
    const ok = (r: { bytes: Uint8Array; contentType: string }, note?: string): FetchedImage => {
        if (!IMG_MIMES.has(r.contentType)) throw new DiscordApiError('invalid_response', 'Discord sent an unexpected file type.');
        return { mime: r.contentType, bytes: r.bytes, note };
    };
    if (req.kind === 'icon' || req.kind === 'banner') {
        const hash = req.kind === 'icon' ? refs.iconHash : refs.bannerHash;
        if (!hash) throw new DiscordApiError('not_found', 'This server has no such image.');
        const dir = req.kind === 'icon' ? 'icons' : 'banners';
        const size = req.kind === 'icon' ? 512 : 1024;
        return ok(await client.getCdn(`/${dir}/${guildId}/${hash}.png?size=${size}`, GUILD_IMAGE_MAX_BYTES, signal));
    }
    if (req.kind === 'sticker') {
        // A guild sticker: media.discordapp.net/stickers/<id>.png (PNG and APNG) or .gif (Discord serves
        // GIF stickers only there), through the strict media path, only for a sticker THIS guild's read kept.
        const file = refs.stickers?.get(req.stickerId);
        if (!file) throw new DiscordApiError('not_found', 'Unknown sticker.');
        return ok(await client.getMedia(`https://media.discordapp.net/stickers/${req.stickerId}.${file}`, STICKER_FETCH_MAX_BYTES, signal));
    }
    if (req.kind === 'role_icon') {
        // A role's icon picture: CDN role-icons/<role id>/<hash>.png (a still
        // PNG even for an animated one), from what THIS guild's read remembered.
        const icon = refs.roleIcons?.get(req.role);
        if (!icon) throw new DiscordApiError('not_found', 'This role has no icon picture.');
        return ok(await client.getCdn(`/role-icons/${icon.id}/${icon.hash}.png?size=128`, EMOJI_FETCH_MAX_BYTES, signal));
    }
    if (!refs.emojiIds.has(req.emojiId)) throw new DiscordApiError('not_found', 'Unknown emoji.');
    const animated = refs.animatedEmoji.has(req.emojiId);
    if (animated) {
        try {
            return ok(await client.getCdn(`/emojis/${req.emojiId}.gif?size=128`, EMOJI_FETCH_MAX_BYTES, signal));
        } catch (e) {
            if (!(e instanceof DiscordApiError) || e.kind !== 'invalid_response') throw e;
            return ok(await client.getCdn(`/emojis/${req.emojiId}.png?size=128`, EMOJI_FETCH_MAX_BYTES, signal), 'animation dropped (too large)');
        }
    }
    return ok(await client.getCdn(`/emojis/${req.emojiId}.png?size=128`, EMOJI_FETCH_MAX_BYTES, signal));
}
