/**
 * IPC surface of the Discord structure importer (main process).
 *
 * Pure of `electron` (the ipcMain object and the store are injected) so the
 * contract is unit-tested; main.ts only wires `registerDiscordImportIpc`.
 * The main-process sender guard (ipc-guard.ts) wraps `ipcMain.handle`, so
 * every channel here is origin-checked by construction.
 *
 * Token safety:
 *   - the bot token is stored ONLY via the injected store (SecureStore:
 *     AES-256-GCM, master key wrapped by the OS) and sent ONLY to
 *     discord.com in an `Authorization: Bot` header;
 *   - no handler ever returns it: `status` says whether one is saved and the
 *     bot's name, nothing more;
 *   - failures return a controlled `{ code, message }` (the message is
 *     redacted again on the way out), never a raw exception.
 */
import { DiscordApiError, DiscordClient, type DiscordClientOptions } from './discord-client';
import { isSnowflake, normalizeBotToken, redactText } from './redact';
import {
    fetchGuildImage, fetchGuildSnapshot,
    type GuildSnapshot, type ImageRefs, type ImageRequest,
} from './snapshot';
import {
    fetchChannelPins, fetchChannelWindow, fetchMediaByRef, fetchReactors, historyHiddenFromBot, sniffMime,
    type ImportMessage, type MediaRegistry,
} from './history';

export const DISCORD_IMPORT_CHANNELS = {
    status: 'discord-import:status',
    connect: 'discord-import:connect',
    forget: 'discord-import:forget',
    listGuilds: 'discord-import:list-guilds',
    snapshot: 'discord-import:snapshot',
    image: 'discord-import:image',
    cancel: 'discord-import:cancel',
    history: 'discord-import:history',
    media: 'discord-import:media',
    checkApp: 'discord-import:check-app',
    running: 'discord-import:running',
} as const;

/** SecureStore key. Excluded from backups on purpose (backupRegistry.ts). */
export const DISCORD_BOT_STORE_KEY = 'discordImport.bot';

export interface KeyValueStore {
    status?(): string;
    get(key: string): string | null;
    set(key: string, value: string): void;
    delete(key: string): void;
}

/**
 * Where a channel read failed, for the report and the beta diagnostics event: the read step, Discord's HTTP
 * status, and the error class. Labels and numbers only, never text from Discord, a name or an id.
 */
export type HistoryReadStep = 'read' | 'probe' | 'pins' | 'reactions' | 'media';
export interface IpcFailure {
    ok: false;
    error: { code: string; message: string; retryAfterMs?: number; step?: HistoryReadStep; status?: number; errorName?: string };
}
export type IpcResult<T> = ({ ok: true } & T) | IpcFailure;

interface StoredBot { token: string; botId: string; botName: string; app?: AppInfo }

/**
 * The bot's application, read FROM THE TOKEN (GET /oauth2/applications/@me).
 * `id` is the OAuth2 client_id the invite link must carry: deriving it here
 * (never typed by the user) is what guarantees the invite adds the very bot
 * whose token we hold. For old applications the bot user id differs from the
 * application id, so the bot id is not a substitute.
 */
export interface AppInfo {
    id: string;
    name: string;
    /** Privileged intents switched on in the Developer Portal (Bot page). */
    intents: { messageContent: boolean; members: boolean };
}

/** Application flags (Discord docs, "Application Flags"). The _LIMITED variant is what an unverified bot gets. */
export const APP_FLAGS = {
    GATEWAY_GUILD_MEMBERS: 1 << 14,
    GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
    GATEWAY_MESSAGE_CONTENT: 1 << 18,
    GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
} as const;

export function intentsFromFlags(flags: unknown): AppInfo['intents'] {
    const f = typeof flags === 'number' && Number.isInteger(flags) && flags >= 0 ? flags : 0;
    return {
        messageContent: (f & (APP_FLAGS.GATEWAY_MESSAGE_CONTENT | APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0,
        members: (f & (APP_FLAGS.GATEWAY_GUILD_MEMBERS | APP_FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED)) !== 0,
    };
}

/** ADMINISTRATOR, the one permission the invite asks for. */
const ADMINISTRATOR = 8n;

export interface GuildListItem {
    id: string; name: string; owner: boolean; hasIcon: boolean;
    /** Does the bot hold Administrator there? null when Discord did not say. */
    admin: boolean | null;
}

function adminOf(permissions: unknown, owner: boolean): boolean | null {
    if (owner) return true;
    if (typeof permissions !== 'string' || !/^[0-9]{1,30}$/.test(permissions)) return null;
    return (BigInt(permissions) & ADMINISTRATOR) === ADMINISTRATOR;
}

const failure = (code: string, message: string, token?: string | null, retryAfterMs?: number): IpcFailure =>
    ({ ok: false, error: { code, message: redactText(message, token), ...(retryAfterMs ? { retryAfterMs } : {}) } });

/** An error's class name when it is a plain identifier (TypeError, RangeError…), else 'Error'. Never its message. */
export function errorClassOf(e: unknown): string {
    const n = (e as { name?: unknown } | null)?.name;
    return typeof n === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(n) ? n : 'Error';
}

/**
 * describeError for a channel read: the same words, plus where it failed (step, Discord's status, the error
 * class) for the report and the beta diagnostics event.
 */
export function describeReadError(e: unknown, step: HistoryReadStep, token?: string | null): IpcFailure {
    const f = describeError(e, token);
    const status = e instanceof DiscordApiError ? e.status : undefined;
    return { ok: false, error: { ...f.error, step, ...(status !== undefined ? { status } : {}), errorName: e instanceof DiscordApiError ? `discord_${e.kind}` : errorClassOf(e) } };
}

/** Plain-words messages for each failure; never Discord's free text. */
export function describeError(e: unknown, token?: string | null): IpcFailure {
    if (e instanceof DiscordApiError) {
        switch (e.kind) {
            case 'invalid_token': return failure('invalid_token', 'Discord says that token is not valid. Copy it again from the Bot page, or reset it there.', token);
            case 'forbidden':
                // 50001 Missing Access / 50013 Missing Permissions: the bot is in the server without Administrator,
                // or was kicked. Both are fixed the same way: approve the invite link again.
                return failure(e.discordCode === 50001 || e.discordCode === 50013 ? 'missing_access' : 'forbidden', e.discordCode === 50001 || e.discordCode === 50013
                    ? 'The bot can’t see all of that server (Discord says “Missing Access”). It needs Administrator: open the invite link again, pick the server and approve it. If you removed the bot, that adds it back.'
                    : 'Discord won’t let the bot read that. Open the invite link again and approve it with Administrator, then try again.', token);
            case 'not_found': return failure('not_found', 'Discord could not find that. Is the bot still in the server? Open the invite link again to add it back.', token);
            case 'members_intent': return failure('members_intent', 'Turn on "Server Members Intent" for your bot, then try again: Discord Developer Portal, your application, Bot, Privileged Gateway Intents. Cipherline needs the member list to give everyone their roles when they join.', token);
            case 'rate_limited': return failure('rate_limited', 'Discord is asking us to slow down. Wait a moment and try again.', token, e.retryAfterMs);
            case 'aborted': return failure('aborted', 'Cancelled.', token);
            case 'timeout': return failure('timeout', 'Discord did not answer in time. Check your connection and try again.', token);
            case 'network': return failure('network', 'Could not reach Discord. Check your connection and try again.', token);
            case 'server': return failure('discord_down', 'Discord is having trouble right now. Try again in a minute.', token);
            case 'too_large': return failure('too_large', 'This file is too large to bring over.', token);
            default: return failure('invalid_response', 'Discord sent something we could not read.', token);
        }
    }
    // Not Discord: a bug on our side (the owner's #files_pictures was a TypeError in the who-reacted merge,
    // 2026-11-22). Say so in plain words instead of blaming the connection; the class goes to diagnostics.
    return failure('internal', 'Cipherline ran into a problem of its own while reading this from Discord (not your connection or Discord). Try again; if it keeps happening, update Cipherline.', token);
}

export interface DiscordImportDeps {
    store: KeyValueStore;
    clientOptions?: Partial<DiscordClientOptions>;
    /** An import started / stopped running in the renderer (quit-guard.ts asks before quitting). */
    onRunningChange?(running: boolean): void;
}

/** Strict payload checks: plain object, known keys only. */
function plain(input: unknown, keys: string[]): Record<string, unknown> | null {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const have = Object.keys(input);
    if (have.some(k => !keys.includes(k))) return null;
    return input as Record<string, unknown>;
}

/** GET /oauth2/applications/@me: the token's own application (a GET, like every call here). */
async function readApp(c: DiscordClient, signal: AbortSignal): Promise<AppInfo> {
    const a = await c.getJson<{ id?: unknown; name?: unknown; flags?: unknown }>('/oauth2/applications/@me', signal);
    if (!isSnowflake(a?.id)) throw new DiscordApiError('invalid_response', 'unreadable');
    const name = typeof a.name === 'string' && a.name.trim() ? Array.from(a.name).slice(0, 80).join('') : 'your application';
    return { id: a.id, name, intents: intentsFromFlags(a.flags) };
}

/**
 * Without Message Content Intent Discord still returns messages, but with
 * empty text, no attachments, no embeds. Two or more messages that are ALL
 * completely empty can only mean that (a single one could be an odd message
 * type, so one is not enough to refuse).
 */
export function looksLikeNoMessageContent(messages: ImportMessage[]): boolean {
    if (messages.length < 2) return false;
    return messages.every(m => m.content === '' && m.files.length === 0 && m.embeds.length === 0 && m.stickers.length === 0 && !m.poll);
}

export function createDiscordImportHandlers(deps: DiscordImportDeps) {
    const { store } = deps;
    let inflight = new AbortController();
    /** Remembered per guild after a snapshot, so image requests cannot name arbitrary URLs. */
    const refs = new Map<string, ImageRefs>();
    /** File / avatar refs handed to the renderer -> the (signed) Discord URL. Never leaves main. */
    const media: MediaRegistry = new Map();

    const storeReady = (): boolean => (store.status ? store.status() === 'ok' : true);
    const load = (): StoredBot | null => {
        try {
            const raw = store.get(DISCORD_BOT_STORE_KEY);
            if (!raw) return null;
            const p = JSON.parse(raw) as Partial<StoredBot>;
            if (typeof p.token !== 'string' || typeof p.botId !== 'string' || typeof p.botName !== 'string') return null;
            const a = p.app;
            const app = a && isSnowflake(a.id) && typeof a.name === 'string'
                && typeof a.intents?.messageContent === 'boolean' && typeof a.intents?.members === 'boolean'
                ? { id: a.id, name: a.name, intents: { messageContent: a.intents.messageContent, members: a.intents.members } } : undefined;
            return { token: p.token, botId: p.botId, botName: p.botName, ...(app ? { app } : {}) };
        } catch { return null; }
    };
    const client = (token: string) => new DiscordClient({ ...deps.clientOptions, token });

    return {
        /** What is saved. No network: a token saved before the application was recorded has `app: null` (see checkApp). */
        async status(): Promise<IpcResult<{ hasToken: boolean; bot: { id: string; name: string } | null; app: AppInfo | null; storageReady: boolean }>> {
            if (!storeReady()) return { ok: true, hasToken: false, bot: null, app: null, storageReady: false };
            const b = load();
            return { ok: true, hasToken: !!b, bot: b ? { id: b.botId, name: b.botName } : null, app: b?.app ?? null, storageReady: true };
        },

        /**
         * Re-read the bot's application from Discord: its id (for the invite link)
         * and whether the privileged intents are on now (the user may have just
         * switched them on). Updates what is saved.
         */
        async checkApp(): Promise<IpcResult<{ app: AppInfo }>> {
            const b = load();
            if (!b) return failure('no_token', 'Add your bot token first.');
            try {
                const app = await readApp(client(b.token), inflight.signal);
                try { store.set(DISCORD_BOT_STORE_KEY, JSON.stringify({ ...b, app } satisfies StoredBot)); } catch { /* still usable this session */ }
                return { ok: true, app };
            } catch (e) {
                return describeError(e, b.token);
            }
        },

        /** Validate with GET /users/@me, then (and only then) save. */
        async connect(input: unknown): Promise<IpcResult<{ bot: { id: string; name: string }; app: AppInfo }>> {
            const p = plain(input, ['token']);
            const token = p ? normalizeBotToken(p.token) : null;
            if (!token) return failure('bad_token', 'That does not look like a bot token. It is a long string of letters, numbers, dots and dashes from the Bot page.');
            if (!storeReady()) return failure('storage_locked', 'Secure storage is locked, so the token cannot be saved safely. Unlock it first.', token);
            try {
                const me = await client(token).getJson<{ id?: unknown; username?: unknown; bot?: unknown }>('/users/@me', inflight.signal);
                if (!isSnowflake(me?.id) || typeof me.username !== 'string') throw new DiscordApiError('invalid_response', 'unreadable');
                if (me.bot !== true) {
                    return failure('not_a_bot', 'That token belongs to a person, not a bot. Cipherline only works with a bot you create yourself, never a personal account token.', token);
                }
                const botName = Array.from(me.username).slice(0, 80).join('');
                // The invite link is built from THIS (never a typed id), so it always adds the token's own bot.
                const app = await readApp(client(token), inflight.signal);
                store.set(DISCORD_BOT_STORE_KEY, JSON.stringify({ token, botId: me.id, botName, app } satisfies StoredBot));
                return { ok: true, bot: { id: me.id, name: botName }, app };
            } catch (e) {
                return describeError(e, token);
            }
        },

        async forget(): Promise<IpcResult<object>> {
            inflight.abort();
            inflight = new AbortController();
            refs.clear();
            media.clear();
            try { store.delete(DISCORD_BOT_STORE_KEY); } catch { /* nothing stored */ }
            return { ok: true };
        },

        async listGuilds(): Promise<IpcResult<{ guilds: GuildListItem[] }>> {
            const b = load();
            if (!b) return failure('no_token', 'Add your bot token first.');
            try {
                const rows = await client(b.token).paginateAfter<{ id: string; name?: unknown; owner?: unknown; icon?: unknown; permissions?: unknown }>(
                    '/users/@me/guilds', 200, inflight.signal,
                );
                const guilds = rows
                    .filter(g => isSnowflake(g.id))
                    // A guild without a readable name is still listed: silently dropping rows is one way to tell a bot
                    // that IS in a server that it is in none.
                    .map(g => ({
                        id: g.id,
                        name: typeof g.name === 'string' && g.name.trim() ? Array.from(g.name).slice(0, 100).join('') : 'Unnamed server',
                        owner: g.owner === true,
                        hasIcon: typeof g.icon === 'string' && g.icon.length > 0,
                        admin: adminOf(g.permissions, g.owner === true),
                    }));
                return { ok: true, guilds };
            } catch (e) {
                return describeError(e, b.token);
            }
        },

        async snapshot(input: unknown): Promise<IpcResult<{ snapshot: GuildSnapshot }>> {
            const p = plain(input, ['guildId']);
            if (!p || !isSnowflake(p.guildId)) return failure('bad_request', 'Pick a server first.');
            const b = load();
            if (!b) return failure('no_token', 'Add your bot token first.');
            try {
                const { snapshot, images } = await fetchGuildSnapshot(client(b.token), p.guildId, inflight.signal);
                refs.set(p.guildId, images);
                return { ok: true, snapshot };
            } catch (e) {
                return describeError(e, b.token);
            }
        },

        async image(input: unknown): Promise<IpcResult<{ mime: string; dataB64: string; note?: string }>> {
            const p = plain(input, ['guildId', 'kind', 'emojiId', 'role', 'stickerId']);
            if (!p || !isSnowflake(p.guildId)) return failure('bad_request', 'Bad request.');
            let req: ImageRequest;
            const others = (...keep: string[]) => ['emojiId', 'role', 'stickerId'].some(k => !keep.includes(k) && p[k] !== undefined);
            if (p.kind === 'icon' || p.kind === 'banner') {
                if (others()) return failure('bad_request', 'Bad request.');
                req = { kind: p.kind };
            } else if (p.kind === 'emoji' && isSnowflake(p.emojiId) && !others('emojiId')) {
                req = { kind: 'emoji', emojiId: p.emojiId };
            } else if (p.kind === 'role_icon' && Number.isSafeInteger(p.role) && (p.role as number) > 0 && (p.role as number) <= 1_000 && !others('role')) {
                // A role by the snapshot's small number: the Discord role id and
                // icon hash come from what this guild's read remembered.
                req = { kind: 'role_icon', role: p.role as number };
            } else if (p.kind === 'sticker' && isSnowflake(p.stickerId) && !others('stickerId')) {
                // A guild sticker by its Discord id: only one this guild's read kept is fetchable.
                req = { kind: 'sticker', stickerId: p.stickerId };
            } else {
                return failure('bad_request', 'Bad request.');
            }
            const b = load();
            const r = refs.get(p.guildId);
            if (!b) return failure('no_token', 'Add your bot token first.');
            if (!r) return failure('bad_request', 'Read the server first.');
            try {
                const img = await fetchGuildImage(client(b.token), p.guildId, r, req, inflight.signal);
                return { ok: true, mime: img.mime, dataB64: Buffer.from(img.bytes).toString('base64'), ...(img.note ? { note: img.note } : {}) };
            } catch (e) {
                return describeError(e, b.token);
            }
        },

        /**
         * One channel's history window (the larger of the last 1,000 messages and
         * the last 30 days, at most 25,000) plus all its pins and who reacted, for
         * the history import. `channel` is
         * the SNAPSHOT channel number: the Discord channel id never leaves main.
         * Also returns role / channel names so mentions can be written as text.
         */
        async history(input: unknown): Promise<IpcResult<{
            messages: ImportMessage[]; pins: ImportMessage[]; truncated: boolean; ceilingHit: boolean; reactionRequests: number;
            /** What a best-effort part of the read (pins, who reacted) could not get, for the report. */
            notes?: string[];
            /** Messages Discord sent that could not be read (left out). */
            unreadable?: number;
            /** Discord stopped answering partway: only the newest messages came (labels for the report / diagnostics). */
            partial?: { kind: string; status?: number };
            names: { roles: Record<string, string>; channels: Record<string, string>; roleNums: Record<string, number>; channelNums: Record<string, number> };
        }>> {
            const p = plain(input, ['guildId', 'channel']);
            if (!p || !isSnowflake(p.guildId) || typeof p.channel !== 'number' || !Number.isInteger(p.channel) || p.channel < 0) {
                return failure('bad_request', 'Bad request.');
            }
            const b = load();
            const r = refs.get(p.guildId);
            if (!b) return failure('no_token', 'Add your bot token first.');
            const ch = r?.channels?.get(p.channel);
            if (!r || !ch) return failure('bad_request', 'Read the server first.');
            let step: HistoryReadStep = 'read';
            try {
                const c = client(b.token);
                const win = await fetchChannelWindow(c, ch.id, media, inflight.signal, deps.clientOptions?.sleep ? { sleep: deps.clientOptions.sleep } : {});
                step = 'probe';
                if (win.read === 0 && await historyHiddenFromBot(c, ch.id, inflight.signal)) {
                    return failure('history_hidden', 'Discord sent no messages for this channel, but it has some: the bot can’t read its history. Give the bot Administrator (or Read Message History in this channel), then retry it.', b.token);
                }
                if (looksLikeNoMessageContent(win.messages)) {
                    return failure('no_message_content', 'Discord sent this channel’s messages without their text, which means Message Content Intent is off. Turn it on in the Developer Portal (your application, Bot page, Privileged Gateway Intents), press Save Changes, then try again.', b.token);
                }
                // Pins and who-reacted are extras on top of the messages: if Discord
                // refuses them, the messages still come over and the report says what is
                // missing (it used to drop the whole channel).
                const notes: string[] = [];
                if (win.stoppedEarly) {
                    notes.push(`Discord stopped answering partway through, so only the newest ${win.messages.length.toLocaleString('en-US')} messages came over. Older ones were left on Discord.`);
                }
                if (win.unreadable > 0) {
                    notes.push(`${win.unreadable.toLocaleString('en-US')} message${win.unreadable === 1 ? '' : 's'} Discord sent could not be read and ${win.unreadable === 1 ? 'was' : 'were'} left out.`);
                }
                let pins: ImportMessage[] = [];
                step = 'pins';
                try {
                    pins = await fetchChannelPins(c, ch.id, media, inflight.signal);
                } catch (e) {
                    if (e instanceof DiscordApiError && e.kind === 'aborted') throw e;
                    notes.push('Pinned messages could not be read from Discord, so pins were not copied.');
                }
                // Who reacted is decoration on top of the messages: NOTHING that goes wrong here (Discord, or a
                // bug of ours like the 2026-11-22 TypeError) may cost the channel. Emoji and counts stay.
                step = 'reactions';
                const gaps: { reactors?: string } = {};
                let reactionRequests = 0;
                try {
                    reactionRequests = await fetchReactors(c, ch.id, [...win.messages, ...pins], inflight.signal, undefined, gaps);
                } catch (e) {
                    if (inflight.signal.aborted || (e instanceof DiscordApiError && e.kind === 'aborted')) throw e;
                    gaps.reactors = errorClassOf(e);
                }
                if (gaps.reactors) notes.push('Discord stopped answering who reacted, so some reactions show a count without names.');
                return {
                    ok: true, messages: win.messages, pins, truncated: win.truncated, ceilingHit: win.ceilingHit, reactionRequests,
                    ...(notes.length ? { notes } : {}),
                    ...(win.unreadable > 0 ? { unreadable: win.unreadable } : {}),
                    ...(win.stoppedEarly ? { partial: { ...win.stoppedEarly } } : {}),
                    names: {
                        roles: Object.fromEntries(r.roleNames ?? []),
                        channels: Object.fromEntries(r.channelNames ?? []),
                        roleNums: Object.fromEntries(r.roleNums ?? []),
                        channelNums: Object.fromEntries(r.channelNums ?? []),
                    },
                };
            } catch (e) {
                return describeReadError(e, step, b.token);
            }
        },

        /** Bytes of one file / avatar the renderer was given a ref for (and only those). */
        async media(input: unknown): Promise<IpcResult<{ mime: string; bytes: Uint8Array }>> {
            const p = plain(input, ['ref']);
            if (!p || typeof p.ref !== 'string' || !/^[0-9a-f-]{36}$/.test(p.ref)) return failure('bad_request', 'Bad request.');
            const b = load();
            if (!b) return failure('no_token', 'Add your bot token first.');
            if (!media.has(p.ref)) return failure('bad_request', 'Unknown file.');
            try {
                const r = await fetchMediaByRef(client(b.token), media, p.ref, inflight.signal);
                return { ok: true, mime: sniffMime(r.bytes, r.mime), bytes: r.bytes };
            } catch (e) {
                if (e instanceof DiscordApiError && e.message === 'too_large') return failure('too_large', 'This file is too large to bring over.', b.token);
                return describeReadError(e, 'media', b.token);
            }
        },

        /** The renderer's background import started / stopped (`{ running: boolean }`, nothing else). */
        async setRunning(input: unknown): Promise<IpcResult<object>> {
            const p = plain(input, ['running']);
            if (!p || typeof p.running !== 'boolean') return failure('bad_request', 'Bad request.');
            deps.onRunningChange?.(p.running);
            return { ok: true };
        },

        /** Abort whatever Discord requests are in flight (the wizard's Cancel). */
        async cancel(): Promise<IpcResult<object>> {
            inflight.abort();
            inflight = new AbortController();
            return { ok: true };
        },
    };
}

export interface IpcMainLike {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export function registerDiscordImportIpc(ipcMain: IpcMainLike, deps: DiscordImportDeps): void {
    const h = createDiscordImportHandlers(deps);
    const C = DISCORD_IMPORT_CHANNELS;
    ipcMain.handle(C.status, () => h.status());
    ipcMain.handle(C.connect, (_e, input) => h.connect(input));
    ipcMain.handle(C.forget, () => h.forget());
    ipcMain.handle(C.listGuilds, () => h.listGuilds());
    ipcMain.handle(C.snapshot, (_e, input) => h.snapshot(input));
    ipcMain.handle(C.image, (_e, input) => h.image(input));
    ipcMain.handle(C.cancel, () => h.cancel());
    ipcMain.handle(C.history, (_e, input) => h.history(input));
    ipcMain.handle(C.media, (_e, input) => h.media(input));
    ipcMain.handle(C.running, (_e, input) => h.setRunning(input));
    ipcMain.handle(C.checkApp, () => h.checkApp());
}
