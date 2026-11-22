/**
 * Read one Discord channel's recent history and pins with the user's OWN bot
 * (Discord import phase 2; docs/plans/discord-import.md B3, B6.4). Main
 * process only; pure of `electron` so it is unit-tested with a mock Discord.
 *
 * The window (owner, 2026-11-22): per channel, the LARGER of "the last 1,000
 * messages" and "every message from the last 30 days, counted from the
 * import", never more than the 25,000-message ceiling (IMPORT_CAPS, the cost
 * reasoning lives there). Pins are fetched separately and always come over,
 * whatever their age.
 *
 * What leaves this module for the renderer: message text, author names and
 * Discord ids (the renderer registers authors with the API, which stores only a
 * keyed hash), message ids (reply/pin mapping, never sent anywhere), and an
 * opaque `ref` per file. File URLs (signed, expiring) stay HERE in a registry:
 * the renderer can only ask "the bytes of ref X", never name a URL.
 *
 * Reactions (owner 2026-11-22): every message object already carries its
 * reactions (emoji + count). WHO reacted costs one request per (message,
 * emoji) for the first 100 people (`fetchReactors`), budgeted per channel;
 * past the budget a reaction keeps its emoji and count with no names.
 * Reactors' Discord ids go to the renderer like authors' (the API keeps only
 * the keyed hash).
 */
import { DiscordApiError, checkMediaUrl, type DiscordClient } from './discord-client';
import { isSnowflake } from './redact';

/** Web Crypto's UUID (global in Node 19+ and Electron main; also the page in the harness). */
const randomUUID = (): string => (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID();

export const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** The floor: at least this many of the newest messages (IMPORT_CAPS.messagesPerChannelWindow). */
export const HISTORY_MIN_MESSAGES = 1000;
/** The safety ceiling per channel (IMPORT_CAPS.messagesPerChannelCeiling). */
export const HISTORY_MAX_MESSAGES = 25_000;
export const PINS_MAX = 250;
/** Files are held in memory and handed over IPC: anything bigger is skipped with a note. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
/** A sticker's picture on Discord's media host (GIF stickers live only there; PNG / APNG as .png). */
export const stickerMediaUrl = (id: string, ext: 'png' | 'gif'): string => `https://media.discordapp.net/stickers/${id}.${ext}`;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Message types that carry a person's words. Everything else (joins, boosts, pin notices…) is dropped. */
const KEPT_TYPES = new Set([0, 19, 20, 23]);
const VOICE_MESSAGE_FLAG = 1 << 13;

// ── What Discord returns (only the fields we read) ───────────────────────

interface RawUser { id?: unknown; username?: unknown; global_name?: unknown; avatar?: unknown; bot?: unknown; discriminator?: unknown }
interface RawAttachment { id?: unknown; filename?: unknown; size?: unknown; url?: unknown; content_type?: unknown }
interface RawEmbedImage { url?: unknown; proxy_url?: unknown }
interface RawEmbed { type?: unknown; image?: RawEmbedImage; thumbnail?: RawEmbedImage; title?: unknown; description?: unknown; url?: unknown; fields?: unknown; author?: { name?: unknown }; footer?: { text?: unknown } }
/** The original message inside a forward: the same fields, minus ids and author. */
interface RawSnapshot {
    content?: unknown; timestamp?: unknown; mentions?: RawUser[]; attachments?: RawAttachment[]; embeds?: RawEmbed[];
    sticker_items?: RawStickerItem[]; flags?: unknown;
}
interface RawStickerItem { id?: unknown; name?: unknown; format_type?: unknown }
export interface RawMessage {
    id?: unknown; type?: unknown; content?: unknown; timestamp?: unknown; edited_timestamp?: unknown;
    author?: RawUser; webhook_id?: unknown; mentions?: RawUser[]; flags?: unknown; pinned?: unknown;
    attachments?: RawAttachment[]; embeds?: RawEmbed[]; sticker_items?: RawStickerItem[];
    message_reference?: { message_id?: unknown; type?: unknown };
    /** A forward (message_reference.type 1) carries the original here, `message` only. */
    message_snapshots?: Array<{ message?: RawSnapshot }>;
    poll?: { question?: { text?: unknown }; answers?: Array<{ answer_id?: unknown; poll_media?: { text?: unknown } }>; results?: { answer_counts?: Array<{ id?: unknown; count?: unknown }> } };
    reactions?: Array<{ count?: unknown; emoji?: { id?: unknown; name?: unknown; animated?: unknown } }>;
}

// ── What the renderer gets ───────────────────────────────────────────────

export interface ImportAuthorInfo {
    /** Discord user / webhook id. Sent to the API once, where only its keyed hash is kept. */
    id: string;
    name: string;
    /** The new-style Discord handle, when it has one. */
    username: string | null;
    kind: 'user' | 'webhook' | 'app';
    avatarRef: string | null;
}

export interface ImportFileInfo {
    ref: string; filename: string; size: number; mime: string; voice: boolean;
    /** A picture lifted out of an embed (image / thumbnail), not an attachment of the message. */
    embedImage?: boolean;
}

export interface ImportMessage {
    id: string;
    ts: string;
    edited: boolean;
    author: ImportAuthorInfo;
    content: string;
    /** User id -> display name, for `<@id>` mentions in `content`. */
    mentionNames: Record<string, string>;
    replyTo: string | null;
    files: ImportFileInfo[];
    embeds: Array<{ title: string | null; description: string | null; url: string | null; fields: Array<{ name: string; value: string }>; author: string | null; footer: string | null }>;
    stickers: string[];
    /**
     * The stickers with their Discord id (absent from an older main process):
     * `ref` fetches the picture (PNG / APNG / GIF) through the media path; null
     * for a Lottie sticker, which cannot become a picture.
     */
    stickerItems?: ImportStickerItem[];
    /** A forward: the ORIGINAL's words (its files and embeds are folded into `files` / `embeds`). */
    forwarded: { content: string; ts: string | null } | null;
    poll: { question: string; answers: Array<{ text: string; votes: number }> } | null;
    pinned: boolean;
    /** Up to 20 per message (Discord's limit). `users` filled by fetchReactors (first 100), [] past the budget. */
    reactions: ImportReaction[];
}

export interface ImportReactor { id: string; name: string; kind: 'user' | 'app' }
export interface ImportStickerItem { id: string; name: string; format: number; ref: string | null }
export interface ImportReaction {
    emoji: { id: string | null; name: string; animated: boolean };
    count: number;
    users: ImportReactor[];
}

/**
 * Reactor requests per channel (one per message x emoji, 100 people each),
 * newest messages first. Emoji and counts ALWAYS come over (they are on the
 * message object); this only bounds the names. 500 keeps a 20-channel import
 * to ~10,000 extra requests (~33 min at an assumed 5 requests/s; the client
 * follows Discord's real rate-limit headers). See fetchReactors.
 */
export const REACTION_FETCH_BUDGET_PER_CHANNEL = 500;
export const REACTORS_PER_REACTION = 100;

export interface MediaEntry { url: string; kind: 'file' | 'avatar'; channelId: string; messageId?: string; attachmentId?: string; max: number }
export type MediaRegistry = Map<string, MediaEntry>;

const s = (v: unknown, max: number): string => (typeof v === 'string' ? Array.from(v).slice(0, max).join('') : '');

function authorOf(m: RawMessage, reg: MediaRegistry, channelId: string): ImportAuthorInfo | null {
    const a = m.author;
    if (!a || !isSnowflake(a.id)) return null;
    const isWebhook = isSnowflake(m.webhook_id);
    const kind: ImportAuthorInfo['kind'] = isWebhook ? 'webhook' : a.bot === true ? 'app' : 'user';
    const uname = typeof a.username === 'string' ? a.username : '';
    const name = s(a.global_name, 80) || s(uname, 80) || 'Unknown';
    const handle = !isWebhook && /^[a-z0-9_.]{2,32}$/.test(uname) && (a.discriminator === undefined || a.discriminator === '0') ? uname : null;
    let avatarRef: string | null = null;
    if (typeof a.avatar === 'string' && /^(a_)?[0-9a-f]{32}$/.test(a.avatar)) {
        const url = `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.png?size=128`;
        avatarRef = register(reg, { url, kind: 'avatar', channelId, max: AVATAR_MAX_BYTES });
    }
    return { id: a.id, name, username: handle, kind, avatarRef };
}

function register(reg: MediaRegistry, e: MediaEntry): string | null {
    if (!checkMediaUrl(e.url)) return null;
    for (const [ref, have] of reg) if (have.url === e.url) return ref;
    const ref = randomUUID();
    reg.set(ref, e);
    return ref;
}

const MAX_EMBED_IMAGES_PER_MESSAGE = 10;

function collectFiles(list: RawAttachment[] | undefined, voice: boolean, messageId: string, reg: MediaRegistry, channelId: string, files: ImportFileInfo[]): void {
    for (const att of Array.isArray(list) ? list : []) {
        if (!att || !isSnowflake(att.id)) continue;
        const ref = typeof att.url === 'string'
            ? register(reg, { url: att.url, kind: 'file', channelId, messageId, attachmentId: att.id, max: MEDIA_MAX_BYTES })
            : null;
        files.push({
            ref: ref ?? '',
            filename: s(att.filename, 255) || 'file',
            size: typeof att.size === 'number' && att.size >= 0 ? att.size : 0,
            mime: typeof att.content_type === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(att.content_type.split(';')[0]) ? att.content_type.split(';')[0].toLowerCase() : 'application/octet-stream',
            voice,
        });
    }
}

/**
 * Embeds as text fields, plus ONE picture per embed (its image, else its
 * thumbnail) when that picture lives on Discord's own media hosts (the same
 * strict allow-list as attachments; an external site's picture is reached
 * only through Discord's proxy host, which is not on it, so it stays a link).
 * At most 10 pictures per message; they ride the normal file path, so the
 * same size limits, MIME sniffing and encryption apply.
 */
function collectEmbeds(list: RawEmbed[] | undefined, reg: MediaRegistry, channelId: string, files: ImportFileInfo[], embeds: ImportMessage['embeds']): void {
    let pics = files.filter(f => f.embedImage).length;
    for (const e of Array.isArray(list) ? list.slice(0, 10) : []) {
        if (!e || typeof e !== 'object') continue;
        const fields = (Array.isArray(e.fields) ? e.fields : []).slice(0, 25)
            .filter((f): f is { name: unknown; value: unknown } => !!f && typeof f === 'object')
            .map(f => ({ name: s(f.name, 256), value: s(f.value, 1024) }));
        const out = {
            title: s(e.title, 256) || null, description: s(e.description, 4096) || null,
            url: typeof e.url === 'string' && /^https?:\/\//.test(e.url) ? s(e.url, 2048) : null,
            fields, author: s(e.author?.name, 256) || null, footer: s(e.footer?.text, 2048) || null,
        };
        if (out.title || out.description || out.fields.length || out.author || out.footer || out.url) embeds.push(out);
        if (pics >= MAX_EMBED_IMAGES_PER_MESSAGE) continue;
        for (const img of [e.image, e.thumbnail]) {
            const url = [img?.url, img?.proxy_url].find(u => checkMediaUrl(u)) as string | undefined;
            if (!url) continue;
            const ref = register(reg, { url, kind: 'file', channelId, max: MEDIA_MAX_BYTES });
            if (!ref) continue;
            if (files.some(f => f.ref === ref)) break; // already an attachment of this message
            let last = '';
            try { last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''); } catch { /* keep empty */ }
            last = last.replace(/[^\w.\-]+/g, '_').slice(0, 100);
            files.push({ ref, filename: /\.[A-Za-z0-9]{2,5}$/.test(last) ? last : 'embed-image', size: 0, mime: 'application/octet-stream', voice: false, embedImage: true });
            pics++;
            break;
        }
    }
}

/** One raw message -> what the renderer needs, or null for types that carry no words. */
export function normalizeMessage(m: RawMessage, reg: MediaRegistry, channelId: string): ImportMessage | null {
    if (!m || !isSnowflake(m.id) || typeof m.type !== 'number' || !KEPT_TYPES.has(m.type)) return null;
    const ts = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN;
    if (!Number.isFinite(ts)) return null;
    const author = authorOf(m, reg, channelId);
    if (!author) return null;
    const mentionNames: Record<string, string> = {};
    const fwdStickers: string[] = [];
    for (const u of Array.isArray(m.mentions) ? m.mentions : []) {
        if (u && isSnowflake(u.id)) mentionNames[u.id] = s(u.global_name, 80) || s(u.username, 80) || 'someone';
    }
    const files: ImportFileInfo[] = [];
    const embeds: ImportMessage['embeds'] = [];
    collectFiles(m.attachments, typeof m.flags === 'number' && (m.flags & VOICE_MESSAGE_FLAG) !== 0, m.id as string, reg, channelId, files);
    collectEmbeds(m.embeds, reg, channelId, files, embeds);
    // A forward: the words, files and embeds of the ORIGINAL become this message's body.
    let forwarded: ImportMessage['forwarded'] = null;
    const snap = m.message_reference?.type === 1 && Array.isArray(m.message_snapshots) ? m.message_snapshots[0]?.message : undefined;
    if (snap && typeof snap === 'object') {
        for (const u of Array.isArray(snap.mentions) ? snap.mentions : []) {
            if (u && isSnowflake(u.id)) mentionNames[u.id] = s(u.global_name, 80) || s(u.username, 80) || 'someone';
        }
        collectFiles(snap.attachments, typeof snap.flags === 'number' && (snap.flags & VOICE_MESSAGE_FLAG) !== 0, m.id as string, reg, channelId, files);
        collectEmbeds(snap.embeds, reg, channelId, files, embeds);
        const sts = Date.parse(typeof snap.timestamp === 'string' ? snap.timestamp : '');
        forwarded = { content: s(snap.content, 4000), ts: Number.isFinite(sts) ? new Date(sts).toISOString() : null };
        for (const x of Array.isArray(snap.sticker_items) ? snap.sticker_items : []) { const n = s(x?.name, 80); if (n) fwdStickers.push(n); }
    }
    const stickers = [...(Array.isArray(m.sticker_items) ? m.sticker_items : []).map(x => s(x?.name, 80)).filter(Boolean), ...fwdStickers];
    // The message's own stickers (Discord allows 3), by id: a picture's bytes come
    // through the same strict media path as attachments (media host, stickers/).
    const stickerItems: ImportStickerItem[] = [];
    for (const x of Array.isArray(m.sticker_items) ? m.sticker_items.slice(0, 3) : []) {
        if (!x || !isSnowflake(x.id) || typeof x.format_type !== 'number') continue;
        const name = s(x.name, 80) || 'sticker';
        const ext = x.format_type === 4 ? 'gif' : x.format_type === 1 || x.format_type === 2 ? 'png' : null;
        const ref = ext ? register(reg, { url: stickerMediaUrl(x.id, ext), kind: 'file', channelId, max: MEDIA_MAX_BYTES }) : null;
        stickerItems.push({ id: x.id, name, format: x.format_type, ref: ref ?? null });
    }
    let poll: ImportMessage['poll'] = null;
    if (m.poll && typeof m.poll === 'object') {
        const counts = new Map<number, number>();
        for (const c of m.poll.results?.answer_counts ?? []) if (typeof c?.id === 'number' && typeof c.count === 'number') counts.set(c.id, c.count);
        poll = {
            question: s(m.poll.question?.text, 300) || 'Poll',
            answers: (m.poll.answers ?? []).slice(0, 10).map(a => ({ text: s(a?.poll_media?.text, 55), votes: typeof a?.answer_id === 'number' ? counts.get(a.answer_id) ?? 0 : 0 })),
        };
    }
    const reactions: ImportReaction[] = [];
    for (const r of Array.isArray(m.reactions) ? m.reactions.slice(0, 20) : []) {
        const e = r?.emoji;
        const count = typeof r?.count === 'number' && Number.isSafeInteger(r.count) && r.count > 0 ? r.count : 0;
        if (!e || !count) continue;
        const id = isSnowflake(e.id) ? e.id : null;
        const name = s(e.name, 64);
        if (!name || (id && !/^[A-Za-z0-9_~]{1,64}$/.test(name))) continue;
        reactions.push({ emoji: { id, name, animated: e.animated === true }, count, users: [] });
    }
    const ref = m.message_reference;
    return {
        id: m.id as string,
        ts: new Date(ts).toISOString(),
        edited: typeof m.edited_timestamp === 'string' && m.edited_timestamp.length > 0,
        author,
        content: s(m.content, 4000),
        mentionNames,
        replyTo: m.type === 19 && ref && (ref.type === undefined || ref.type === 0) && isSnowflake(ref.message_id) ? ref.message_id : null,
        files, embeds, stickers, stickerItems, forwarded, poll,
        pinned: m.pinned === true,
        reactions,
    };
}

/**
 * Who reacted: `GET /channels/:cid/messages/:mid/reactions/:emoji?limit=100`,
 * one request per (message, emoji), first page only (100 people; the count
 * still says how many in all). Spends at most `budget` requests per channel,
 * newest messages first (the ones people look at); the rest keep emoji and
 * count without names. Rate limits are Discord's headers, honoured by the
 * client. Messages are mutated in place (window and pins share objects by id).
 * Returns the requests spent.
 */
export async function fetchReactors(
    client: DiscordClient, channelId: string, messages: ImportMessage[], signal?: AbortSignal,
    budget = REACTION_FETCH_BUDGET_PER_CHANNEL, gaps?: { reactors?: string },
): Promise<number> {
    if (!isSnowflake(channelId)) throw new DiscordApiError('invalid_response', 'Bad channel id.');
    let spent = 0;
    const byId = new Map<string, ImportMessage[]>();
    for (const m of messages) byId.set(m.id, [...(byId.get(m.id) ?? []), m]);
    const newestFirst = [...byId.keys()].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1));
    for (const mid of newestFirst) {
        const copies = byId.get(mid)!;
        for (let i = 0; i < copies[0].reactions.length; i++) {
            if (spent >= budget) return spent;
            const r = copies[0].reactions[i];
            const key = encodeURIComponent(r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name);
            spent++;
            let rows: RawUser[];
            try {
                rows = await client.getJson<RawUser[]>(`/channels/${channelId}/messages/${mid}/reactions/${key}?limit=${REACTORS_PER_REACTION}&type=0`, signal);
            } catch (e) {
                if (e instanceof DiscordApiError && (e.kind === 'not_found' || e.kind === 'forbidden' || e.kind === 'invalid_response')) continue;
                if (signal?.aborted || (e instanceof DiscordApiError && e.kind === 'aborted')) throw e;
                // Who reacted is decoration. A lookup Discord keeps refusing (a long rate
                // limit, an outage, timeouts) used to throw away the WHOLE channel read,
                // and the busiest channels need the most lookups (docs/worklog/entries/
                // 2026-11-22-discord-import-zero-channels.md). Stop looking up names for
                // this channel instead; every message keeps its emoji and counts.
                if (gaps) gaps.reactors = e instanceof Error ? e.message : 'failed';
                return spent;
            }
            const users: ImportReactor[] = [];
            const seen = new Set<string>();
            for (const u of Array.isArray(rows) ? rows.slice(0, REACTORS_PER_REACTION) : []) {
                if (!u || !isSnowflake(u.id) || seen.has(u.id)) continue;
                seen.add(u.id);
                users.push({ id: u.id, name: s(u.global_name, 80) || s(u.username, 80) || 'Unknown', kind: u.bot === true ? 'app' : 'user' });
            }
            // The window and the pins read are two answers from Discord, seconds apart: the pinned copy of a
            // message can carry FEWER reactions (or another order) than the window copy. Indexing the other copy
            // by this one's position read `undefined.count` and threw a TypeError that killed the whole channel
            // read ("Something went wrong talking to Discord", the owner's #files_pictures, 2026-11-22). Match
            // each copy's reaction by its emoji instead; a copy without that reaction is left alone.
            const want = emojiKey(r.emoji);
            for (const c of copies) {
                const j = c.reactions.findIndex(x => emojiKey(x.emoji) === want);
                if (j >= 0) c.reactions[j] = { ...c.reactions[j], users, count: Math.max(c.reactions[j].count, users.length) };
            }
        }
    }
    return spent;
}

const emojiKey = (e: ImportReaction['emoji']): string => (e.id ? `c:${e.id}` : `u:${e.name}`);

/**
 * The window, newest first while reading: keep going while EITHER fewer than
 * 1,000 messages have been read OR the message is from the last 30 days
 * (counted from `now`, the import); stop at the 25,000 ceiling. So: 0 recent
 * messages of 12,000 -> the last 1,000; 8,000 in 30 days -> all 8,000; 300
 * in all -> all 300. `ceilingHit` = stopped by the ceiling while the rule
 * wanted more. Returns OLDEST FIRST.
 */
/** A page read Discord may answer better in a moment: an outage, a timeout, a long rate limit, an unreadable body. */
export function transientDiscordError(e: unknown): e is DiscordApiError {
    if (!(e instanceof DiscordApiError)) return false;
    if (e.kind === 'server' || e.kind === 'network' || e.kind === 'timeout' || e.kind === 'rate_limited') return true;
    // A 200 whose body was not JSON (an edge HTML page), or an odd 5xx-ish status the client did not retry.
    return e.kind === 'invalid_response' && (e.status === undefined || e.status >= 500 || e.status === 408);
}

/** Waits before re-reading a page that failed transiently (on top of the client's own quick retries). */
export const PAGE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;
/** A Retry-After longer than this is not waited out on a page; the read stops there (partial / failed). */
export const PAGE_RETRY_MAX_WAIT_MS = 5 * 60_000;

export interface WindowStop { kind: DiscordApiError['kind']; status?: number }

export async function fetchChannelWindow(
    client: DiscordClient, channelId: string, reg: MediaRegistry, signal?: AbortSignal,
    opts: { windowMs?: number; minMessages?: number; maxMessages?: number; now?: number; sleep?: (ms: number) => Promise<void>; retryDelaysMs?: readonly number[] } = {},
): Promise<{
    messages: ImportMessage[]; truncated: boolean; read: number; ceilingHit: boolean;
    /** Messages Discord sent that could not be turned into an import message (left out, counted). */
    unreadable: number;
    /** Discord stopped answering after some pages: the newest messages came over, older ones did not. */
    stoppedEarly?: WindowStop;
}> {
    if (!isSnowflake(channelId)) throw new DiscordApiError('invalid_response', 'Bad channel id.');
    const windowMs = opts.windowMs ?? HISTORY_WINDOW_MS;
    const min = opts.minMessages ?? HISTORY_MIN_MESSAGES;
    const max = opts.maxMessages ?? HISTORY_MAX_MESSAGES;
    const cutoff = (opts.now ?? Date.now()) - windowMs;
    const out: ImportMessage[] = [];
    let before: string | null = null;
    let read = 0;
    let truncated = false;
    let ceilingHit = false;
    let unreadable = 0;
    let stoppedEarly: WindowStop | undefined;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const delays = opts.retryDelaysMs ?? PAGE_RETRY_DELAYS_MS;
    /** One page, re-read after a pause when Discord fails it transiently (the client already retried quickly). */
    const readPage = async (path: string): Promise<RawMessage[]> => {
        for (let attempt = 0; ; attempt++) {
            try {
                const page = await client.getJson<RawMessage[]>(path, signal);
                if (!Array.isArray(page)) throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
                return page;
            } catch (e) {
                if (signal?.aborted || (e instanceof DiscordApiError && e.kind === 'aborted')) throw e;
                if (!transientDiscordError(e) || attempt >= delays.length) throw e;
                const wait = Math.max(delays[attempt], e.retryAfterMs ?? 0);
                if (wait > PAGE_RETRY_MAX_WAIT_MS) throw e;
                await sleep(wait);
                if (signal?.aborted) throw new DiscordApiError('aborted', 'Cancelled');
            }
        }
    };
    for (;;) {
        let page: RawMessage[];
        try {
            page = await readPage(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
        } catch (e) {
            // Some pages already came: keep them (the newest messages) and say where it stopped, instead of
            // throwing the whole channel away. Nothing read yet, or not a passing problem: the channel fails.
            if (read > 0 && transientDiscordError(e)) {
                stoppedEarly = { kind: e.kind, ...(e.status !== undefined ? { status: e.status } : {}) };
                truncated = true;
                break;
            }
            throw e;
        }
        if (page.length === 0) break;
        let stop = false;
        for (const raw of page) {
            const ts = typeof raw?.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
            const recent = Number.isFinite(ts) && ts >= cutoff;
            if (read >= min && !recent) { stop = true; truncated = true; break; }
            if (read >= max) { stop = true; truncated = true; ceilingHit = true; break; }
            read++;
            // One message Discord shaped in a way we did not expect costs that message, never the channel.
            let n: ImportMessage | null = null;
            try { n = normalizeMessage(raw, reg, channelId); } catch { unreadable++; }
            if (n) out.push(n);
        }
        if (stop || page.length < 100) break;
        const last: unknown = page[page.length - 1]?.id;
        if (!isSnowflake(last)) break;
        before = last;
        // At the ceiling on a page boundary: peek at ONE message to tell "the
        // rule wanted more" (ceiling) from "the channel simply ends here".
        if (read >= max) {
            let peek: RawMessage[] = [];
            try { peek = await client.getJson<RawMessage[]>(`/channels/${channelId}/messages?limit=1&before=${before}`, signal); } catch (e) {
                if (signal?.aborted || (e instanceof DiscordApiError && e.kind === 'aborted')) throw e;
                truncated = true; // the peek is only a nicety: assume there is more
            }
            const next = Array.isArray(peek) ? peek[0] : undefined;
            if (next) {
                truncated = true;
                const ts = typeof next.timestamp === 'string' ? Date.parse(next.timestamp) : NaN;
                ceilingHit = Number.isFinite(ts) && ts >= cutoff;
            }
            break;
        }
    }
    return { messages: out.reverse(), truncated, read, ceilingHit, unreadable, ...(stoppedEarly ? { stoppedEarly } : {}) };
}

/**
 * An empty first page is ambiguous: an empty channel, or one whose history the
 * bot may not read (Discord then answers `[]`, not an error). The channel's
 * `last_message_id` tells them apart: none, or one Discord no longer has (404)
 * = really empty; a message Discord shows (200) or refuses (403) = the history
 * exists but the list came back empty, which must be reported as a failure,
 * never as "0 messages" (that read as success in the report).
 */
export async function historyHiddenFromBot(client: DiscordClient, channelId: string, signal?: AbortSignal): Promise<boolean> {
    if (!isSnowflake(channelId)) throw new DiscordApiError('invalid_response', 'Bad channel id.');
    // The probe only ever ADDS a failure: if Discord will not describe the channel
    // (other than "Missing Access"), an empty list stays an empty channel.
    let ch: { last_message_id?: unknown } | null;
    try {
        ch = await client.getJson<{ last_message_id?: unknown }>(`/channels/${channelId}`, signal);
    } catch (e) {
        if (e instanceof DiscordApiError && e.kind === 'forbidden') return true;
        if (signal?.aborted || (e instanceof DiscordApiError && e.kind === 'aborted')) throw e;
        return false;
    }
    const last = ch?.last_message_id;
    if (!isSnowflake(last)) return false;
    try {
        await client.getJson(`/channels/${channelId}/messages/${last}`, signal);
        return true;
    } catch (e) {
        if (e instanceof DiscordApiError && e.kind === 'forbidden') return true;
        if (signal?.aborted || (e instanceof DiscordApiError && e.kind === 'aborted')) throw e;
        return false; // 404: the last message was deleted, the channel really is empty
    }
}

/**
 * Every pin of the channel, newest pin first (Discord's order). Tries the
 * paginated pins route, falls back to the older single-page one.
 */
export async function fetchChannelPins(client: DiscordClient, channelId: string, reg: MediaRegistry, signal?: AbortSignal): Promise<ImportMessage[]> {
    if (!isSnowflake(channelId)) throw new DiscordApiError('invalid_response', 'Bad channel id.');
    const out: ImportMessage[] = [];
    let raw: RawMessage[] = [];
    try {
        let before: string | null = null;
        for (let page = 0; page < 10 && raw.length < PINS_MAX; page++) {
            type PinsPage = { items?: Array<{ pinned_at?: unknown; message?: RawMessage }>; has_more?: unknown };
            const r: PinsPage = await client.getJson<PinsPage>(
                `/channels/${channelId}/messages/pins?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`, signal);
            const items: Array<{ pinned_at?: unknown; message?: RawMessage }> | null = Array.isArray(r?.items) ? r.items : null;
            if (!items) throw new DiscordApiError('not_found', 'no paginated pins');
            for (const it of items) if (it?.message) raw.push({ ...it.message, pinned: true });
            const last: unknown = items[items.length - 1]?.pinned_at;
            if (r.has_more !== true || typeof last !== 'string') break;
            before = last;
        }
    } catch (e) {
        if (!(e instanceof DiscordApiError) || (e.kind !== 'not_found' && e.kind !== 'invalid_response')) throw e;
        raw = [];
        const legacy = await client.getJson<RawMessage[]>(`/channels/${channelId}/pins`, signal);
        if (!Array.isArray(legacy)) throw new DiscordApiError('invalid_response', 'Discord sent something we could not read.');
        raw = legacy.map(m => ({ ...m, pinned: true }));
    }
    for (const m of raw.slice(0, PINS_MAX)) {
        const n = normalizeMessage(m, reg, channelId);
        if (n) out.push({ ...n, pinned: true });
    }
    return out;
}

const MAGIC: Array<[string, (b: Uint8Array) => boolean]> = [
    ['image/png', b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
    ['image/jpeg', b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
    ['image/gif', b => b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
    ['image/webp', b => b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
];

/**
 * Check magic bytes against the claimed type (plan B9). An image type whose
 * bytes are not that image becomes a generic download; nothing claimed as
 * HTML/SVG/script is ever kept as such.
 */
export function sniffMime(bytes: Uint8Array, claimed: string): string {
    const c = claimed.toLowerCase();
    const match = MAGIC.find(([, test]) => test(bytes));
    if (c.startsWith('image/')) return match && match[0] === c ? c : match ? match[0] : 'application/octet-stream';
    if (/html|svg|javascript|ecmascript|xml/.test(c)) return 'application/octet-stream';
    return c || 'application/octet-stream';
}

/**
 * When a signed Discord media URL stops working: its `ex` parameter (hex unix seconds). null when unsigned
 * (avatars, stickers) or unreadable.
 */
export function signedUrlExpiresAt(url: string): number | null {
    let ex: string | null = null;
    try { ex = new URL(url).searchParams.get('ex'); } catch { return null; }
    if (!ex || !/^[0-9a-f]{1,12}$/i.test(ex)) return null;
    return parseInt(ex, 16) * 1000;
}

/** A refresh is worth it this long before the signature runs out (a big file takes a while to download). */
const EXPIRY_MARGIN_MS = 5 * 60_000;

const rethrowAbort = (x: unknown): false => { if (x instanceof DiscordApiError && x.kind === 'aborted') throw x; return false; };

/**
 * Bytes for a registered ref. Signed attachment URLs expire about a day after Discord hands them out, and a
 * big channel can take longer than that to copy (or the person retries tomorrow): one that has run out (by its
 * `ex`, or Discord answering 403 / 404 / 410) is refreshed by re-reading its message, which carries a new
 * one (once per file). A download that was interrupted is tried once more.
 */
export async function fetchMediaByRef(
    client: DiscordClient, reg: MediaRegistry, ref: string, signal?: AbortSignal, now: () => number = Date.now,
): Promise<{ bytes: Uint8Array; mime: string }> {
    const e = reg.get(ref);
    if (!e) throw new DiscordApiError('not_found', 'Unknown file.');
    let refreshed = false;
    const refresh = async (): Promise<boolean> => {
        if (e.kind !== 'file' || !e.messageId || !e.attachmentId || refreshed) return false;
        refreshed = true;
        const fresh = await client.getJson<RawMessage>(`/channels/${e.channelId}/messages/${e.messageId}`, signal);
        const att = [...(fresh?.attachments ?? []), ...(fresh?.message_snapshots ?? []).flatMap(x => x?.message?.attachments ?? [])].find(a => a?.id === e.attachmentId);
        if (!att || typeof att.url !== 'string' || !checkMediaUrl(att.url)) return false;
        e.url = att.url;
        return true;
    };
    const exp = signedUrlExpiresAt(e.url);
    // Ran out already: ask Discord for a fresh address first instead of eating a 404 (the old one is tried anyway).
    if (exp !== null && exp - EXPIRY_MARGIN_MS <= now()) await refresh().catch(rethrowAbort);
    let retried = false;
    for (;;) {
        try {
            const r = await client.getMedia(e.url, e.max, signal);
            return { bytes: r.bytes, mime: r.contentType };
        } catch (err) {
            if (!(err instanceof DiscordApiError)) throw err;
            if (err.kind === 'not_found' && await refresh().catch(rethrowAbort)) continue;
            if ((err.kind === 'network' || err.kind === 'timeout') && !retried) { retried = true; continue; }
            throw err;
        }
    }
}
