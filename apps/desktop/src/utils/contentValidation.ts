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
 * This validates deliberately little: that content is an object with a string
 * `type`, and the fields of variants whose renderer would otherwise throw on a
 * bad shape. Rejecting fields an older or newer client legitimately omits would
 * turn a real message into a placeholder, so each rule mirrors mobile's
 * (cipherline-mobile `src/features/messages/content.ts`) rather than adding to it.
 */

import { klipyGifProblem } from '@cipherline/shared';

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

/**
 * Why decrypted content cannot be shown, or `null` when it can. A non-null
 * answer means: store a "couldn't be shown" placeholder in its place.
 */
export function contentProblem(content: unknown): string | null {
    if (!isRecord(content)) return 'content is not an object';
    if (typeof content.type !== 'string' || content.type === '') return 'content.type must be a string';
    if (content.type === 'safety_number') return safetyNumberProblem(content);
    // A KLIPY GIF names a URL the RECIPIENT's client will load, so it is held
    // to the full shared contract (exact KLIPY media-host allowlist, https,
    // dims, mime) — a bad one becomes a placeholder, never a request.
    if (content.type === 'klipy_gif') return klipyGifProblem(content);
    return null;
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
