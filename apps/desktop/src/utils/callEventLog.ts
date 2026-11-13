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
 *     `remote-video-1` for a remote camera, `remote-share-1` for a remote
 *     screen share …), stable for one call: the map from the real track key to
 *     the placeholder lives only here, in memory, and is dropped when the call
 *     ends. Cameras and shares count in SEPARATE namespaces, so a freeze on
 *     `remote-share-1` can never be a camera;
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
 *     (optional -N), remote-video-N (a remote camera) or remote-share-N (a
 *     remote screen share) — nothing else;
 *   - reserved keys `kind`, `source`, `quality_limitation_reason` are not used.
 * validateCallEvent() checks all of it; sanitising enforces what it can.
 *
 * One exception to "memory of THIS process": an allowlist of kinds is also
 * mirrored, as `k=v` scalars, into the main process's in-memory perf log
 * (crashBreadcrumbs.ts), so an auto crash report still knows what the call
 * was doing when the renderer died. Same data, same memory-only rule.
 */
import { mirrorBreadcrumb } from './crashBreadcrumbs';
import { clearShareRefs } from './shareRef';
import { STEADY_KINDS, STEADY_MAX_REPEAT, STEADY_WINDOW_MS, isSteady } from './shareSteady';

export const CALL_EVENT_KINDS = [
    'call_join', 'call_leave', 'participants', 'ice_route', 'reconnecting', 'reconnected',
    'camera_capture', 'camera_codec', 'camera_start_check', 'camera_fallback', 'camera_ladder',
    'camera_layering', 'camera_tier', 'camera_encoder_stall',
    // The camera's top layer was held to 720p30 / released while a software share ran (cameraShareCap.ts): to = capped|restored, height, fps.
    'camera_share_cap',
    // The camera CAPTURE delivered far below its nominal rate for a sustained
    // stretch while the encoder was healthy (CallPerformanceGuard,
    // callLoadMonitor.CameraCaptureStarveDetector): delivered / nominal fps,
    // capture size, whether a screen share was live, encoder hw flag, limit enum.
    'camera_starved',
    // The camera's sender is sending another codec than it was published with
    // (same silent encoder fallback as share_codec_drift; cameraPublish.handleCameraDrift):
    // codec names, the encoder implementation name, a layer count, an action enum.
    'camera_codec_drift',
    'share_codec', 'share_start_check', 'share_fallback', 'share_low_layer', 'share_picker',
    // A share start: stage timings (codec probe, acquire + publish), or the
    // DOMException type when it failed (SidebarConference.startScreenShareFrom).
    'share_start',
    // The share's SYSTEM-AUDIO side, one row per step (shareAudioEvent.ts): step = skipped
    // (why: off / no_native / no_pid / no_api), starting, refused (main said no), first_chunk,
    // no_chunks (3 s of nothing), failed (reason enum), exited, stopped (cause enum), picked
    // (Wayland window share: apps = HOW MANY apps were on offer, how = auto|manual|none); mode =
    // screen|window|app (app = one application's audio); ms since the start. Fixed words and
    // numbers only - never an application name, a source
    // id, a title, a process name or a pid. Added because a report could not say whether
    // audio had been asked for after a source swap (2026-11-04, Linux).
    'share_audio',
    // The share's sender is sending another codec than it was published with
    // (libwebrtc's encoder fallback; the SFU forwards none of it): codec names,
    // the encoder implementation name, a layer count (shareCodecDrift.ts).
    'share_codec_drift',
    // Linux hardware (VA-API) video encode failed this session (linuxHwEncode.ts): a fixed reason word
    // (hw_lost | high_start | stall | drift), the published codec, the encoder implementation name.
    'linux_hw_encode',
    // A share encoded nothing because NOTHING REACHED the encoder: which check
    // saw it, media-source / crop frame counts, the crop stage's mode and
    // fallback enum, the action taken (shareHealth.diagnoseNoFrames).
    'share_capture_stall',
    // A single-screen (cropped) share ~6 s in: where the crop runs, why it fell
    // back to the main thread, frames in / out / dropped, sizes as "WxH" (shareCrop.ts).
    'share_crop',
    // Receive side: a remote SCREEN SHARE subscribed for a while that has not
    // decoded one frame - whether packets arrive at all, the codec they carry
    // (CallEventMonitor).
    'share_rx_dead',
    // Receive side: a remote video's decoder became libwebrtc's "NullVideoDecoder"
    // (the hardware H.265 decoder died mid-stream; there is no software HEVC): the
    // track ref, codec + decoder name, tile size, ms since the displayed element
    // last changed, and the action taken (utils/rxDecoderLost.ts).
    'rx_decoder_lost',
    // Receive side: a remote share that keeps RECEIVING frames while none is
    // decoded after it had been (shareRxStall.ts): phase start | end, packets /
    // frames received vs. handed to the decoder vs. dropped per second, keyframes
    // decoded and keyframe requests sent in the stall, the decoder's name, and
    // whether the picture changed size just before it began.
    'share_rx_stall',
    // The viewer acting on that stall (shareRxStallRecovery.ts): the share's input
    // paused so the decoder can drain. phase start (attempt, whether this attempt
    // also capped the share to its lower layer, or withdrew H.265 decode) | end
    // (attempt, whether the drain was seen, how long the pause lasted).
    'share_rx_flush',
    // VIEWER, around a freeze of a watched share (shareSecondRing.ts): the last ~10 s,
    // one value per second, as "88/89/0/0" strings - frames received / decoded /
    // presented and packets received per second - at freeze start and end. A
    // freeze with rx > 0 and dec = 0 is the viewer's decoder; rx = 0 and
    // packets = 0 is upstream. Rate-limited per share.
    'share_rx_ring',
    // SHARER, when a share_fps sample dipped under half the target (shareSecondRing.ts):
    // the last ~10 s, one value per second - capture (src) / encoded (enc) / sent
    // frames per second and active layers - so the dip can be placed in time.
    'share_tx_ring',
    // The sharer's encoder cannot keep up with the share's setting (shareEncoderOverload.ts):
    // phase = shown | accepted | dismissed | none | state (state: `why` the watch
    // stopped or could not judge - restart, blocked, layers, no_capture, ...), the setting and the suggestion as
    // "<resolution>@<fps>", the TOP layer's measured encode ms / fps / cpu-limited %,
    // pixels per second achieved by the top layer and the lighter copy and the
    // budget the suggestion was fitted to (Mpx/s), and the seconds of evidence.
    'share_encoder_overload',
    // A game in front is starving the share (shareGameStarve.ts): phase = shown | accepted |
    // dismissed | none, cause = capture | encoder, act = boost | lower | tip, whether the
    // "While gaming" boost was on, the setting and the suggestion as "<resolution>@<fps>",
    // the capture / sent rates the verdict rests on, the target and the seconds of evidence.
    'share_game_starve',
    // The share's keep-alive stage (shareKeepAlive.ts): phase = engaged | stopped | failed, how many
    // real frames the capturer delivered and how many repeats were sent while it was quiet, whether a
    // fullscreen-class program was in front (fg_full), and the capture rate that triggered it.
    'share_keepalive',
    // Our share's capture / send rates before vs. after Cipherline went to the
    // background, and which stage lost the frames (shareBackgroundProbe.ts).
    'share_background',
    // The size a share is held to for its codec (shareEncoderLimits.ts): the
    // capture's size, what is encoded, the scale between them, the layout
    // (whole display / one screen of an ultra-wide) and the fallback step.
    'share_clamp',
    // A viewer's place held across a share republish (shareHold.ts): phase = armed
    // (the flag arrived; frame = a last frame was taken), start (the track went),
    // new_track, renewed (a further change), end (end = resumed / resume_timeout /
    // timeout / cancelled / left / stopped / disarmed; ms = how long the track was
    // gone), or gone (an unpublish with no flag: a real stop, no hold, no timer).
    'share_hold',
    // The publisher's flag for it (shareRepublishSignal.ts): phase = set (acked, ack_ms)
    // or clear (why = published / failed / cancelled / stopped).
    'share_republish',
    // Every ~10 s while sharing, and 2 s after a focus change (shareHealth.ts):
    // capture / source / encode / send frame rates, the encoder's limit reason,
    // which encoder and whether it is hardware, window focus + visibility.
    'share_fps',
    // Our share's NETWORK side, every ~10 s while sharing, coalesced while steady
    // (shareNetStats.ts): actual send kbps vs the configured cap and the path's
    // estimate, RTT, the receiver's reported loss %, per-frame encode ms, plus
    // `share_ref` (a short hash of the track SID - shareRef.ts) to match a viewer's report.
    'share_net',
    // The display refresh rate at each end of a share: role=sharer (the captured
    // display, from the main process) or role=viewer (a ~0.5 s rAF measurement,
    // once per watched share - displayRefresh.ts). Hz + how it was found.
    'share_display',
    // VIEWER, per watched remote screen share, every ~10 s, coalesced while steady
    // (shareRxStats.ts): frames received / decoded / dropped / presented per second,
    // jitter-buffer ms, decoded size, requested layer, window focus, tile size.
    // share_rx_start (once, and when it changes): codec + decoder + hardware.
    'share_rx_fps', 'share_rx_start',
    // VIEWER, same cadence: the compositor's side of the same window (vf_fps = frames the display
    // took, pres_fps, inter-frame gaps) - tells a display-limited tile from a dropping one
    // (videoPresentProbe.ts).
    'share_present',
    // Report-time snapshots (shareSnapshot.ts): 1 s samples of the same numbers for
    // ~10 s per active share. Built for the report only - never in this ring.
    'share_rx_snap', 'share_tx_snap',
    // The main process's Windows power-throttling opt-out for a live share
    // (apply / re-apply / restore): per-process error codes, a mask, counts
    // (sharePowerEvent.ts, logged by ShareBoostGuard).
    'share_power',
    // The WDDM GPU scheduling class raised for a live share (apply / re-apply /
    // restore): the class read back per process + NTSTATUS strings
    // (shareGpuSchedEvent.ts, logged by ShareBoostGuard).
    'share_gpu_sched',
    // A screen share's display HDR state and capture path: `path` chromium |
    // native_tonemap | fallback (+ why), SDR white / peak nits, and ~10 s in
    // (stage=stats) the tone map's GPU cost per frame (SidebarConference
    // tryStartHdrShare, utils/hdrSharePipeline.ts).
    'share_hdr',
    // Linux hardware (NVENC) screen share (SidebarConference tryStartNativeShare, utils/nativeSharePipeline.ts): `select` = which path a
    // share took and why (backend, GPU, driver, sustained fps, sizes); `fallback` = native failed and the share went the normal way
    // (reason + phase start|publish|live); `ended`, `fps_limited` (the card could not hold the asked rate), `helper_error`.
    'native_share_select', 'native_share_fallback', 'native_share_stats', 'native_share_ended', 'native_share_fps_limited', 'native_share_helper_error', 'native_share_sender_params_failed', 'native_share_low', 'native_share_low_failed',
    'dynacast_layers', 'quality_limitation', 'freeze_start', 'freeze_end',
    // Receive side (CallEventMonitor): a remote video's decoded size changed
    // (layer switch); a 10 s window with loss / keyframe requests (counts and
    // %); a remote share held at / released from its lower layer because its
    // full layer was not getting through (shareLossFallback.ts).
    'rx_layer', 'rx_video_health', 'share_rx_fallback',
    // The viewer chose "Keep full quality" on the fallback's notice: no more
    // automatic drops for that share (track placeholder + whether a cap came off).
    'share_rx_optout',
    'focus_upgrade', 'focus_switched',
    'incoming_mode', 'decode_cap',
    // The outgoing mic's levels over ~30 s of talking: raw / noise-suppressed / AGC-input /
    // wire speech level (dBFS), the AGC's gain, peak, clipped samples, % held by the
    // compressor or limiter, % talking, % gate open, the mic-volume dB (micLevelLog.ts).
    // And what a listener gets from ONE remote talker (placeholder `slot`): the wire level
    // they send, the gain the listener's leveler applied and the level heard (useParticipantAudio).
    // Numbers only, never audio.
    'mic_level', 'rx_level',
    'load_trigger', 'offer_shown', 'offer_answer',
    // H.265 was latched off by a failure and its retry window (hevcNegotiation.ts HEVC_RETRY_MS) ended.
    'h265_caps', 'h265_switch', 'h265_retry',
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
    // One-way audio, both halves (2026-11-04). audio_out_stall: the silence
    // watchdog tripped on the mic SENDER's own stats (audioSilenceWatchdog.ts):
    // a cause enum (no_rtp | silent_source), the processing AudioContext's state
    // enum and whether a resume was attempted. audio_in_stall: an unmuted remote
    // mic's inbound packets stopped (callSummary.InboundAudioStallDetector): a
    // cause enum and two booleans that say WHICH leg is dead - did the SFU hear
    // them speaking, and did any of that peer's other media keep arriving.
    'audio_out_stall', 'audio_in_stall',
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
    // Which renderer the onboarding dot field ended up on (components/onboarding/dots/renderReport.ts):
    // path (webgl | canvas2d) and a reason enum (verified, blank, lost, threw, no_webgl, remembered,
    // forced, css_opacity). Enums only.
    'dots_render',
] as const;
export type CallEventKind = (typeof CALL_EVENT_KINDS)[number];

export type CallEventDetail = Record<string, string | number | boolean>;
export interface CallEvent { t: number; kind: string; detail?: CallEventDetail }

export const MAX_EVENTS = 500;
export const MAX_AGE_MS = 30 * 60 * 1000;
export const COALESCE_MS = 2000;
/** Kinds whose repeats within COALESCE_MS replace the previous entry (latest detail wins, `repeat` counts). */
const NOISY: ReadonlySet<string> = new Set(['dynacast_layers', 'quality_limitation', 'participants', 'decode_cap', 'focus_upgrade', 'e2ee_decrypt_error', 'e2ee_data_error', 'annot_rx_drop']);

/**
 * Facts about the CURRENT share that must outlive the ring: when it started,
 * which codec / clamp / crop / display it was given, what decodes it. A long
 * share rotates all of them out of the 500-event / 30-minute ring, and they are
 * exactly what makes the later fps samples interpretable. Each is also kept in
 * a small pin store (last PIN_PER_GROUP per kind and share, PIN_MAX in total)
 * that the report merges into `call_events` (diagnostics/collect.ts). Cleared
 * with the log (sign-out) and at the next call start - NOT at call end, so a
 * report filed right after leaving still explains the share.
 */
export const PINNED_KINDS: ReadonlySet<string> = new Set([
    'share_start', 'share_codec', 'share_clamp', 'share_display', 'share_crop', 'share_rx_start',
]);
/** Kinds the report keeps through size trimming (pins + the report-time snapshots). */
export const SHARE_CONTEXT_KINDS: ReadonlySet<string> = new Set([...PINNED_KINDS, 'share_rx_snap', 'share_tx_snap']);
export const PIN_PER_GROUP = 3;
export const PIN_MAX = 40;

const MAX_STR = 64;
const MAX_KEYS = 12;
const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED = new Set(['kind', 'source', 'quality_limitation_reason']);

interface Rec {
    abs: number;
    ev: CallEvent;
    /** STEADY_KINDS: the run's first detail (what later samples are compared with) and when it last absorbed one. */
    anchor?: CallEventDetail;
    lastAbs?: number;
}
let buf: Rec[] = [];
let pins: CallEvent[] = [];
let placeholders = new Map<string, string>();
const counters = new Map<string, number>();
const listeners = new Set<() => void>();

function nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function sanitizeCallEventDetail(detail: CallEventDetail | undefined): CallEventDetail | undefined {
    return sanitize(detail);
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

const TRACK_RE = /^(self-camera|self-screen|self-screen-audio|self-mic)(-\d+)?$|^remote-(video|share)-\d+$/;
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
    if (PINNED_KINDS.has(kind)) pin(ev);
    if (d && STEADY_KINDS.has(kind) && absorbSteady(kind, d, abs)) { emit(); return; }
    const last = buf[buf.length - 1];
    if (last && last.ev.kind === kind && abs - last.abs <= COALESCE_MS && (NOISY.has(kind) || same(last.ev.detail, ev.detail))) {
        const repeat = Number(last.ev.detail?.repeat ?? 1) + 1;
        last.ev.detail = { ...(ev.detail ?? {}), repeat };
        emit();
        return;
    }
    buf.push({ abs, ev, ...(d && STEADY_KINDS.has(kind) ? { anchor: { ...d }, lastAbs: abs } : {}) });
    const cutoff = abs - MAX_AGE_MS;
    while (buf.length > MAX_EVENTS || (buf.length > 0 && buf[0].abs < cutoff)) buf.shift();
    emit();
}

/** A periodic sample that matches the run it follows updates that entry in place (shareSteady.ts). */
function absorbSteady(kind: string, d: CallEventDetail, abs: number): boolean {
    const ref = d.share_ref;
    for (let i = buf.length - 1, seen = 0; i >= 0 && seen < 40; i--, seen++) {
        const r = buf[i];
        if (r.ev.kind !== kind || r.ev.detail?.share_ref !== ref) continue;
        const repeat = Number(r.ev.detail?.repeat ?? 1);
        if (!r.anchor || abs - (r.lastAbs ?? r.abs) > STEADY_WINDOW_MS || repeat >= STEADY_MAX_REPEAT || !isSteady(r.anchor, d)) return false;
        r.ev.detail = { ...d, repeat: repeat + 1 };
        r.lastAbs = abs;
        return true;
    }
    return false;
}

function pin(ev: CallEvent): void {
    const group = (e: CallEvent) => `${e.kind}|${e.detail?.share_ref ?? 'self'}`;
    const g = group(ev);
    const sameGroup = pins.filter(p => group(p) === g);
    const lastP = sameGroup[sameGroup.length - 1];
    if (lastP && ev.t - lastP.t <= COALESCE_MS && same(lastP.detail, ev.detail)) return; // the ring coalesces the same repeat
    pins.push({ t: ev.t, kind: ev.kind, ...(ev.detail ? { detail: { ...ev.detail } } : {}) });
    if (sameGroup.length + 1 > PIN_PER_GROUP) {
        const drop = pins.find(p => group(p) === g)!;
        pins.splice(pins.indexOf(drop), 1);
    }
    while (pins.length > PIN_MAX) pins.shift();
}

/** The pinned share-context events, oldest first (copies). May overlap the ring: merge by (t, kind). */
export function getPinnedCallEvents(): CallEvent[] {
    return [...pins].sort((a, b) => a.t - b.t).map(p => ({ ...p, ...(p.detail ? { detail: { ...p.detail } } : {}) }));
}

/** A copy of the log, oldest first. */
export function getCallEvents(): CallEvent[] {
    return buf.map(r => ({ ...r.ev, ...(r.ev.detail ? { detail: { ...r.ev.detail } } : {}) }));
}

/** Drop everything (sign-out). */
export function clearCallEvents(): void {
    buf = [];
    pins = [];
    clearShareRefs(); // the SID -> share_ref cache is memory-only and never outlives a session
    placeholders = new Map();
    counters.clear();
    emit();
}

/** A call started: placeholders start fresh. */
export function markCallStart(): void {
    pins = [];
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
    // Cameras and screen shares count separately: `remote-video-N` is always a
    // camera and `remote-share-N` always a share (reports used to number both
    // as remote-video-N, so a freeze on remote-video-1 could not be told apart).
    const ns = kind === 'remote-screen' ? 'remote-share' : 'remote-video';
    const n = (counters.get(ns) ?? 0) + 1;
    counters.set(ns, n);
    const p = `${ns}-${n}`;
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
