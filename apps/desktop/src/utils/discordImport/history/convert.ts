/**
 * One Discord message -> the text of an imported Cipherline message (Discord
 * import phase 2; plan B6.4). Pure.
 *
 * Discord and Cipherline share the markdown (bold, italic, strike, code,
 * spoilers, quotes, headings, lists: utils/formatting/markdown.ts is the same
 * grammar), so text is kept as written except for Discord's TOKENS, which mean
 * nothing here and must never be read as Cipherline ones:
 *   <@id> <@!id>   -> "@Name" (plain text: an imported mention notifies NO ONE)
 *   <@&id>         -> a REAL role mention (`<@r:ROLE:name>` + a `mentions` entry)
 *                     when the import created that role, else "@Role name".
 *                     Still no ping: imported rows are never delivered live,
 *                     the viewer's own highlight and mention counters skip
 *                     import-marked rows, and the server never sees `mentions`
 *   <#id>          -> "#channel-name" + a `channel_refs` entry to the channel
 *                     the import created (a link), else plain "#channel-name"
 *   <:n:id> <a:n:id> -> this server's emoji of that name when the import brought
 *                     it over, else ":n:" (D2)
 *   <t:unix:fmt>   -> a written date
 *   @everyone / @here -> defused (a zero-width space after "@"): history is
 *                     never a ping, and the server forces mentions_everyone off
 *   anything else shaped like a token ("<@", "<#", "<:") -> defused, so text
 *                     a Discord user typed can never become a Cipherline
 *                     mention of a real account
 * Never HTML: the result is message text, rendered by the same sanitising
 * formatter as every live message.
 */
import type { ChannelRef, MentionEntry } from '@cipherline/shared';
import type { ImportMessage } from '../types';
import { formatDateTime } from '../../a11y/timeFormat';
import { mentionTokenLabel } from '../../mentionTokens';

export const ZWSP = '​';

export interface ConvertContext {
    roles: Record<string, string>;
    channels: Record<string, string>;
    /** Lower-cased emoji name -> this server's emoji id (imported in phase 1). */
    emojiIds?: Record<string, string>;
    /** Discord role id -> the Cipherline role the import created for it. */
    roleIds?: Record<string, string>;
    /** Discord channel id -> the Cipherline channel the import created for it. */
    channelIds?: Record<string, string>;
    /** Discord sticker id -> the server sticker the structure import created for it. */
    stickerRefs?: Record<string, { id: string; name: string }>;
}

/** What a converted text asks the row to carry besides the words. */
export interface ConvertSink { mentions: MentionEntry[]; channelRefs: ChannelRef[] }
/** Readers cap channel refs at 25 (contentValidation). */
const CHANNEL_REFS_MAX = 25;
const MENTIONS_MAX = 25;

const dateFmt = (unix: number, style: string): string => {
    const d = new Date(unix * 1000);
    if (!Number.isFinite(d.getTime())) return '';
    const opts: Intl.DateTimeFormatOptions =
        style === 't' ? { hour: 'numeric', minute: '2-digit' }
        : style === 'T' ? { hour: 'numeric', minute: '2-digit', second: '2-digit' }
        : style === 'd' ? { year: 'numeric', month: 'numeric', day: 'numeric' }
        : style === 'D' ? { year: 'numeric', month: 'long', day: 'numeric' }
        : { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    try { return formatDateTime(d, 'en-US', { ...opts, timeZone: 'UTC' }) + ' UTC'; } catch { return d.toISOString(); }
};

const safeName = (s: string) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);

/** Discord message text -> Cipherline message text (see the file header). */
export function convertDiscordText(text: string, m: Pick<ImportMessage, 'mentionNames'>, ctx: ConvertContext, sink?: ConvertSink): string {
    // Our own role tokens ride as placeholders through the defusing below, so text a
    // Discord user typed to look like one can never survive as a token.
    const roleTokens: string[] = [];
    let out = text.replace(/[\u0000\u0001]/g, '').replace(/<(@!?|@&|#)(\d{15,25})>|<(a?):([A-Za-z0-9_~]{1,64}):(\d{15,25})>|<t:(-?\d{1,13})(?::([tTdDfFR]))?>/g,
        (_all, kind: string | undefined, id: string | undefined, _anim: string | undefined, ename: string | undefined, _eid: string | undefined, unix: string | undefined, style: string | undefined) => {
            if (kind && id) {
                if (kind === '@&') {
                    const name = safeName(ctx.roles[id] ?? 'role');
                    const rid = ctx.roleIds?.[id];
                    if (rid && sink && /^[0-9a-f-]{36}$/i.test(rid) && sink.mentions.length < MENTIONS_MAX) {
                        if (!sink.mentions.some(x => x.type === 'role' && x.id === rid)) sink.mentions.push({ type: 'role', id: rid });
                        roleTokens.push(`<@r:${rid}:${mentionTokenLabel(name)}>`);
                        return `\u0001${roleTokens.length - 1}\u0001`;
                    }
                    return `@${name}`;
                }
                if (kind === '#') {
                    const name = safeName(ctx.channels[id] ?? 'channel');
                    const cid = ctx.channelIds?.[id];
                    // The reader links `#name` (at the start or after whitespace) by id; a name
                    // with a boundary character in it (space, punctuation) cannot be matched, so it stays text.
                    if (cid && sink && /^[0-9a-f-]{36}$/i.test(cid) && /^[^\s<>@'"!?.,;:)\]}]{1,100}$/u.test(name) && sink.channelRefs.length < CHANNEL_REFS_MAX) {
                        if (!sink.channelRefs.some(x => x.id === cid)) sink.channelRefs.push({ id: cid, name });
                    }
                    return `#${name}`;
                }
                return `@${safeName(m.mentionNames[id] ?? 'someone')}`;
            }
            if (ename) {
                const local = ctx.emojiIds?.[ename.toLowerCase()];
                return local ? `<:${ename}:${local}>` : `:${ename}:`;
            }
            if (unix) return dateFmt(Number(unix), style ?? 'f');
            return '';
        });
    // Defuse anything left that a reader could take for a token or a ping.
    // (Our own emoji tokens from the replacement above are re-protected below.)
    const keep: string[] = [];
    out = out.replace(/<:[A-Za-z0-9_~]{1,64}:[0-9a-f-]{36}>/g, t => { keep.push(t); return `\u0000${keep.length - 1}\u0000`; });
    out = out
        .replace(/<(?=[@#:]|a:)/g, `<${ZWSP}`)
        .replace(/@(everyone|here)\b/gi, `@${ZWSP}$1`);
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => keep[Number(i)] ?? '');
    out = out.replace(/\u0001(\d+)\u0001/g, (_, i: string) => roleTokens[Number(i)] ?? '');
    return out;
}

const quote = (s: string) => s.split('\n').map(l => `> ${l}`).join('\n');

/** The full text of the imported message: the words, then embeds / poll / sticker / notes. */
export function importedMessageText(m: ImportMessage, ctx: ConvertContext, notes: string[], replyMissing: boolean, sink?: ConvertSink): string {
    const parts: string[] = [];
    if (replyMissing) parts.push('-# Replying to a message that was not imported');
    if (m.content.trim()) parts.push(convertDiscordText(m.content, m, ctx, sink));
    // A forward. Cipherline has no forward display, so it reads as a quoted block under
    // a small heading; the original's files and embeds follow as this message's own.
    if (m.forwarded) {
        const body = m.forwarded.content.trim() ? convertDiscordText(m.forwarded.content, m, ctx, sink) : '';
        const when = m.forwarded.ts ? ` (originally ${formatDateTime(new Date(m.forwarded.ts), 'en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })})` : '';
        parts.push(`-# Forwarded message${when}`);
        if (body) parts.push(quote(body));
    }
    for (const e of m.embeds) {
        const lines: string[] = [];
        if (e.author) lines.push(`-# ${convertDiscordText(e.author, m, ctx, sink)}`);
        if (e.title) lines.push(e.url && /^https:\/\//.test(e.url) ? `**[${e.title.replace(/[[\]]/g, '')}](${e.url})**` : `**${convertDiscordText(e.title, m, ctx, sink)}**`);
        if (e.description) lines.push(convertDiscordText(e.description, m, ctx, sink));
        for (const f of e.fields) lines.push(`**${convertDiscordText(f.name, m, ctx, sink)}**: ${convertDiscordText(f.value, m, ctx, sink)}`);
        if (e.footer) lines.push(`-# ${convertDiscordText(e.footer, m, ctx, sink)}`);
        if (!e.title && !e.description && !e.fields.length && e.url) lines.push(e.url);
        if (lines.length) parts.push(quote(lines.join('\n')));
    }
    if (m.poll) {
        const total = m.poll.answers.reduce((t, a) => t + a.votes, 0);
        parts.push([`**Poll: ${convertDiscordText(m.poll.question, m, ctx, sink)}**`,
            ...m.poll.answers.map(a => `- ${convertDiscordText(a.text, m, ctx, sink)}: ${a.votes} vote${a.votes === 1 ? '' : 's'}`),
            `-# ${total} vote${total === 1 ? '' : 's'} in total`].join('\n'));
    }
    for (const st of m.stickers) parts.push(`-# Sticker: ${safeName(st)}`);
    for (const n of notes) parts.push(`-# ${n}`);
    return parts.join('\n');
}

/** Human size for the "not imported" notes. */
export function sizeLabel(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

/**
 * Posting order for one channel (plan B4.2): pins OLDER than the window
 * first, oldest to newest, then the window's messages in order; a pin inside
 * the window is posted once, at its own place.
 */
export function postingOrder(windowMsgs: ImportMessage[], pins: ImportMessage[]): ImportMessage[] {
    const inWindow = new Set(windowMsgs.map(m => m.id));
    const pinnedIds = new Set(pins.map(p => p.id));
    const olderPins = pins.filter(p => !inWindow.has(p.id)).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return [...olderPins, ...windowMsgs.map(m => (pinnedIds.has(m.id) ? { ...m, pinned: true } : m))];
}
