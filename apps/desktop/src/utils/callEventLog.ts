/**
 * Call event log — a privacy-safe, in-memory record of the decisions the
 * call stack makes (codec, layers, capture, focus switches, freezes, ICE
 * route, offers…), so "it was laggy / blurry / froze" can be explained after
 * the fact. The stream-stats overlay shows the tail and can copy it; the
 * issue reporter reads getCallEvents().
 *
 * Privacy rules (enforced by callEventLog.test.ts, which scans every call
 * site's detail keys against an allowlist):
 *   - memory only: never written to disk, never sent anywhere by this module;
 *   - cleared on sign-out (AuthContext) — and bounded: the last
 *     MAX_EVENTS events / MAX_AGE_MS;
 *   - detail values are short scalars (codec names, layer names, sizes, fps,
 *     bitrates, reason enums, counts, booleans) — NEVER identities, SIDs,
 *     names, device labels, room names or anything user-typed;
 *   - tracks are referred to by placeholder (`self-camera`, `self-screen`,
 *     `remote-video-1`, `remote-screen-1` …), stable for one call: the map
 *     from the real track key to the placeholder lives only here, in memory,
 *     and is dropped when the call ends.
 *
 * Entry shape is a contract with the issue reporter (claude/issue-reporter-
 * callevents, `call_events`) and the admin dashboard — keep it EXACTLY:
 *   { t: number, kind: string, detail?: Record<string, string | number | boolean> }
 *   - t: epoch milliseconds (Date.now()); the reporter makes it report-relative;
 *   - kind: /^[a-z][a-z0-9_]{0,39}$/, from CALL_EVENT_KINDS;
 *   - detail: ≤ 12 keys matching /^[a-z][a-z0-9_]{0,31}$/; values boolean,
 *     finite number, or a 1–64 char string; nothing nested, no null;
 *   - conventions: quality-limit events carry `to` in cpu|bandwidth|other|none;
 *     codec fallbacks carry `from` + `to`; ICE events carry `type`
 *     (host|srflx|prflx|relay) and `turn`; freeze kinds contain "freeze";
 *     H.265 kinds contain "h265";
 *   - track references: self-camera, self-screen, self-screen-audio, self-mic
 *     (optional -N) or remote-video-N — nothing else;
 *   - reserved keys `kind`, `source`, `quality_limitation_reason` are not used.
 * validateCallEvent() checks all of it; sanitising enforces what it can.
 */

export const CALL_EVENT_KINDS = [
    'call_join', 'call_leave', 'participants', 'ice_route', 'reconnecting', 'reconnected',
    'camera_capture', 'camera_codec', 'camera_start_check', 'camera_fallback', 'camera_ladder',
    'camera_layering', 'camera_tier', 'camera_encoder_stall',
    'share_codec', 'share_start_check', 'share_fallback', 'share_low_layer', 'share_picker',
    // A share start: stage timings (codec probe, acquire + publish), or the
    // DOMException type when it failed (SidebarConference.startScreenShareFrom).
    'share_start',
    'dynacast_layers', 'quality_limitation', 'freeze_start', 'freeze_end',
    'focus_upgrade', 'focus_switched',
    'incoming_mode', 'decode_cap',
    'load_trigger', 'offer_shown', 'offer_answer',
    'h265_caps', 'h265_switch',
    // E2EE frame health (utils/e2eeAnnexB.ts, CallEventMonitor): counts and a
    // reason enum only — a viewer's decrypt failures, a sender's rewritten
    // 3-byte start codes.
    'e2ee_annexb', 'e2ee_decrypt_error',
    // A DATA packet (annotations, reactions…) failed to decrypt/encrypt in the
    // E2EE worker — livekit-client drops those silently (e2eeWorkerStats.ts).
    'e2ee_data_error',
    // Annotations: the desktop overlay was shown / refused, with a reason enum
    // (desktopAnnotationOverlay.ts); inbound annotation packets dropped before
    // they reached the store, with a reason enum (useAnnotationTransport.ts).
    'annot_overlay', 'annot_rx_drop',
    // A/V sync (avSyncMonitor.ts, SidebarConference's share-audio ring). Was a
    // separate stand-in log (avSyncLog.ts) with dotted kinds; folded in here.
    'av_sync_offset', 'av_sync_estimate', 'av_sync_playback_path', 'av_sync_webaudio_latency', 'av_sync_ss_audio_trim',
] as const;
export type CallEventKind = (typeof CALL_EVENT_KINDS)[number];

export type CallEventDetail = Record<string, string | number | boolean>;
export interface CallEvent { t: number; kind: string; detail?: CallEventDetail }

export const MAX_EVENTS = 500;
export const MAX_AGE_MS = 30 * 60 * 1000;
export const COALESCE_MS = 2000;
/** Kinds whose repeats within COALESCE_MS replace the previous entry (latest detail wins, `repeat` counts). */
const NOISY: ReadonlySet<string> = new Set(['dynacast_layers', 'quality_limitation', 'participants', 'decode_cap', 'focus_upgrade', 'e2ee_decrypt_error', 'e2ee_data_error', 'annot_rx_drop']);

const MAX_STR = 64;
const MAX_KEYS = 12;
const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED = new Set(['kind', 'source', 'quality_limitation_reason']);

interface Rec { abs: number; ev: CallEvent }
let buf: Rec[] = [];
let placeholders = new Map<string, string>();
const counters = new Map<string, number>();
const listeners = new Set<() => void>();

function nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function sanitize(detail: CallEventDetail | undefined): CallEventDetail | undefined {
    if (!detail) return undefined;
    const out: CallEventDetail = {};
    let n = 0;
    for (const [k, v] of Object.entries(detail)) {
        if (n >= MAX_KEYS - 1) break; // one slot kept for `repeat`
        if (!KEY_RE.test(k) || RESERVED.has(k)) continue;
        if (typeof v === 'number') { if (!Number.isFinite(v)) continue; out[k] = Math.round(v * 100) / 100; }
        else if (typeof v === 'boolean') out[k] = v;
        else if (typeof v === 'string') { if (v.length === 0) continue; out[k] = v.slice(0, MAX_STR); }
        else continue;
        n++;
    }
    return n ? out : undefined;
}

const TRACK_RE = /^(self-camera|self-screen|self-screen-audio|self-mic)(-\d+)?$|^remote-video-\d+$/;
const QLR = new Set(['cpu', 'bandwidth', 'other', 'none']);
const ICE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);

/** Every rule of the contract; returns the list of violations (empty = valid). */
export function validateCallEvent(e: CallEvent): string[] {
    const bad: string[] = [];
    if (!Number.isFinite(e.t) || e.t < 1e12) bad.push('t is not epoch ms');
    if (!KIND_RE.test(e.kind)) bad.push(`kind ${e.kind}`);
    if (!(CALL_EVENT_KINDS as readonly string[]).includes(e.kind)) bad.push(`unknown kind ${e.kind}`);
    const keys = Object.keys(e).filter(k => k !== 't' && k !== 'kind' && k !== 'detail');
    if (keys.length) bad.push(`extra fields ${keys.join(',')}`);
    if (e.detail !== undefined) {
        const entries = Object.entries(e.detail);
        if (entries.length === 0 || entries.length > MAX_KEYS) bad.push('detail key count');
        for (const [k, v] of entries) {
            if (!KEY_RE.test(k)) bad.push(`key ${k}`);
            if (RESERVED.has(k)) bad.push(`reserved key ${k}`);
            const ok = typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length >= 1 && v.length <= MAX_STR);
            if (!ok) bad.push(`value of ${k}`);
            if (k === 'track' && (typeof v !== 'string' || !TRACK_RE.test(v))) bad.push(`track ref ${String(v)}`);
        }
        if (e.kind === 'quality_limitation' && !QLR.has(String(e.detail.to))) bad.push('quality_limitation.to');
        if (/fallback/.test(e.kind) && (e.detail.from === undefined || e.detail.to === undefined)) bad.push('fallback from/to');
        if (e.kind === 'ice_route' && !ICE_TYPES.has(String(e.detail.type))) bad.push('ice_route.type');
    } else if (/fallback|quality_limitation|ice_route/.test(e.kind)) {
        bad.push('missing detail');
    }
    return bad;
}

const same = (a?: CallEventDetail, b?: CallEventDetail) => {
    const ka = Object.keys(a ?? {}).filter(k => k !== 'repeat');
    const kb = Object.keys(b ?? {}).filter(k => k !== 'repeat');
    return ka.length === kb.length && ka.every(k => a![k] === b![k]);
};

function emit() { for (const l of [...listeners]) { try { l(); } catch { /* isolate */ } } }

/** Record one event. Unknown kinds are dropped (the kind list is the contract). */
export function logCallEvent(kind: CallEventKind, detail?: CallEventDetail): void {
    if (!(CALL_EVENT_KINDS as readonly string[]).includes(kind)) return;
    const abs = nowMs();
    const ev: CallEvent = { t: Date.now(), kind };
    const d = sanitize(detail);
    if (d) ev.detail = d;
    const last = buf[buf.length - 1];
    if (last && last.ev.kind === kind && abs - last.abs <= COALESCE_MS && (NOISY.has(kind) || same(last.ev.detail, ev.detail))) {
        const repeat = Number(last.ev.detail?.repeat ?? 1) + 1;
        last.ev.detail = { ...(ev.detail ?? {}), repeat };
        emit();
        return;
    }
    buf.push({ abs, ev });
    const cutoff = abs - MAX_AGE_MS;
    while (buf.length > MAX_EVENTS || (buf.length > 0 && buf[0].abs < cutoff)) buf.shift();
    emit();
}

/** A copy of the log, oldest first. */
export function getCallEvents(): CallEvent[] {
    return buf.map(r => ({ ...r.ev, ...(r.ev.detail ? { detail: { ...r.ev.detail } } : {}) }));
}

/** Drop everything (sign-out). */
export function clearCallEvents(): void {
    buf = [];
    placeholders = new Map();
    counters.clear();
    emit();
}

/** A call started: placeholders start fresh. */
export function markCallStart(): void {
    placeholders = new Map();
    counters.clear();
}

/** The call ended: the placeholder map is dropped. */
export function markCallEnd(): void {
    placeholders = new Map();
    counters.clear();
}

/**
 * A stable placeholder for a track in this call. `key` is any internal key
 * (a track sid) — it is used only as an in-memory map key here and never
 * appears in an entry.
 */
export function trackPlaceholder(key: string, kind: 'self-camera' | 'self-screen' | 'remote-video' | 'remote-screen'): string {
    if (kind === 'self-camera' || kind === 'self-screen') return kind;
    const existing = placeholders.get(key);
    if (existing) return existing;
    // The reporter's scheme has one remote namespace: shares are remote-video-N too.
    const n = (counters.get('remote-video') ?? 0) + 1;
    counters.set('remote-video', n);
    const p = `remote-video-${n}`;
    placeholders.set(key, p);
    return p;
}

export function subscribeCallEvents(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** Plain-text rendering for "Copy call log". */
export function formatCallEvents(events: readonly CallEvent[]): string {
    return events.map(e => {
        const s = new Date(e.t).toISOString().slice(11, 23);
        const d = e.detail ? ' ' + Object.entries(e.detail).map(([k, v]) => `${k}=${v}`).join(' ') : '';
        return `${s} ${e.kind}${d}`;
    }).join('\n');
}
