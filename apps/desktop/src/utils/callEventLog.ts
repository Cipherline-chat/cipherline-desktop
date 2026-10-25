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
 *
 * One exception to "memory of THIS process": an allowlist of kinds is also
 * mirrored, as `k=v` scalars, into the main process's in-memory perf log
 * (crashBreadcrumbs.ts), so an auto crash report still knows what the call
 * was doing when the renderer died. Same data, same memory-only rule.
 */
import { mirrorBreadcrumb } from './crashBreadcrumbs';

export const CALL_EVENT_KINDS = [
    'call_join', 'call_leave', 'participants', 'ice_route', 'reconnecting', 'reconnected',
    'camera_capture', 'camera_codec', 'camera_start_check', 'camera_fallback', 'camera_ladder',
    'camera_layering', 'camera_tier', 'camera_encoder_stall',
    'share_codec', 'share_start_check', 'share_fallback', 'share_low_layer', 'share_picker',
    // A share start: stage timings (codec probe, acquire + publish), or the
    // DOMException type when it failed (SidebarConference.startScreenShareFrom).
    'share_start',
    // Our share's capture / send rates before vs. after Cipherline went to the
    // background, and which stage lost the frames (shareBackgroundProbe.ts).
    'share_background',
    // The size a share is held to for its codec (shareEncoderLimits.ts): the
    // capture's size, what is encoded, the scale between them, the layout
    // (whole display / one screen of an ultra-wide) and the fallback step.
    'share_clamp',
    // Every ~10 s while sharing, and 2 s after a focus change (shareHealth.ts):
    // capture / source / encode / send frame rates, the encoder's limit reason,
    // which encoder and whether it is hardware, window focus + visibility.
    'share_fps',
    // The main process's Windows power-throttling opt-out for a live share
    // (apply / re-apply / restore): per-process error codes, a mask, counts
    // (sharePowerEvent.ts, logged by ShareBoostGuard).
    'share_power',
    // The WDDM GPU scheduling class raised for a live share (apply / re-apply /
    // restore): the class read back per process + NTSTATUS strings
    // (shareGpuSchedEvent.ts, logged by ShareBoostGuard).
    'share_gpu_sched',
    // The "share the game window instead" hint: shown / accepted (shareFullscreenHint.ts).
    'share_hint',
    // A screen share's display HDR state and capture path: `path` chromium |
    // native_tonemap | fallback (+ why), SDR white / peak nits, and ~10 s in
    // (stage=stats) the tone map's GPU cost per frame (SidebarConference
    // tryStartHdrShare, utils/hdrSharePipeline.ts).
    'share_hdr',
    'dynacast_layers', 'quality_limitation', 'freeze_start', 'freeze_end',
    // Receive side (CallEventMonitor): a remote video's decoded size changed
    // (layer switch); a 10 s window with loss / keyframe requests (counts and
    // %); a remote share held at / released from its lower layer because its
    // full layer was not getting through (shareLossFallback.ts).
    'rx_layer', 'rx_video_health', 'share_rx_fallback',
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
    // The published mic was re-acquired (micDeviceSync.ts): a reason enum,
    // whether the target was the system default, ok|failed. Never a device
    // id or label — labels can carry a person's name.
    'mic_device_switch',
    // The live mic capture was re-opened because its processing flags (echo
    // cancellation / NS / AGC) did not match the wanted ones — the Settings
    // toggle mid-call, or livekit-client reopening with Chromium's defaults
    // (micDeviceSync.applyCapture): the wanted echo-cancellation value,
    // whether it was among the flags that differed, ok|failed. Booleans only.
    'mic_echo_cancellation',
    // The voice processor's audio render thread fell behind (AudioContext
    // playbackStats, nsLoadGuard.ts): a 10 s window's underrun ms / events and
    // the NS engine that was running; once per call, Strong → Light.
    'audio_render', 'ns_load_fallback',
    // Audio latency guards (2026-10-24 "audio a minute late on both ends"):
    // the E2EE worker's audio-frame lag per direction and the frames it
    // dropped to stay inside the cap (utils/e2eeAudioLag.ts). The inbound
    // jitter-buffer delay is in every webrtc sample as jb_ms.
    // Milliseconds, counts and a direction enum only.
    'e2ee_audio_lag',
    // Receiver-side screen-share A/V sync: the extra delay put on the SHARE
    // VIDEO receiver to meet its share audio (utils/shareAvSync.ts). Never on
    // a microphone or camera receiver.
    'av_sync_applied',
    // One per output-device (setSinkId) attempt, element or AudioContext, in a
    // call or not (audioOutput.ts): target, ok, landed (read-back matches),
    // to_default, a reason enum and a DOMException-name enum. Never a device
    // id or label.
    'audio_output_sink',
    // Is the stored speaker pick a real, current device? result enum + the
    // number of outputs listed (audioOutput.ts notePick).
    'audio_output_pick',
    // GPU process restart ("graphics driver reset") and what the call did
    // about it (utils/gpuRecovery.ts): restart count, Electron's reason enum,
    // Chromium's exit code, step enums, booleans and counts only.
    'gpu_process_restarted', 'video_recovery',
    // A renderer frame that blocked the UI for 200 ms or more (freezeLog.ts,
    // from the Long Animation Frames API): durations, plus the longest
    // script's file BASENAME on our own origin, function name, character
    // offset and invoker kind — code identifiers only (longFrameAttribution.ts).
    'long_frame',
    // A rejected axios call nothing caught whose failure was the TRANSPORT (no
    // HTTP answer: ERR_NETWORK / ECONNABORTED...), e.g. right after a wake while
    // Wi-Fi is still reconnecting. A non-fatal diagnostic, not a crash: the
    // transport code only, never the URL (utils/networkError.ts).
    'net_unhandled',
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

/** One observer of every logged event, BEFORE coalescing (beta diagnostics'
 *  call summary counts each one). Gets the sanitized detail; must not throw
 *  (it is isolated anyway). */
type CallEventTap = (kind: CallEventKind, detail: CallEventDetail | undefined) => void;
let tap: CallEventTap | null = null;
export function setCallEventTap(fn: CallEventTap | null): void { tap = fn; }

/** Record one event. Unknown kinds are dropped (the kind list is the contract). */
export function logCallEvent(kind: CallEventKind, detail?: CallEventDetail): void {
    if (!(CALL_EVENT_KINDS as readonly string[]).includes(kind)) return;
    const abs = nowMs();
    const ev: CallEvent = { t: Date.now(), kind };
    const d = sanitize(detail);
    if (d) ev.detail = d;
    if (tap) { try { tap(kind, d); } catch { /* isolate */ } }
    // Survives a renderer crash (crashBreadcrumbs.ts → main's perf log).
    mirrorBreadcrumb(kind, d);
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
