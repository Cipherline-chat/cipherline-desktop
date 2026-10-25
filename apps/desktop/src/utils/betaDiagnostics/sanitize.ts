/**
 * Beta diagnostics — the privacy gate for every event before it is queued.
 *
 * Contract rules enforced here (the server enforces them again):
 *   - `detail`: ≤ 12 keys, keys /^[a-z0-9_]{1,32}$/, values number | boolean |
 *     a string matching /^[A-Za-z0-9_.:-]{0,64}$/. Anything else is DROPPED
 *     (never coerced into shape). Numbers are rounded to 2 decimals; non-finite
 *     numbers are dropped.
 *   - additionally, a detail string that LOOKS like an identifier (UUID, long
 *     hex, LiveKit SID) is dropped even though it matches the pattern: detail
 *     values are code-chosen enums and measurements, never ids. That is the
 *     second line of defence behind "callers only pass enums".
 *   - `message`: through the existing diagnostics scrubber (utils/diagnostics/
 *     scrub.ts — paths, URLs, e-mails, ids, IPs, tokens, caller names), then
 *     ≤ 300 chars.
 *   - fingerprints: sha256 over `kind` + normalized top stack frames (function
 *     name + file BASENAME:line — no directories, so no user name in a path) or,
 *     for non-error events, `kind` + the detail's string values (enums only —
 *     numbers would split identical failures into separate buckets).
 */
import { createScrubber, type Scrubber } from '../diagnostics/scrub';
import type { BetaDetail, BetaEventKind } from './types';

export const MAX_DETAIL_KEYS = 12;
export const DETAIL_KEY_RE = /^[a-z0-9_]{1,32}$/;
export const DETAIL_STRING_RE = /^[A-Za-z0-9_.:-]{0,64}$/;
export const MAX_MESSAGE = 300;

const UUID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const HEX_RUN_RE = /[0-9a-f]{20,}/i;
const SID_RE = /^(?:PA|TR|RM|PS|SS|EG|IN|DP|AG|SIP|ST|EP)_[A-Za-z0-9]{6,}$/;

/** A detail string that is shaped like an id rather than an enum. */
export function looksLikeIdentifier(v: string): boolean {
    return UUID_RE.test(v) || HEX_RUN_RE.test(v) || SID_RE.test(v);
}

/**
 * Names this app holds (usernames, display names, server / channel names —
 * the same list the report scrubber uses), lower-cased. A detail string equal
 * to one of them is dropped: an enum can't be told from a name by shape alone
 * (`alice.wonder` matches the detail pattern), so this is the last line behind
 * "callers only pass code-chosen enums". Lossy on purpose — a friend called
 * "video" costs the value `video`, never the other way round.
 */
let sensitive: ReadonlySet<string> = new Set();
export function setBetaSensitiveTerms(terms: readonly string[]): void {
    sensitive = new Set(terms.filter(t => typeof t === 'string' && t.length >= 3).map(t => t.toLowerCase()));
}

/** Apply the contract's detail rules. Returns undefined when nothing survives. */
export function sanitizeDetail(detail: Record<string, unknown> | null | undefined): BetaDetail | undefined {
    if (!detail || typeof detail !== 'object') return undefined;
    const out: BetaDetail = {};
    let n = 0;
    for (const [k, v] of Object.entries(detail)) {
        if (n >= MAX_DETAIL_KEYS) break;
        if (!DETAIL_KEY_RE.test(k)) continue;
        if (typeof v === 'number') {
            if (!Number.isFinite(v)) continue;
            out[k] = Math.round(v * 100) / 100;
        } else if (typeof v === 'boolean') {
            out[k] = v;
        } else if (typeof v === 'string') {
            if (!DETAIL_STRING_RE.test(v) || looksLikeIdentifier(v) || sensitive.has(v.toLowerCase())) continue;
            out[k] = v;
        } else {
            continue;
        }
        n++;
    }
    return n > 0 ? out : undefined;
}

/** Turn any value into a detail-safe enum string, or undefined. */
export function enumish(v: unknown, max = 48): string | undefined {
    if (typeof v !== 'string' && typeof v !== 'number') return undefined;
    const s = String(v).replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
    if (!s || looksLikeIdentifier(s)) return undefined;
    return s;
}

/** HTTP status of an axios-shaped error, if any. */
export function httpStatusOf(err: unknown): number | undefined {
    const s = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status;
    return typeof s === 'number' && Number.isFinite(s) ? s : undefined;
}

/** `[E2EE:CODE]` prefix of an error message, when the engine set one. */
export function e2eeCodeOf(err: unknown): string | undefined {
    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    const m = /\[E2EE:([A-Z_]{1,40})\]/.exec(msg);
    return m ? m[1] : undefined;
}

/** DOMException / Error name, when it is a plain identifier (TypeError, NotAllowedError…). */
export function errorNameOf(err: unknown): string | undefined {
    const n = (err as { name?: unknown } | null | undefined)?.name;
    return typeof n === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(n) ? n : undefined;
}

/** ChatPane's send failure → msg_send_failed detail. */
export function sendFailureDetail(err: unknown, scope: 'dm' | 'channel'): Record<string, unknown> {
    const status = httpStatusOf(err);
    const code = e2eeCodeOf(err);
    const msg = err instanceof Error ? err.message : String(err ?? '');
    const axCode = (err as { code?: unknown } | null)?.code;
    let stage: string;
    if (status !== undefined) stage = 'post';
    else if (axCode === 'ECONNABORTED' || axCode === 'ETIMEDOUT' || /timeout/i.test(msg)) stage = 'timeout';
    else if (/network|ECONN|Failed to fetch/i.test(msg)) stage = 'network';
    else if (/No channel key|Channel key for epoch/.test(msg)) stage = 'no_channel_key';
    else stage = 'prepare';
    return { scope, stage, ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}), ...(errorNameOf(err) ? { name: errorNameOf(err) } : {}) };
}

// ── messages ───────────────────────────────────────────────────────────────

let scrubber: Scrubber = createScrubber({ maxLength: MAX_MESSAGE });

/** Install the scrubber that carries the signed-in user's names (rebuilt by the host). */
export function setBetaScrubber(s: Scrubber | null): void {
    scrubber = s ?? createScrubber({ maxLength: MAX_MESSAGE });
}

export function scrubMessage(input: unknown): string {
    const s = scrubber.text(input, MAX_MESSAGE);
    return s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE) : s;
}

// ── fingerprints ───────────────────────────────────────────────────────────

/**
 * Normalized top frames of a stack: `fn@basename:line`, at most 3. The file
 * part keeps only the BASENAME (never a directory — a home directory carries
 * the OS user name) and the line; columns are dropped (they move with every
 * build of a minified bundle without meaning a different bug).
 */
export function normalizeFrames(stack: unknown, max = 3): string[] {
    if (typeof stack !== 'string' || !stack) return [];
    const out: string[] = [];
    for (const raw of stack.split(/\r?\n/)) {
        if (out.length >= max) break;
        const line = raw.trim();
        // V8: "at fn (file:line:col)" or "at file:line:col"; Firefox-style "fn@file:line:col".
        const m = /^at\s+(?:(.+?)\s+\()?(.+?):(\d+)(?::\d+)?\)?$/.exec(line) ?? /^(.*?)@(.+?):(\d+)(?::\d+)?$/.exec(line);
        if (!m) continue;
        const fn = (m[1] ?? '').replace(/^async\s+/, '').split(/\s+/)[0];
        const file = m[2].replace(/[?#].*$/, '').split(/[\\/]/).pop() ?? '';
        const safeFn = /^[A-Za-z_$][\w$.<>]{0,63}$/.test(fn) ? fn : 'anon';
        const safeFile = /^[\w.-]{1,80}$/.test(file) ? file : 'file';
        out.push(`${safeFn}@${safeFile}:${m[3]}`);
    }
    return out;
}

/** What the fingerprint is computed over (kept in memory for dedupe; hashed at flush). */
export function fingerprintSource(kind: BetaEventKind, o: { frames?: readonly string[]; errorName?: string; detail?: BetaDetail }): string {
    if (o.frames && o.frames.length) return `${kind}|${o.errorName ?? ''}|${o.frames.join('|')}`;
    const enums = o.detail
        ? Object.keys(o.detail).sort().filter(k => typeof o.detail![k] === 'string' || typeof o.detail![k] === 'boolean').map(k => `${k}=${String(o.detail![k])}`)
        : [];
    return `${kind}|${o.errorName ?? ''}|${enums.join(',')}`;
}

/** sha256 → lowercase hex (64 chars). WebCrypto, so async. */
export async function sha256Hex(s: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('no WebCrypto');
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

/** A v4 UUID for session_id / call_summary_id. */
export function newUuid(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
