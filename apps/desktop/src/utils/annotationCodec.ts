/**
 * annotationCodec — the wire schema for in-call annotations, and the strict
 * decoder every receiver applies before a byte of it touches the store.
 *
 * Transport confidentiality is the SDK's data-channel E2EE (see
 * docs/video-annotation-design.md → Transport); this layer is about SHAPE and
 * BINDING. Two rules govern it:
 *
 *   1. Authorship is never taken from the payload. Live stroke messages carry
 *      no `by`: the receiver stamps the SFU-attested sender identity that
 *      arrived with the packet. Only a `snapshot` (relayed by the streamer on
 *      behalf of everyone) carries `by` per stroke, and the receiver trusts it
 *      only because the snapshot itself came from the streamer.
 *   2. Every message is bound to a `room` and a `track`. A receiver rejects
 *      anything whose `room` is not the room it is in, so a packet cannot be
 *      replayed into a different call by a peer that holds the key.
 *
 * Limits here are the same ones annotationStore enforces locally, so local
 * and remote data can never differ in shape.
 */
import { isValidWirePoint, type Point } from './annotationGeometry';

export const ANNOT_TOPIC = 'annot';
/**
 * The only tool there is. Kept as an explicit field on the wire rather than
 * dropped with the pen it used to distinguish, for two reasons:
 *
 *   - a client built before the laser-only change still decodes our strokes
 *     (it accepts 'laser'), so a mid-rollout call degrades to "we can both
 *     still see each other's lasers" rather than silence; and
 *   - its pen strokes are refused by us, because 'pen' is no longer a value
 *     this decoder accepts — exactly the right outcome, since we have nowhere
 *     to put a mark that never expires.
 */
export const WIRE_TOOL = 'laser';
export type WireTool = typeof WIRE_TOOL;
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_APPEND_POINTS = 64;
export const MAX_IDENTITIES = 64;
const MAX_IDENTITY_LEN = 128;
const MAX_TRACK_LEN = 192;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A finished-or-not stroke as it travels inside a snapshot. */
export interface WireStroke {
    id: string;
    by: string;
    tool: WireTool;
    color: string;
    width: number;
    points: Point[];
    done: boolean;
}

interface Bound { room: string; track: string }

export type AnnotMsg =
    | (Bound & { t: 'stroke.begin'; id: string; tool: WireTool; color: string; width: number; p: Point })
    | (Bound & { t: 'stroke.append'; id: string; pts: Point[] })
    | (Bound & { t: 'stroke.end'; id: string })
    | (Bound & { t: 'grant.request' })
    | (Bound & { t: 'grant.grant' | 'grant.deny' | 'grant.revoke'; identity: string })
    | (Bound & { t: 'grant.list'; identities: string[] })
    | (Bound & { t: 'snapshot.request' })
    /** Chunked: `part` of `of`; identities ride only on part 0. */
    | (Bound & { t: 'snapshot'; seq: number; part: number; of: number; strokes: WireStroke[]; identities?: string[] });

export type AnnotMsgType = AnnotMsg['t'];

// No 'clear' and no 'stroke.undo': with the laser as the only tool there is
// no mark to erase — every stroke retires itself. A message of either type
// from an older peer falls through to `null` and is dropped, which is the
// same nothing it would have achieved.
const TYPES: ReadonlySet<string> = new Set<AnnotMsgType>([
    'stroke.begin', 'stroke.append', 'stroke.end',
    'grant.request', 'grant.grant', 'grant.deny', 'grant.revoke', 'grant.list',
    'snapshot.request', 'snapshot',
]);

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encode(msg: AnnotMsg): Uint8Array {
    const bytes = enc.encode(JSON.stringify(msg));
    if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
        throw new Error(`annotation payload ${bytes.byteLength}B exceeds ${MAX_PAYLOAD_BYTES}B — chunk it`);
    }
    return bytes;
}

// ── validators ───────────────────────────────────────────────────────────
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const isTool = (v: unknown): v is WireTool => v === WIRE_TOOL;
const isColor = (v: unknown): v is string => typeof v === 'string' && COLOR_RE.test(v);
const isWidth = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 24;
/** Identities are concrete participant identities — never a wildcard, never
 *  empty. There is no room-wide grant in this protocol, by decision. */
const isIdentity = (v: unknown): v is string => isStr(v, MAX_IDENTITY_LEN) && v !== '*' && v.trim() === v;
const isIdentities = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length <= MAX_IDENTITIES && v.every(isIdentity) && new Set(v).size === v.length;
const isPoints = (v: unknown, max: number): v is Point[] =>
    Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(isValidWirePoint);

function isWireStroke(v: unknown): v is WireStroke {
    if (!v || typeof v !== 'object') return false;
    const s = v as Record<string, unknown>;
    return isId(s.id) && isIdentity(s.by) && isTool(s.tool) && isColor(s.color) && isWidth(s.width)
        && isPoints(s.points, 5000) && typeof s.done === 'boolean'
        && Object.keys(s).length === 7;
}

/**
 * Decode and validate one packet. Returns null for anything malformed,
 * unknown, out of bounds, or bound to a different room — receivers drop
 * silently; a peer that sends garbage learns nothing from us.
 */
export function decode(bytes: Uint8Array, expectRoom: string): AnnotMsg | null {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_PAYLOAD_BYTES) return null;
    let raw: unknown;
    try { raw = JSON.parse(dec.decode(bytes)); } catch { return null; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.t !== 'string' || !TYPES.has(m.t)) return null;
    if (m.room !== expectRoom) return null;
    if (!isStr(m.track, MAX_TRACK_LEN) || !m.track.includes('|')) return null;

    const base = { room: expectRoom, track: m.track };
    // Switch on a variable, not a cast expression: control-flow narrowing then
    // types `t` as exactly the literals of each case block, so the returned
    // objects are valid union members without a second cast.
    const t = m.t as AnnotMsgType;
    switch (t) {
        case 'stroke.begin':
            if (!isId(m.id) || !isTool(m.tool) || !isColor(m.color) || !isWidth(m.width) || !isValidWirePoint(m.p)) return null;
            return { ...base, t: 'stroke.begin', id: m.id, tool: m.tool, color: m.color, width: m.width, p: { x: m.p.x, y: m.p.y } };
        case 'stroke.append':
            if (!isId(m.id) || !isPoints(m.pts, MAX_APPEND_POINTS)) return null;
            return { ...base, t: 'stroke.append', id: m.id, pts: m.pts.map(p => ({ x: p.x, y: p.y })) };
        case 'stroke.end':
            if (!isId(m.id)) return null;
            return { ...base, t, id: m.id };
        case 'grant.request':
        case 'snapshot.request':
            return { ...base, t };
        case 'grant.grant':
        case 'grant.deny':
        case 'grant.revoke':
            if (!isIdentity(m.identity)) return null;
            return { ...base, t, identity: m.identity };
        case 'grant.list':
            if (!isIdentities(m.identities)) return null;
            return { ...base, t: 'grant.list', identities: [...m.identities] };
        case 'snapshot': {
            const seq = m.seq, part = m.part, of = m.of;
            if (![seq, part, of].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0)) return null;
            if ((of as number) < 1 || (part as number) >= (of as number)) return null;
            if (!Array.isArray(m.strokes) || !m.strokes.every(isWireStroke)) return null;
            if (m.identities !== undefined && ((part as number) !== 0 || !isIdentities(m.identities))) return null;
            return {
                ...base, t: 'snapshot', seq: seq as number, part: part as number, of: of as number,
                strokes: (m.strokes as WireStroke[]).map(s => ({ ...s, points: s.points.map(p => ({ x: p.x, y: p.y })) })),
                ...(m.identities !== undefined ? { identities: [...(m.identities as string[])] } : {}),
            };
        }
        default:
            return null;
    }
}

/**
 * Split a track's full state into `snapshot` messages that each fit the
 * payload cap. Strokes are never split across parts; a single stroke too
 * large for one part on its own is truncated to what fits (a late joiner
 * losing the tail of one 5000-point scribble beats losing the snapshot).
 */
export function chunkSnapshot(
    room: string, track: string, seq: number, strokes: WireStroke[], identities: string[],
    maxBytes: number = MAX_PAYLOAD_BYTES,
): Extract<AnnotMsg, { t: 'snapshot' }>[] {
    const size = (m: unknown) => enc.encode(JSON.stringify(m)).byteLength;
    const parts: WireStroke[][] = [];
    let cur: WireStroke[] = [];
    const frame = (list: WireStroke[], part: number, withIds: boolean) => ({
        t: 'snapshot' as const, room, track, seq, part, of: 1, strokes: list, ...(withIds ? { identities } : {}),
    });
    for (const s of strokes) {
        const trial = [...cur, s];
        if (size(frame(trial, parts.length, parts.length === 0)) <= maxBytes) { cur = trial; continue; }
        if (cur.length) { parts.push(cur); cur = []; }
        // Does it fit alone? If not, truncate its points until it does.
        let alone = { ...s };
        while (size(frame([alone], parts.length, parts.length === 0)) > maxBytes && alone.points.length > 1) {
            alone = { ...alone, points: alone.points.slice(0, Math.max(1, Math.floor(alone.points.length * 0.7))) };
        }
        cur = [alone];
    }
    if (cur.length || parts.length === 0) parts.push(cur);
    const of = parts.length;
    return parts.map((list, i) => ({ ...frame(list, i, i === 0), of }));
}
