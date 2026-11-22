/**
 * Importing message history from another app (today: a Discord server the
 * admin runs, with the admin's OWN bot). Plan: docs/plans/discord-import.md
 * (Part B, B4–B6). Shared by the API (caps, validation) and every reader
 * client (the anti-impersonation rendering rules, B6.2).
 *
 * The model, in one paragraph:
 *   - imported messages are ORDINARY channel messages: encrypted on the
 *     importer's device with the channel's normal sender key, signed by the
 *     importer's device, 30-day expiry from the import, normal 14-day file
 *     cleanup. The server never sees content, names or avatars;
 *   - the server MARKS every row it inserted through the import batch endpoint
 *     (`import_id`, `import_author_id`), and nothing else can carry a mark;
 *   - the content of such a row carries an `imported_from` block naming the
 *     original author (name, avatar, original time). A reader shows that
 *     author ONLY when the row is marked AND the block's `author_ref` equals
 *     the mark (`verifiedImportedFrom`). Anything else renders as its real
 *     sender: there is no visible "imported" label, so the mark is the control.
 *
 * Pure TypeScript: no I/O, no DOM, no Node.
 */

// ── Wire limits (the API enforces them; clients pace themselves by them) ──

/** Rows in one POST .../imports/:iid/messages. */
export const IMPORT_BATCH_MAX_ROWS = 100;
/** Request body ceiling for the batch route (bytes). */
export const IMPORT_BATCH_MAX_BODY_BYTES = 1024 * 1024;
/** Authors in one POST .../imports/:iid/authors. */
export const IMPORT_AUTHORS_MAX_PER_CALL = 500;
/** Files in one POST .../imports/:iid/attachments/initiate. */
export const IMPORT_ATTACH_MAX_PER_CALL = 50;
/** Items in one POST .../imports/:iid/save. */
export const IMPORT_SAVE_MAX_ITEMS = 500;
/** Channels one session may name. */
export const IMPORT_MAX_CHANNELS = 500;

/**
 * Per-import caps (plan B4.4, owner default D21). A Discord message with files
 * becomes several rows (the text, then one row per file), so the per-channel
 * cap counts ROWS and leaves room for the channel ceiling plus files and pins.
 *
 * The window rule (owner, 2026-11-22; floor lowered from 5,000 to 1,000 on
 * 2026-11-22 "only import 1k messages instead of the 5k"): per channel, copy
 * the LARGER of "the last 1,000 messages" and "every message from the last 30
 * days (counted from the import)", up to a safety ceiling of 25,000 messages
 * per channel. Why
 * 25,000: at the import batch rate (importPost 30 / 10 s x 100 rows = 300
 * rows/s) a full channel posts in ~1.5 min and reads from Discord (100 per
 * request) in ~250 requests; a 50,000-message month would be ~3 min of posting
 * but ~500 MB of ciphertext toward the 500 MB per-import cap on its own, and
 * a 20-channel server of such channels would run past an hour. The per-import
 * row cap (250,000) still bounds the whole import.
 */
export const IMPORT_CAPS = {
    /** The floor of the window rule: at least the last 1,000 messages per channel. */
    messagesPerChannelWindow: 1000,
    /** The time part of the window rule: every message from the last 30 days (from import time). */
    windowDays: 30,
    /** Safety ceiling: never more than this many messages from one channel. */
    messagesPerChannelCeiling: 25_000,
    /** Rows the server accepts per channel per import (ceiling + files + pins). */
    rowsPerChannel: 60_000,
    /** Rows the server accepts per import. */
    rowsPerImport: 250_000,
    /** Message ciphertext (base64 chars) per import. */
    ciphertextBytesPerImport: 500 * 1024 * 1024,
    /** Attachment bytes per import, by the IMPORTER's plan. */
    attachmentBytesFree: 5 * 1024 * 1024 * 1024,
    attachmentBytesPaid: 50 * 1024 * 1024 * 1024,
    /** Imports that posted something, per server per 30 days. */
    importsPerServerPer30Days: 3,
    /** An active session nobody posted to for this long is expired. */
    sessionIdleHours: 72,
    /** Anti-abuse gate (D11). */
    accountMinAgeDays: 7,
} as const;

/** Version of the consent text the importer accepted (stored on the session). */
export const IMPORT_CONSENT_VERSION = '2026-11-21';

export const IMPORT_SOURCES = ['discord'] as const;
export type ImportSource = typeof IMPORT_SOURCES[number];

/** `user` authors may be claimed later (phase 3); webhooks and apps never. */
export const IMPORT_AUTHOR_KINDS = ['user', 'webhook', 'app'] as const;
export type ImportAuthorKind = typeof IMPORT_AUTHOR_KINDS[number];

export const IMPORT_SESSION_STATUSES = ['active', 'complete', 'cancelled', 'expired'] as const;
export type ImportSessionStatus = typeof IMPORT_SESSION_STATUSES[number];

// ── The content block ─────────────────────────────────────────────────────

export const IMPORTED_NAME_MAX_GRAPHEMES = 80;
export const IMPORTED_USERNAME_MAX = 40;
const IMPORTED_AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** The original author's picture: an ordinary E2EE attachment in this channel. */
export interface ImportedAvatar {
    attachment_id: string;
    file_key_b64: string;
    file_nonce_b64: string;
    mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

/**
 * Lives INSIDE the encrypted content of an imported `text` or `attachment`
 * message (`ClientContent.imported_from`). The server never sees it.
 */
export interface ImportedFrom {
    v: 1;
    source: ImportSource;
    /** Must equal the row's server-side `import_author_id`. */
    author_ref: string;
    kind: ImportAuthorKind;
    /** The display name on the source app. */
    name: string;
    /** The source app's handle ("alex_92"), shown only to disambiguate (D18). */
    username?: string;
    avatar?: ImportedAvatar;
    /** When it was originally sent (ISO 8601). Displayed (D17); never used for retention. */
    original_ts: string;
    /** It had been edited on the source app. */
    edited?: true;
    /**
     * Reactions it had on the source app (owner 2026-11-22: "there's no reason
     * we cannot import reactions"). Inside the encrypted content like every
     * other part of the block: the server never sees emoji or who reacted.
     * Each reactor is named by `ref`, an `import_author_id` of THIS import
     * (the Discord id is only ever a keyed hash server-side, D27), plus the
     * name to show while nobody has claimed them. Readers honour a reactor
     * only on a verified block (rules 1-3) AND only when `ref` is an author
     * of the import that marked the row (GET .../imports/:iid/author-claims);
     * a claimed reactor shows as the claimant. History, never a ping.
     */
    reactions?: ImportedReaction[];
}

/** Reactions per imported message (Discord allows 20 distinct emoji). */
export const IMPORTED_REACTIONS_MAX = 20;
/** Named reactors per reaction: Discord's first page (one request per emoji). */
export const IMPORTED_REACTORS_MAX = 100;
/** Longest emoji string (an emoji, or a `<:name:id>` token; same as a live reaction). */
export const IMPORTED_REACTION_EMOJI_MAX = 256;

export interface ImportedReactor {
    /** An `import_author_id` of the same import. */
    ref: string;
    name: string;
}

export interface ImportedReaction {
    /** A unicode emoji, this server's `<:name:id>` token, or `:name:` text for an emoji it does not have. */
    emoji: string;
    /** Discord's total for this emoji (>= reactors.length: only the first 100 are named). */
    count: number;
    reactors: ImportedReactor[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const USERNAME_RE = /^[a-z0-9_.]{1,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const KNOWN_KEYS = new Set(['v', 'source', 'author_ref', 'kind', 'name', 'username', 'avatar', 'original_ts', 'edited', 'reactions']);
const REACTION_KEYS = new Set(['emoji', 'count', 'reactors']);
const REACTOR_KEYS = new Set(['ref', 'name']);
/** A reaction emoji becomes an object KEY in readers' `reactions` maps: never a name Object.prototype owns. */
const RESERVED_KEYS = new Set(Object.getOwnPropertyNames(Object.prototype));
const AVATAR_KEYS = new Set(['attachment_id', 'file_key_b64', 'file_nonce_b64', 'mime']);

/** Characters that are never shown in a name (controls, format, separators). */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A display name from another app, made safe to show: no hidden characters, collapsed spaces, clipped. */
export function cleanImportedName(raw: string): string {
    const cleaned = raw.normalize('NFC').replace(/[\t\n\r\v\f]+/g, ' ').replace(HIDDEN, '').replace(/\s+/g, ' ').trim();
    const g = Array.from(cleaned);
    return g.slice(0, IMPORTED_NAME_MAX_GRAPHEMES).join('');
}

/**
 * Strictly parse an `imported_from` block. Reject, never coerce (plan B9):
 * any unknown key, wrong type or out-of-range value makes the WHOLE block
 * invalid, and an invalid block means "render as the real sender".
 */
export function parseImportedFrom(raw: unknown): ImportedFrom | null {
    if (!isRecord(raw)) return null;
    for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) return null;
    if (raw.v !== 1) return null;
    if (raw.source !== 'discord') return null;
    if (typeof raw.author_ref !== 'string' || !UUID_RE.test(raw.author_ref)) return null;
    if (typeof raw.kind !== 'string' || !(IMPORT_AUTHOR_KINDS as readonly string[]).includes(raw.kind)) return null;
    if (typeof raw.name !== 'string') return null;
    const name = cleanImportedName(raw.name);
    if (name.length === 0) return null;
    if (typeof raw.original_ts !== 'string' || raw.original_ts.length > 40) return null;
    const ts = Date.parse(raw.original_ts);
    if (!Number.isFinite(ts)) return null;
    const out: ImportedFrom = {
        v: 1, source: 'discord', author_ref: raw.author_ref.toLowerCase(),
        kind: raw.kind as ImportAuthorKind, name, original_ts: new Date(ts).toISOString(),
    };
    if (raw.username !== undefined) {
        if (typeof raw.username !== 'string' || !USERNAME_RE.test(raw.username)) return null;
        out.username = raw.username;
    }
    if (raw.edited !== undefined) {
        if (raw.edited !== true) return null;
        out.edited = true;
    }
    if (raw.reactions !== undefined) {
        const list = parseImportedReactions(raw.reactions);
        if (!list) return null;
        if (list.length) out.reactions = list;
    }
    if (raw.avatar !== undefined) {
        const a = raw.avatar;
        if (!isRecord(a)) return null;
        for (const k of Object.keys(a)) if (!AVATAR_KEYS.has(k)) return null;
        if (typeof a.attachment_id !== 'string' || !UUID_RE.test(a.attachment_id)) return null;
        if (typeof a.file_key_b64 !== 'string' || a.file_key_b64.length > 64 || !B64_RE.test(a.file_key_b64)) return null;
        if (typeof a.file_nonce_b64 !== 'string' || a.file_nonce_b64.length > 64 || !B64_RE.test(a.file_nonce_b64)) return null;
        if (typeof a.mime !== 'string' || !IMPORTED_AVATAR_MIMES.has(a.mime)) return null;
        out.avatar = {
            attachment_id: a.attachment_id.toLowerCase(), file_key_b64: a.file_key_b64,
            file_nonce_b64: a.file_nonce_b64, mime: a.mime as ImportedAvatar['mime'],
        };
    }
    return out;
}

/**
 * Strict parse of `imported_from.reactions` (reject, never coerce: any bad
 * entry invalidates the whole block). Duplicate emoji or duplicate reactors
 * in one reaction are refused, never merged.
 */
export function parseImportedReactions(raw: unknown): ImportedReaction[] | null {
    if (!Array.isArray(raw) || raw.length > IMPORTED_REACTIONS_MAX) return null;
    const out: ImportedReaction[] = [];
    const emojis = new Set<string>();
    for (const r of raw) {
        if (!isRecord(r)) return null;
        for (const k of Object.keys(r)) if (!REACTION_KEYS.has(k)) return null;
        if (typeof r.emoji !== 'string' || r.emoji.length === 0 || r.emoji.length > IMPORTED_REACTION_EMOJI_MAX) return null;
        if (RESERVED_KEYS.has(r.emoji) || HIDDEN_ONLY.test(r.emoji) || emojis.has(r.emoji)) return null;
        emojis.add(r.emoji);
        if (!Array.isArray(r.reactors) || r.reactors.length > IMPORTED_REACTORS_MAX) return null;
        if (typeof r.count !== 'number' || !Number.isSafeInteger(r.count) || r.count < 1 || r.count > 10_000_000) return null;
        if (r.count < r.reactors.length) return null;
        const reactors: ImportedReactor[] = [];
        const refs = new Set<string>();
        for (const x of r.reactors) {
            if (!isRecord(x)) return null;
            for (const k of Object.keys(x)) if (!REACTOR_KEYS.has(k)) return null;
            if (typeof x.ref !== 'string' || !UUID_RE.test(x.ref)) return null;
            const ref = x.ref.toLowerCase();
            if (refs.has(ref)) return null;
            refs.add(ref);
            if (typeof x.name !== 'string') return null;
            const name = cleanImportedName(x.name);
            if (!name) return null;
            reactors.push({ ref, name });
        }
        out.push({ emoji: r.emoji, count: r.count, reactors });
    }
    return out;
}

const HIDDEN_ONLY = /^[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u;

/**
 * What the SERVER says about a channel row. Only rows inserted by the import
 * batch endpoint carry `import_id` + `import_author_id`; `claimed_user_id` is
 * the phase-3 seam (a Discord-verified claim) and is always null today.
 */
export interface ImportMark {
    import_id: string;
    import_author_id: string;
    claimed_user_id?: string | null;
}

/** Read the server's mark off a raw API row, strictly (UUIDs or nothing). */
export function importMarkOf(row: unknown): ImportMark | null {
    if (!isRecord(row)) return null;
    const id = row.import_id;
    const author = row.import_author_id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    if (typeof author !== 'string' || !UUID_RE.test(author)) return null;
    const claimed = row.import_claimed_user_id;
    return {
        import_id: id.toLowerCase(),
        import_author_id: author.toLowerCase(),
        claimed_user_id: typeof claimed === 'string' && UUID_RE.test(claimed) ? claimed.toLowerCase() : null,
    };
}

/**
 * Rendering rules 1–3 (plan B6.2): the alternate author applies ONLY when the
 * server marked the row AND the decrypted block is valid AND its `author_ref`
 * equals the mark. Every other case (a normal message whose content claims an
 * author, a mismatched or malformed block, a mark with no block) returns null:
 * render the row as its real sender.
 */
export function verifiedImportedFrom(content: unknown, mark: ImportMark | null | undefined): ImportedFrom | null {
    if (!mark) return null;
    if (!isRecord(content)) return null;
    if (content.type !== 'text' && content.type !== 'attachment') return null;
    const block = parseImportedFrom(content.imported_from);
    if (!block) return null;
    return block.author_ref === mark.import_author_id.toLowerCase() ? block : null;
}

/**
 * Ingest gate (the `gateCardStyleByFlag` pattern): keep `imported_from` only
 * when it is verified against the row's mark, and replace it with its parsed,
 * cleaned form; otherwise DROP it so nothing downstream can ever read an
 * unverified block.
 */
export function gateImportedFrom<T>(content: T, mark: ImportMark | null | undefined): T {
    if (!isRecord(content) || !Object.prototype.hasOwnProperty.call(content, 'imported_from')) return content;
    const ok = verifiedImportedFrom(content, mark);
    const { imported_from: _dropped, ...rest } = content as Record<string, unknown>;
    return (ok ? { ...rest, imported_from: ok } : rest) as T;
}

// ── Name collisions (rule 6, D18) ─────────────────────────────────────────

/**
 * A few Latin look-alikes from Cyrillic and Greek, plus digit/letter swaps.
 * Not a full Unicode confusables table: enough that "Аlex" (Cyrillic А) or
 * "al3x" do not slip past a member called Alex. The comparison is only used to
 * ADD a disambiguator, so a false positive costs a muted "@handle", never more.
 */
const CONFUSABLES: Record<string, string> = {
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c',
    'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w',
    'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't',
    'υ': 'u', 'χ': 'x', 'ϲ': 'c',
    '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '|': 'l', '!': 'i', '$': 's', '@': 'a',
    'ı': 'i', 'ł': 'l', 'ø': 'o', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'đ': 'd', 'ħ': 'h',
};

/**
 * Fold a name for the collision check: compatibility-normalise, strip marks
 * and hidden characters, lower-case, map look-alikes, drop everything that is
 * not a letter or digit ("A l e x", "a.l.e.x" and "ALEX" all fold to "alex").
 */
export function foldNameForCollision(name: string): string {
    const base = name.normalize('NFKD').replace(/\p{M}/gu, '').replace(HIDDEN, '').toLowerCase();
    let out = '';
    for (const ch of base) out += CONFUSABLES[ch] ?? ch;
    return out.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Does an unclaimed imported author's name collide with a CURRENT member's
 * display name or username? `memberNames` is every member's nickname,
 * display name and username, as the reader's own device knows them now (so a
 * member who joins later with the same name triggers it too).
 */
export function importedNameCollides(importedName: string, memberNames: Iterable<string | null | undefined>): boolean {
    const f = foldNameForCollision(importedName);
    if (!f) return false;
    for (const n of memberNames) {
        if (typeof n === 'string' && n && foldNameForCollision(n) === f) return true;
    }
    return false;
}

/**
 * The header text for an unclaimed imported author: the name, plus the
 * source handle in muted text ONLY on a collision (D18). `suffix` is null
 * when no disambiguator is needed or none is available.
 */
export function importedAuthorLabel(block: ImportedFrom, collides: boolean): { name: string; suffix: string | null } {
    if (!collides) return { name: block.name, suffix: null };
    return { name: block.name, suffix: block.username ? `@${block.username}` : null };
}
