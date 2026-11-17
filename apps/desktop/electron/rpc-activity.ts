/**
 * Local Rich Presence — SET_ACTIVITY validation (pure, no I/O).
 *
 * Whatever a local process sends in a SET_ACTIVITY is untrusted input. It is
 * reduced here to a fixed, whitelisted shape before anything else sees it:
 *
 *   details / state / name   string, 1..128 chars after trim (over 128 is
 *                            refused, as Discord refuses it — not truncated)
 *   timestamps.start / end   finite numbers; seconds are promoted to ms; 0 or
 *                            a value outside ±MAX_TIMESTAMP_SKEW_MS of now is
 *                            dropped (meaningless, not malformed)
 *   party.size               [current, max] non-negative integers, current ≤
 *                            max ≤ MAX_PARTY; `party.id` is DROPPED
 *   assets                   image keys or https URLs + hover texts, kept as
 *                            DATA ONLY — the main process never fetches them,
 *                            and they are not forwarded to the renderer
 *   instance                 boolean
 *
 * Stripped entirely and never stored: `buttons` (arbitrary URLs a local app
 * would have us show), `secrets` (join / spectate / match secrets — these are
 * invite capabilities and must never be stored or shared), `party.id`, and any
 * key not listed above. A known key with the wrong TYPE refuses the whole
 * activity (the client gets an error reply): malformed input is rejected, never
 * coerced.
 */

export const RPC_TEXT_MAX = 128;
export const RPC_IMAGE_MAX = 256;
export const MAX_PARTY = 1_000_000;
/** Timestamps further than this from now are dropped. */
export const MAX_TIMESTAMP_SKEW_MS = 30 * 24 * 60 * 60 * 1000;
/** Below this a timestamp is taken to be in seconds (1e11 ms ≈ 1973). */
const SECONDS_THRESHOLD = 1e11;

export interface RpcAssets {
    largeImage: string | null;
    largeText: string | null;
    smallImage: string | null;
    smallText: string | null;
}

export interface RpcActivityFields {
    name: string | null;
    details: string | null;
    state: string | null;
    /** Epoch ms. */
    start: number | null;
    /** Epoch ms. */
    end: number | null;
    party: { size: number; max: number } | null;
    /** Data only. Never fetched; never leaves the main process. */
    assets: RpcAssets | null;
    instance: boolean;
}

export type SanitizeResult =
    | { ok: true; activity: RpcActivityFields | null }
    | { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

class Refuse extends Error {}

/** undefined/null → null; empty after trim → null; non-string or too long → refuse. */
function text(v: unknown, field: string, max = RPC_TEXT_MAX): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new Refuse(`${field} must be a string`);
    // eslint-disable-next-line no-control-regex -- strip C0/C1 controls (newlines, bidi tricks stay out of one-line UI)
    const s = v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim();
    if (!s) return null;
    if (s.length > max) throw new Refuse(`${field} must be ${max} or fewer characters`);
    return s;
}

function timestamp(v: unknown, field: string, now: number): number | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Refuse(`${field} must be a number`);
    if (v <= 0) return null;
    const ms = v < SECONDS_THRESHOLD ? Math.round(v * 1000) : Math.round(v);
    if (Math.abs(ms - now) > MAX_TIMESTAMP_SKEW_MS) return null;
    return ms;
}

const IMAGE_KEY_RE = /^[A-Za-z0-9_.:/-]{1,256}$/;

/** An image key ("map_oregon", "mp:external/...") or an https URL. Anything else is dropped (null). */
export function imageRef(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s.length > RPC_IMAGE_MAX) return null;
    if (/^https:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
            return u.toString().length <= RPC_IMAGE_MAX ? u.toString() : null;
        } catch {
            return null;
        }
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // any other scheme with an authority
    return IMAGE_KEY_RE.test(s) ? s : null;
}

function party(v: unknown): { size: number; max: number } | null {
    if (v === undefined || v === null) return null;
    if (!isPlainObject(v)) throw new Refuse('party must be an object');
    // party.id is deliberately not read.
    const size = v.size;
    if (size === undefined || size === null) return null;
    if (!Array.isArray(size) || size.length !== 2) throw new Refuse('party.size must be [current, max]');
    const [cur, max] = size;
    if (!Number.isInteger(cur) || !Number.isInteger(max)) throw new Refuse('party.size must be integers');
    if ((cur as number) < 0 || (max as number) < 1 || (cur as number) > (max as number) || (max as number) > MAX_PARTY) {
        throw new Refuse('party.size out of range');
    }
    return { size: cur as number, max: max as number };
}

function assets(v: unknown): RpcAssets | null {
    if (v === undefined || v === null) return null;
    if (!isPlainObject(v)) throw new Refuse('assets must be an object');
    const a: RpcAssets = {
        largeImage: imageRef(v.large_image),
        largeText: text(v.large_text, 'assets.large_text'),
        smallImage: imageRef(v.small_image),
        smallText: text(v.small_text, 'assets.small_text'),
    };
    return a.largeImage || a.largeText || a.smallImage || a.smallText ? a : null;
}

/** Validate a SET_ACTIVITY `args.activity`. null / undefined = clear. */
export function sanitizeActivity(raw: unknown, now: number): SanitizeResult {
    if (raw === undefined || raw === null) return { ok: true, activity: null };
    if (!isPlainObject(raw)) return { ok: false, error: 'activity must be an object' };
    try {
        let ts: { start: number | null; end: number | null } = { start: null, end: null };
        if (raw.timestamps !== undefined && raw.timestamps !== null) {
            if (!isPlainObject(raw.timestamps)) throw new Refuse('timestamps must be an object');
            ts = {
                start: timestamp(raw.timestamps.start, 'timestamps.start', now),
                end: timestamp(raw.timestamps.end, 'timestamps.end', now),
            };
        }
        if (raw.instance !== undefined && raw.instance !== null && typeof raw.instance !== 'boolean') {
            throw new Refuse('instance must be a boolean');
        }
        const activity: RpcActivityFields = {
            name: text(raw.name, 'name'),
            details: text(raw.details, 'details'),
            state: text(raw.state, 'state'),
            start: ts.start,
            end: ts.end,
            party: party(raw.party),
            assets: assets(raw.assets),
            instance: raw.instance === true,
        };
        // raw.buttons / raw.secrets / anything else: intentionally never read.
        return { ok: true, activity };
    } catch (e) {
        if (e instanceof Refuse) return { ok: false, error: e.message };
        throw e;
    }
}

/** Discord client ids are snowflakes: 15-21 decimal digits. */
export const CLIENT_ID_RE = /^\d{15,21}$/;
export const isClientId = (v: unknown): v is string => typeof v === 'string' && CLIENT_ID_RE.test(v);

/** A process id from SET_ACTIVITY args, or null. */
export function pidOf(v: unknown): number | null {
    return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 0x7fffffff ? v : null;
}

/** What one connection is announcing, ready for the game pipeline. */
export interface RpcPresence extends RpcActivityFields {
    clientId: string;
    pid: number | null;
    /** Epoch ms this activity was last set. */
    at: number;
}

/**
 * The display title for an RPC activity, or null = ignore it. Never a raw id.
 *   1. the bundled application-id map (rpc-app-names.ts);
 *   2. what this computer's game detection calls the sending process (by pid);
 *   3. the activity's own `name`;
 *   4. its `details` line.
 */
export function rpcTitle(
    p: Pick<RpcPresence, 'clientId' | 'name' | 'details'>,
    lookups: { appName: (clientId: string) => string | null; processGame?: string | null },
): { title: string; from: 'map' | 'process' | 'name' | 'details' } | null {
    const mapped = lookups.appName(p.clientId);
    if (mapped) return { title: mapped, from: 'map' };
    if (lookups.processGame) return { title: lookups.processGame, from: 'process' };
    if (p.name) return { title: p.name, from: 'name' };
    if (p.details) return { title: p.details, from: 'details' };
    return null;
}

/** Case/punctuation-insensitive key for comparing game names across sources. */
export function gameNameKey(name: string): string {
    return name
        .replace(/[\u2122\u00ae\u00a9]/g, '') // TM, (R), (C) — before NFKD turns TM into "TM"
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}
