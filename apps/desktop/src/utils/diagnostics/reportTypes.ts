/**
 * Wire contract for a diagnostic report (crash / issue reporter), schema 1.
 *
 * Three consumers must agree on this shape:
 *   - the desktop builder (src/utils/diagnostics/*) produces it,
 *   - the API (`POST /v1/diagnostics/reports`, apps/api/src/diagnostics/)
 *     validates, re-scrubs and stores it,
 *   - the admin dashboard (admin/, "Diagnostics" section) renders it.
 * A worked example lives at docs/diagnostics/sample-report.json.
 *
 * PRIVACY INVARIANTS (enforced by the builder and re-enforced by the API):
 *   - no message content, decrypted data, keys, tokens, file names;
 *   - no usernames, display names, emails (other than the optional
 *     `reply_email` the user typed), server / channel / conversation names;
 *   - no participant identities: remote tracks are `remote-video-1`, never a
 *     LiveKit SID or user id; local tracks are `screen-1` / `camera-1` /
 *     `mic-1`;
 *   - no minidumps or process memory — JS-level crash info only;
 *   - every free-text string has been through the scrubber (scrub.ts).
 * The report is tied to the sender's account server-side (from the JWT), not
 * by anything inside it.
 */

export const DIAGNOSTIC_SCHEMA_VERSION = 1;

export const DIAGNOSTIC_CATEGORIES = [
    'crash',
    'screen_share',
    'call_audio',
    'video_camera',
    'performance',
    'notifications',
    'other',
] as const;
export type DiagnosticCategory = typeof DIAGNOSTIC_CATEGORIES[number];

export type DiagnosticTrigger = 'manual' | 'crash_prompt' | 'auto_crash' | 'in_call' | 'freeze_offer';

/** Size caps shared with the API DTO (apps/api/src/diagnostics/). */
export const DIAGNOSTIC_LIMITS = {
    /** Whole HTTP body. */
    maxBodyBytes: 256 * 1024,
    /** JSON.stringify(payload).length. */
    maxPayloadBytes: 192 * 1024,
    maxDescriptionChars: 4000,
    maxReplyEmailChars: 254,
    maxPerfRows: 300,
    maxWebrtcSamples: 120,
    maxRecentErrors: 20,
    /** Newest call-engine events kept (`call_events`). */
    maxCallEvents: 300,
    /** `detail` keys per call event. */
    maxCallEventDetailKeys: 12,
    /** Longest string value allowed in a call event's `detail`. */
    maxCallEventDetailChars: 64,
} as const;

/**
 * Payload keys whose values our own code produces in a fixed format. The
 * scrubber's free-text rules would mangle some of them (a 40-char commit is a
 * "hex blob", `10.18.13.5` looks like an IPv4), so `scrubDeep` keeps them
 * verbatim ONLY when they match these patterns and replaces them with
 * '<invalid>' otherwise. The API uses the same map for its re-scrub.
 */
export const DIAGNOSTIC_VERBATIM_KEYS: Readonly<Record<string, RegExp>> = {
    app_version: /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/,
    app_version_at_crash: /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/,
    build_commit: /^(?:[0-9a-f]{7,40}|unknown)$/,
    electron: /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,20})?$/,
    chrome: /^\d{1,4}(?:\.\d{1,6}){1,3}$/,
    node: /^\d{1,4}\.\d{1,4}\.\d{1,6}$/,
    os_version: /^[0-9A-Za-z._()-]{1,64}$/,
    vendor_id: /^0x[0-9a-f]{1,8}$/i,
    device_id: /^0x[0-9a-f]{1,8}$/i,
    driver_version: /^[0-9A-Za-z._-]{1,40}$/,
    generated_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    occurred_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    // Enum-valued keys. Verbatim so a sensitive term that happens to equal an
    // enum word (a channel called "video", a friend called "none") cannot turn
    // `kind: 'video'` into `<name>` — and anything outside the enum is dropped.
    kind: /^(?:video|audio|screen|window|camera|renderer_gone|child_process_gone|main_exception|renderer_exception|unclean_exit|error|unhandledrejection)$/,
    source: /^(?:screen_share|screen_share_audio|camera|microphone|unknown|main|renderer|event|metrics)$/,
    quality_limitation_reason: /^(?:cpu|bandwidth|other|none)$/,
    // `call_events[].event`: the call engine's own event name (callEventLog's
    // fixed set). Shape-checked rather than enumerated so a new event kind does
    // not need a coordinated API deploy; the name never carries free text.
    // (Deliberately NOT `kind`: that key is the crash / media enum above.)
    event: /^[a-z][a-z0-9_]{0,39}$/,
    trigger: /^(?:manual|crash_prompt|auto_crash|in_call|freeze_offer)$/,
    platform: /^(?:win32|darwin|linux)$/,
    // Local tracks are `screen-1` / `camera-1` in the WebRTC samples and
    // `self-camera` / `self-screen` in call_events; remote ones `remote-video-1`.
    track: /^(?:(?:screen|screen-audio|camera|mic|remote-video|remote-audio|track)-\d{1,4}|self-(?:camera|screen|screen-audio|mic)(?:-\d{1,4})?)$/,
};

/** The POST body. */
export interface DiagnosticReportBody {
    schema: 1;
    category: DiagnosticCategory;
    /** User-written, scrubbed, ≤ 4000 chars. Optional. */
    description?: string;
    /** Optional address the user typed so support can reply. NOT scrubbed, NOT in payload. */
    reply_email?: string;
    /** `1.0.17` / `1.0.17-staging.131`. */
    app_version: string;
    platform: 'win32' | 'darwin' | 'linux';
    /** `10.0.22631`, `14.5.0`, `6.8.0-142-generic`. */
    os_version: string;
    payload: DiagnosticPayload;
}

export interface DiagnosticPayload {
    /** ISO-8601. Every `t_s` below is seconds relative to this (≤ 0). */
    generated_at: string;
    trigger: DiagnosticTrigger;
    system: SystemInfo;
    /** Flat map of issue-relevant settings, scalar values only. */
    settings: Record<string, string | number | boolean | null>;
    entitlement?: EntitlementInfo;
    perf_log?: { rows: PerfRow[]; total_rows: number };
    webrtc?: WebrtcSummary;
    crash?: CrashInfo;
    recent_errors?: RecentError[];
    /**
     * What the call engine decided, oldest first. Present (possibly empty) for
     * the call categories only — screen_share, call_audio, video_camera,
     * performance. OPTIONAL KEY: absent on crash / notifications / other
     * reports and on every report from a client that predates it, so schema
     * stays 1 and readers must tolerate its absence.
     */
    call_events?: CallEvent[];
}

/**
 * One call-engine decision. Privacy-safe by construction: `event` is a
 * snake_case name from a fixed set (join / leave counts, ICE type and TURN
 * use, codec decisions, simulcast and dynacast changes, qualityLimitationReason
 * transitions, freezes, focus switches, load offers, H.265 negotiation, A/V-sync
 * estimates), `detail` holds short scalars only, and tracks are placeholders
 * (`self-camera`, `remote-video-1`) — never a SID, identity, room or file name.
 * Every string has been through the scrubber.
 */
export interface CallEvent {
    /** Seconds relative to `generated_at` (≤ 0), one decimal. */
    t_s: number;
    /** `^[a-z][a-z0-9_]{0,39}$` (DIAGNOSTIC_VERBATIM_KEYS.event). */
    event: string;
    /**
     * ≤ DIAGNOSTIC_LIMITS.maxCallEventDetailKeys keys, each `^[a-z][a-z0-9_]{0,31}$`;
     * values are booleans, finite numbers, or strings ≤ maxCallEventDetailChars.
     * Keys that are also verbatim keys (`track`, `source`, `kind`,
     * `quality_limitation_reason`, …) must satisfy that key's pattern or the
     * value becomes '<invalid>'.
     */
    detail?: Record<string, string | number | boolean>;
}

export interface SystemInfo {
    app_version: string;
    /** 7–40 hex chars, or 'unknown'. */
    build_commit: string;
    channel: 'stable' | 'staging' | 'dev' | 'unknown';
    electron: string;
    chrome: string;
    node: string;
    platform: 'win32' | 'darwin' | 'linux';
    os_version: string;
    arch: string;
    cpu_model: string;
    cpu_cores: number;
    /** Total RAM, GiB, one decimal. */
    ram_gb: number;
    gpu: {
        devices: Array<{
            /** `0x10de` */
            vendor_id: string;
            device_id: string;
            active: boolean;
            driver_vendor?: string;
            driver_version?: string;
        }>;
        /** app.getGPUInfo / getGPUFeatureStatus: `{ gpu_compositing: 'enabled', … }`. */
        feature_status: Record<string, string>;
    };
    displays: Array<{ width: number; height: number; scale_factor: number; refresh_hz: number; primary: boolean }>;
    hardware_acceleration: boolean;
    uptime_s: number;
}

export interface EntitlementInfo {
    is_paid: boolean;
    can_publish_video: boolean;
    /** Highest screen-share fps this account may pick (0 = no screen share). */
    max_screen_share_fps: number;
    max_upload_mb: number;
}

export interface PerfRow {
    t_s: number;
    source: 'main' | 'renderer' | 'event' | 'metrics';
    ms: number;
    activity: string;
}

export type QualityLimitation = 'cpu' | 'bandwidth' | 'other' | 'none';

export interface OutboundTrackStats {
    /** `screen-1`, `camera-1`, `mic-1`, `screen-audio-1`. */
    track: string;
    kind: 'video' | 'audio';
    source: 'screen_share' | 'screen_share_audio' | 'camera' | 'microphone' | 'unknown';
    codec?: string;
    encoder?: string;
    hardware?: boolean | null;
    target_fps?: number;
    capture_fps?: number;
    encoded_fps?: number;
    sent_fps?: number;
    width?: number;
    height?: number;
    quality_limitation_reason?: QualityLimitation;
    /** Cumulative seconds per limitation reason (qualityLimitationDurations). */
    quality_limitation_s?: Partial<Record<QualityLimitation, number>>;
    bitrate_kbps?: number;
    target_bitrate_kbps?: number;
    nack_count?: number;
    pli_count?: number;
    /**
     * Video: encodings (simulcast layers) this sender has, and how many are
     * ACTIVE. 0 active = dynacast paused the track because nobody is watching
     * it — "sent 0 fps" is then expected, not an encoder failure.
     */
    layers?: number;
    active_layers?: number;
}

export interface InboundTrackStats {
    /** `remote-video-1`, `remote-audio-2` — random per report, never a SID. */
    track: string;
    kind: 'video' | 'audio';
    codec?: string;
    decoder?: string;
    hardware?: boolean | null;
    fps?: number;
    width?: number;
    height?: number;
    bitrate_kbps?: number;
    packets_lost_pct?: number;
    jitter_ms?: number;
    frames_dropped?: number;
    freeze_count?: number;
}

export interface WebrtcSample {
    t_s: number;
    outbound: OutboundTrackStats[];
    inbound: InboundTrackStats[];
    transport?: {
        rtt_ms?: number;
        available_outgoing_kbps?: number;
        packet_loss_pct?: number;
    };
}

export interface WebrtcSummary {
    call_active: boolean;
    /** When no call is active: how long ago the last one ended. */
    seconds_since_call_end?: number;
    capture?: {
        kind: 'screen' | 'window' | 'camera';
        requested_fps?: number;
        requested_resolution?: string;
        capture_fps?: number;
        codec_pref?: string;
    };
    /** Oldest first, at most DIAGNOSTIC_LIMITS.maxWebrtcSamples. */
    samples: WebrtcSample[];
}

export interface CrashInfo {
    kind: 'renderer_gone' | 'child_process_gone' | 'main_exception' | 'renderer_exception' | 'unclean_exit';
    /** Electron process type: 'renderer', 'GPU', 'Utility', 'browser', … */
    process_type?: string;
    /** Electron's fixed reason enum: crashed, oom, killed, launch-failed, … */
    reason?: string;
    exit_code?: number;
    service_name?: string;
    error_name?: string;
    message?: string;
    stack?: string;
    occurred_at: string;
    app_version_at_crash?: string;
}

export interface RecentError {
    t_s: number;
    kind: 'error' | 'unhandledrejection';
    name?: string;
    message: string;
    stack?: string;
}
