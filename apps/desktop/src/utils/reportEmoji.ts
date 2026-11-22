/**
 * Custom emoji in a reported message, as report evidence.
 *
 * A message carries a custom emoji as `<:name:ID>` (utils/mentionTokens):
 *   - SERVER emoji: ID is the server_emojis UUID. Its image is on Cipherline's
 *     storage, so the API copies it into the report itself when the report is
 *     filed (apps/api ReportEvidenceService.snapshotServerEmojis). This client
 *     sends nothing extra for it.
 *   - PERSONAL emoji ("My Emojis"): ID is `p_` + 32 hex of SHA-256(bytes)
 *     (utils/personalEmoji/token.ts). Its bytes only ever travelled inside the
 *     end-to-end encrypted message, so only a device that received it has
 *     them. The REPORTER's device uploads the image it holds, after the report
 *     exists (POST /v1/reports/:id/emoji). The API refuses any image whose hash
 *     is not the ID, so a reporter cannot swap the picture; when the message
 *     VERIFIED (franking covers the text, and so the ID), the image is as
 *     trustworthy as the text.
 *
 * Privacy: only emoji that are in the reported message (and still in the text
 * being sent) are included - never anything else from the library - and the
 * bytes go only to Cipherline's report endpoint, never to a third party.
 */
import axios from 'axios';
import { apiUrl } from './apiPath';
import { findMentionTokens, parseMentionToken } from './mentionTokens';
import {
    PERSONAL_BLOB_MAX_BYTES, PERSONAL_EMOJI_MAX_PER_MESSAGE, isPersonalEmojiId, personalEmojiIdFromBytes, sniffImageMime,
} from './personalEmoji/token';

/** Personal emoji images one report carries (= the API's REPORT_PERSONAL_EMOJI_MAX). */
export const REPORT_PERSONAL_EMOJI_MAX = PERSONAL_EMOJI_MAX_PER_MESSAGE;
/** Each image (= the API's REPORT_EMOJI_MAX_INPUT_BYTES): the personal-STICKER cap, since a
 *  sticker message reports through this same path as a `<:name:id>` token (utils/stickers/wire.ts). */
export const REPORT_PERSONAL_EMOJI_MAX_BYTES = PERSONAL_BLOB_MAX_BYTES;
/** All personal emoji images of one report together. */
export const REPORT_PERSONAL_EMOJI_TOTAL_MAX_BYTES = 1024 * 1024;

const SERVER_EMOJI_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReportEmojiSource = 'server' | 'personal';
export interface ReportEmojiToken { name: string; id: string; source: ReportEmojiSource }

/** Custom-emoji tokens in `text`, in order, de-duplicated by id. Other `<:...>` shapes are ignored. */
export function reportEmojiTokens(text: unknown): ReportEmojiToken[] {
    if (typeof text !== 'string' || !text.includes('<:')) return [];
    const out: ReportEmojiToken[] = [];
    const seen = new Set<string>();
    for (const m of findMentionTokens(text, 'emoji')) {
        const p = parseMentionToken(m[0]);
        if (p?.kind !== 'emoji' || !p.id) continue;
        const id = p.id.toLowerCase();
        const source: ReportEmojiSource | null = isPersonalEmojiId(id) ? 'personal' : SERVER_EMOJI_ID_RE.test(id) ? 'server' : null;
        if (!source || seen.has(id)) continue;
        seen.add(id);
        out.push({ name: p.label, id, source });
    }
    return out;
}

/**
 * The emoji a report may include: those in the text being SENT that are also
 * in the reported MESSAGE. A reporter who edits an emoji out of an unverified
 * excerpt does not send it; one typed into the excerpt that the message never
 * had is not included either.
 */
export function reportableEmojiTokens(sentText: unknown, messageText: unknown): ReportEmojiToken[] {
    const inMessage = new Set(reportEmojiTokens(messageText).map(t => t.id));
    return reportEmojiTokens(sentText).filter(t => inMessage.has(t.id));
}

export interface PersonalEmojiEvidence {
    id: string;
    name: string;
    mime: string;
    bytes: Uint8Array;
}

export type PersonalEmojiMissing = 'not_on_device' | 'too_large' | 'over_limit';

export interface PersonalEmojiCollection {
    included: PersonalEmojiEvidence[];
    missing: { id: string; name: string; reason: PersonalEmojiMissing }[];
}

/** The slice of the personal-emoji store this needs (the real one is `personalEmojis().store`). */
export interface EmojiBytesReader {
    read(id: string): Promise<Uint8Array | null>;
}

/**
 * The images of the reported message's personal emoji that this device holds,
 * within the caps. Each one is re-checked against its id (the store already
 * validated it on receipt; this keeps a corrupt cache from producing an upload
 * the API would refuse anyway).
 */
export async function collectPersonalEmojiEvidence(tokens: ReportEmojiToken[], store: EmojiBytesReader): Promise<PersonalEmojiCollection> {
    const out: PersonalEmojiCollection = { included: [], missing: [] };
    let total = 0;
    for (const t of tokens) {
        if (t.source !== 'personal') continue;
        if (out.included.length >= REPORT_PERSONAL_EMOJI_MAX) { out.missing.push({ id: t.id, name: t.name, reason: 'over_limit' }); continue; }
        let bytes: Uint8Array | null = null;
        try { bytes = await store.read(t.id); } catch { bytes = null; }
        const mime = bytes ? sniffImageMime(bytes) : null;
        if (!bytes || !mime || (await personalEmojiIdFromBytes(bytes)) !== t.id) {
            out.missing.push({ id: t.id, name: t.name, reason: 'not_on_device' });
            continue;
        }
        if (bytes.length > REPORT_PERSONAL_EMOJI_MAX_BYTES) { out.missing.push({ id: t.id, name: t.name, reason: 'too_large' }); continue; }
        if (total + bytes.length > REPORT_PERSONAL_EMOJI_TOTAL_MAX_BYTES) { out.missing.push({ id: t.id, name: t.name, reason: 'over_limit' }); continue; }
        total += bytes.length;
        out.included.push({ id: t.id, name: t.name, mime, bytes });
    }
    return out;
}

/** Upload one personal emoji image to a report the caller just filed. Resolves true on success, never throws. */
export async function uploadReportPersonalEmoji(args: { reportId: string; emoji: PersonalEmojiEvidence; token: string }): Promise<boolean> {
    try {
        await axios.post(
            apiUrl`/reports/${args.reportId}/emoji?emoji_id=${args.emoji.id}&emoji_name=${args.emoji.name}`,
            new Blob([args.emoji.bytes as BlobPart], { type: args.emoji.mime }),
            { headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': args.emoji.mime } },
        );
        return true;
    } catch {
        return false;
    }
}
