/**
 * Structural checks on decrypted `ClientContent`, at the point it enters this
 * client — the DM pull loop and the two channel-message decode paths — and
 * again wherever a stored row is rendered by a component that reads typed
 * fields out of it.
 *
 * ## Why (2026-09-24, found by mobile's safety-number port)
 *
 * Decrypted content is whatever the sender's client chose to encrypt, and the
 * sender is not trusted. Nothing on desktop checked a variant's fields before a
 * component used them. `SafetyNumberEmbed` ran
 * `formatCode((code || '').toUpperCase())`, which throws on a number or an
 * object; the only boundary above it is the root error boundary, so any friend
 * could put the whole app on the error screen, every time that chat rendered,
 * by sending `{ type: 'safety_number', code: 42 }`.
 *
 * The same class of bug existed for every other variant (a numeric `text`
 * threw in the conversation list, an attachment without a string `filename`
 * in the file viewer), so every variant now has an allowlist schema: required
 * fields and their types, string length caps, finite numbers, bounded arrays.
 * Rejecting fields an older or newer client legitimately omits would turn a
 * real message into a placeholder, so no rule is stricter than what desktop
 * and mobile send (cipherline-mobile `src/features/messages/content.ts`).
 */

import { klipyGifProblem } from '@cipherline/shared';

/** utils/dmInbound.ts UNDECRYPTABLE_KIND (a test pins the two together). */
const UNDECRYPTABLE_KIND = 'undecryptable' as const;

/**
 * The longest message text this client will store or show. The composer caps
 * what WE send at MAX_TEXT_MESSAGE_LENGTH (100k); twice that leaves room for
 * any other client while keeping a crafted multi-megabyte body out of every
 * list, preview and search scan. Longer becomes a "couldn't be shown" row.
 */
export const MAX_RECEIVED_TEXT_LENGTH = 200_000;

/** Mobile rejects a code longer than this; a real code is 40 characters. */
export const SAFETY_NUMBER_CODE_MAX_LENGTH = 128;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Why a `safety_number` payload is unusable, or `null` when it is fine. */
export function safetyNumberProblem(c: Record<string, unknown>): string | null {
    if (!nonEmptyString(c.user_id)) return 'safety_number.user_id must be a non-empty string';
    if (!nonEmptyString(c.code)) return 'safety_number.code must be a non-empty string';
    if (c.code.length > SAFETY_NUMBER_CODE_MAX_LENGTH) return 'safety_number.code is too long';
    if (c.device_count !== undefined && c.device_count !== null
        && !(typeof c.device_count === 'number' && Number.isFinite(c.device_count))) {
        return 'safety_number.device_count must be a number';
    }
    return null;
}

// ── Per-variant schema (packages/shared/content.ts is the contract) ─────────
//
// Every variant a client sends today is listed, with the fields its renderers
// and handlers read. Rules are deliberately no stricter than what desktop and
// mobile actually send (cipherline-mobile src/features/messages/content.ts
// REQUIRED is the same floor): optional fields may be absent or null, unknown
// EXTRA fields are ignored, and caps sit far above any real value. What they
// stop is a sender-chosen shape a renderer would throw on (a numeric `text`,
// an attachment without a string `filename`), and unbounded sizes.

/** Ids, target ids, client_msg_id. Real ones are UUIDs or short derived ids. */
const ID_MAX = 256;
/** Base64 key / nonce material (32-byte keys are 44 characters). */
const B64_MAX = 512;
const FILENAME_MAX = 1024;
const MIME_MAX = 255;
/** A reaction is one emoji or a `<:name:id>` token (at most 196 characters). */
export const REACTION_EMOJI_MAX = 256;
const SHORT_STRING_MAX = 1024;
/** `mentions` / `channel_refs` entries (readers cap channel refs at 25). */
const LIST_MAX = 1000;

type Rec = Record<string, unknown>;
type Check = (c: Rec) => string | null;

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isId = (v: unknown): v is string => nonEmptyString(v) && v.length <= ID_MAX;
const isB64 = (v: unknown): v is string => nonEmptyString(v) && v.length <= B64_MAX;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const absent = (v: unknown) => v === undefined || v === null;
const optional = (v: unknown, ok: (x: unknown) => boolean) => absent(v) || ok(v);

/** Rules common to every variant. */
function commonProblem(c: Rec): string | null {
    if (!optional(c.client_msg_id, isId)) return 'client_msg_id must be a string id';
    if (!optional(c.reply_to_id, isId)) return 'reply_to_id must be a string id';
    return null;
}

function mentionsProblem(v: unknown): string | null {
    if (absent(v)) return null;
    if (!Array.isArray(v) || v.length > LIST_MAX) return 'mentions must be a bounded array';
    for (const m of v) {
        if (!isRecord(m) || typeof m.type !== 'string') return 'mentions entries must be objects with a type';
        if ((m.type === 'user' || m.type === 'role') && !isId(m.id)) return 'mentions entry needs an id';
    }
    return null;
}

/** Entries are validated by `sanitizeChannelRefs` where they are used. */
function channelRefsProblem(v: unknown): string | null {
    if (absent(v)) return null;
    return Array.isArray(v) && v.length <= LIST_MAX ? null : 'channel_refs must be a bounded array';
}

function textProblem(field: string, v: unknown): string | null {
    if (typeof v !== 'string') return `${field} must be a string`;
    if (v.length > MAX_RECEIVED_TEXT_LENGTH) return `${field} is too long`;
    return null;
}

const addRemove = (v: unknown) => v === 'add' || v === 'remove';

/**
 * A reaction's emoji becomes a KEY of the message's plain-object `reactions`
 * map at every apply site. `__proto__` there replaces that object's prototype
 * and `constructor` / `hasOwnProperty` / `toString` shadow methods other code
 * calls, so any name Object.prototype owns is refused. No emoji or
 * `<:name:id>` token is one of those names.
 */
export function isReservedObjectKey(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(Object.prototype, key) || key === '__proto__' || key === 'prototype';
}

const VARIANTS: Record<string, Check> = {
    text: c => textProblem('text.text', c.text) ?? mentionsProblem(c.mentions) ?? channelRefsProblem(c.channel_refs),
    attachment: c => {
        if (!isId(c.attachment_id)) return 'attachment.attachment_id must be a string id';
        if (!isStr(c.filename, FILENAME_MAX)) return 'attachment.filename must be a string';
        if (!isNum(c.byte_size) || c.byte_size < 0) return 'attachment.byte_size must be a non-negative number';
        if (!isStr(c.mime, MIME_MAX)) return 'attachment.mime must be a string';
        if (!isB64(c.file_key_b64)) return 'attachment.file_key_b64 must be a string';
        if (!isB64(c.file_nonce_b64)) return 'attachment.file_nonce_b64 must be a string';
        if (!optional(c.enc_alg, v => isStr(v, 64))) return 'attachment.enc_alg must be a string';
        if (!optional(c.chunk_size, v => isNum(v) && v >= 0)) return 'attachment.chunk_size must be a number';
        return null;
    },
    call_key: c => {
        if (!isId(c.call_id)) return 'call_key.call_id must be a string id';
        if (!isNum(c.epoch)) return 'call_key.epoch must be a number';
        if (!isB64(c.e2ee_key_b64)) return 'call_key.e2ee_key_b64 must be a string';
        if (!optional(c.key_id, v => isStr(v, ID_MAX))) return 'call_key.key_id must be a string';
        if (!optional(c.rotates_at, v => isStr(v, 64))) return 'call_key.rotates_at must be a string';
        if (!optional(c.sender_username, v => isStr(v, 128))) return 'call_key.sender_username must be a string';
        return null;
    },
    // A request for the call's media key (utils/callKeyShare.ts). Carries
    // nothing but the call id — it is a control message, never a chat row.
    call_key_request: c => (isId(c.call_id) ? null : 'call_key_request.call_id must be a string id'),
    call_event: c => {
        if (!isId(c.call_id)) return 'call_event.call_id must be a string id';
        if (!isStr(c.event, 64)) return 'call_event.event must be a string';
        if (!optional(c.user_id, isId)) return 'call_event.user_id must be a string id';
        return null;
    },
    edit: c => {
        if (!isId(c.target_id)) return 'edit.target_id must be a string id';
        return textProblem('edit.text', c.text) ?? channelRefsProblem(c.channel_refs);
    },
    delete: c => (isId(c.target_id) ? null : 'delete.target_id must be a string id'),
    reaction: c => {
        if (!isId(c.target_id)) return 'reaction.target_id must be a string id';
        if (!nonEmptyString(c.emoji) || c.emoji.length > REACTION_EMOJI_MAX) return 'reaction.emoji must be a short string';
        if (isReservedObjectKey(c.emoji)) return 'reaction.emoji is not an emoji';
        if (!addRemove(c.action)) return 'reaction.action must be add or remove';
        return null;
    },
    pin: c => {
        if (!isId(c.conversation_id)) return 'pin.conversation_id must be a string id';
        if (!isId(c.target_id)) return 'pin.target_id must be a string id';
        if (!addRemove(c.action)) return 'pin.action must be add or remove';
        if (!isNum(c.at)) return 'pin.at must be a number';
        return null;
    },
    profile_update: c => {
        if (!optional(c.user_id, isId)) return 'profile_update.user_id must be a string id';
        for (const f of ['avatar_attachment_id', 'banner_attachment_id']) {
            if (!optional(c[f], isId)) return `profile_update.${f} must be a string id`;
        }
        for (const f of ['avatar_file_key_b64', 'avatar_file_nonce_b64', 'banner_file_key_b64', 'banner_file_nonce_b64']) {
            if (!optional(c[f], isB64)) return `profile_update.${f} must be a string`;
        }
        return null;
    },
    group_update: c => {
        if (!isId(c.conversation_id)) return 'group_update.conversation_id must be a string id';
        if (!optional(c.title, v => isStr(v, SHORT_STRING_MAX))) return 'group_update.title must be a string';
        if (!optional(c.avatar_attachment_id, isId)) return 'group_update.avatar_attachment_id must be a string id';
        for (const f of ['avatar_file_key_b64', 'avatar_file_nonce_b64']) {
            if (!optional(c[f], isB64)) return `group_update.${f} must be a string`;
        }
        return null;
    },
    server_invite: c => (isId(c.code) ? null : 'server_invite.code must be a string'),
    // A KLIPY GIF names a URL the RECIPIENT's client will load, so it is held
    // to the full shared contract (exact KLIPY media-host allowlist, https,
    // dims, mime) — a bad one becomes a placeholder, never a request.
    klipy_gif: c => klipyGifProblem(c),
    safety_number: c => safetyNumberProblem(c),
    // Normally arrives on the key-handshake path, not as a message; if one
    // does come through the message pull it must still be well formed.
    channel_key: c => {
        if (!isId(c.channel_id)) return 'channel_key.channel_id must be a string id';
        if (!isNum(c.epoch)) return 'channel_key.epoch must be a number';
        if (!isB64(c.key_b64)) return 'channel_key.key_b64 must be a string';
        if (!optional(c.rotates_at, v => isStr(v, 64))) return 'channel_key.rotates_at must be a string';
        if (!optional(c.rotation_reason, v => isStr(v, 64))) return 'channel_key.rotation_reason must be a string';
        return null;
    },
};

// `system` is deliberately absent: it is drawn as an authoritative event pill
// and only this client may create one (see `storedSystemRowProblem`).
// `channel_message` describes a server row, never decrypted content.

/** Every content type this client accepts from another client. */
export const ACCEPTED_CONTENT_TYPES: readonly string[] = Object.freeze(Object.keys(VARIANTS));

/**
 * Why decrypted content cannot be shown, or `null` when it can. A non-null
 * answer means: store a "couldn't be shown" placeholder in its place.
 *
 * Applied where decrypted content enters this client: the DM pull loop and
 * the live and history channel decode paths (components/Dashboard.tsx). An
 * edit, delete or reaction travels through the same paths, so it is checked
 * before it touches a stored row. Never throws.
 *
 * A type not in the table (a variant from a newer client, or one that only
 * this client creates locally) is refused: the placeholder says a message
 * arrived, without rendering a shape this client does not know.
 */
export function contentProblem(content: unknown): string | null {
    if (!isRecord(content)) return 'content is not an object';
    if (typeof content.type !== 'string' || content.type === '') return 'content.type must be a string';
    if (!Object.prototype.hasOwnProperty.call(VARIANTS, content.type)) {
        return `content.type ${JSON.stringify(content.type.slice(0, 40))} is not accepted`;
    }
    try {
        return commonProblem(content) ?? VARIANTS[content.type](content);
    } catch {
        // Nothing JSON.parse produces can throw in here; the contract is
        // "never throws" all the same.
        return 'content could not be validated';
    }
}

// ── Stored rows ─────────────────────────────────────────────────────────────

/**
 * The variants a thread RENDERS as message content. A stored row is held to
 * these rules on load (see `sanitizeStoredThreads`); other stored types —
 * control rows an old build kept, local system rows, anything a newer build
 * wrote — are left exactly as they are.
 */
const RENDERED_VARIANTS = new Set(['text', 'attachment', 'klipy_gif', 'safety_number', 'server_invite']);

/**
 * Why a STORED row's content cannot be rendered, or null. Narrower than
 * `contentProblem`: rows were stored before these checks existed, so this
 * only rejects what a renderer would throw on (a non-object, a non-string
 * type, or a rendered variant with the wrong field types). No length cap:
 * that is a receive rule, and every scan over stored text is now linear.
 */
export function storedContentProblem(content: unknown): string | null {
    if (!isRecord(content)) return 'content is not an object';
    if (typeof content.type !== 'string' || content.type === '') return 'content.type must be a string';
    if (!RENDERED_VARIANTS.has(content.type)) return null;
    try {
        if (content.type === 'text' && typeof content.text !== 'string') return 'text.text must be a string';
        if (content.type === 'text') return mentionsProblem(content.mentions) ?? channelRefsProblem(content.channel_refs);
        return commonProblem(content) ?? VARIANTS[content.type](content);
    } catch {
        return 'content could not be validated';
    }
}

/**
 * `type: 'system'` rows are drawn as authoritative, centred event pills
 * ("X was banned by Y"), so only THIS client may create them. They come from:
 *
 *   - placeholders this client wrote for a message it could not decrypt or
 *     show (`kind` 'undecryptable' / 'encrypted'; fixed wording only);
 *   - server-authored member events (utils/systemMessages.ts: `kind`
 *     'member_event', built from the server's own row or event, never from
 *     ciphertext, stored with sender_user_id null and sender_device_id '');
 *   - the group "X added Y" line built from the server's `group:*` event
 *     (no `kind`, stored with sender_user_id '__system__').
 *
 * `contentProblem` refuses `system` from another client. A forged row stored
 * by a build from before that check carries the real sender's id, which none
 * of the local shapes above can, so it is recognised and replaced on load.
 */
export function storedSystemRowProblem(row: Record<string, unknown>): string | null {
    const c = row.content;
    if (!isRecord(c) || c.type !== 'system') return null;
    if (c.kind === UNDECRYPTABLE_KIND || c.kind === 'encrypted') return null;
    if (c.kind === 'member_event') {
        return row.sender_user_id === null && (row.sender_device_id === '' || row.sender_device_id === undefined)
            ? null : 'member_event row with a message sender';
    }
    if (c.kind === undefined || c.kind === null) {
        return row.sender_user_id === '__system__' ? null : 'system text row with a message sender';
    }
    return 'unknown system row kind';
}

/** The stand-in content for a row that cannot be shown (renders as "A message couldn't be shown"). */
export function unshowablePlaceholderContent(): { type: 'system'; kind: typeof UNDECRYPTABLE_KIND; data: { reason: 'malformed' } } {
    return { type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason: 'malformed' } };
}

/**
 * Loaded history with every row a renderer would throw on replaced by a
 * "couldn't be shown" row (same id, time and sender), and non-object rows
 * dropped. A thread with nothing to fix keeps its array identity, and so does
 * the map, so the store does not rewrite clean threads.
 */
export function sanitizeStoredThreads<M extends Record<string, unknown[]>>(map: M): M {
    let changedMap = false;
    const out: Record<string, unknown[]> = {};
    for (const [id, thread] of Object.entries(map)) {
        if (!Array.isArray(thread)) { changedMap = true; continue; }
        let next: unknown[] | null = null;
        for (let i = 0; i < thread.length; i++) {
            const row = thread[i];
            let replacement: unknown = row;
            if (!isRecord(row)) replacement = undefined;
            else if (storedContentProblem(row.content) !== null || storedSystemRowProblem(row) !== null) {
                replacement = { ...row, content: unshowablePlaceholderContent() };
            } else if (isRecord(row.reactions) && Object.keys(row.reactions).some(isReservedObjectKey)) {
                // Stored before reactions were checked: drop the reserved keys
                // (see isReservedObjectKey), keep every real reaction.
                replacement = {
                    ...row,
                    reactions: Object.fromEntries(Object.entries(row.reactions).filter(([k]) => !isReservedObjectKey(k))),
                };
            }
            if (replacement !== row) {
                next ??= thread.slice(0, i);
                if (replacement !== undefined) next.push(replacement);
            } else if (next) {
                next.push(row);
            }
        }
        out[id] = next ?? thread;
        if (next) changedMap = true;
    }
    return (changedMap ? out : map) as M;
}

/** What `SafetyNumberEmbed` renders from — only the fields it needs. */
export interface SafetyNumberCardData {
    claimedUserId: string;
    code: string;
    deviceCount?: number;
}

/**
 * Re-validate a stored row before the embed reads it. Rows stored before this
 * check existed never passed it, so the renderer must not trust them either.
 */
export function parseSafetyNumberContent(value: unknown): SafetyNumberCardData | null {
    if (!isRecord(value) || value.type !== 'safety_number') return null;
    if (safetyNumberProblem(value) !== null) return null;
    return {
        claimedUserId: value.user_id as string,
        code: value.code as string,
        deviceCount: typeof value.device_count === 'number' ? value.device_count : undefined,
    };
}
