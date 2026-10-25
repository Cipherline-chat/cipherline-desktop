/**
 * Beta diagnostics — wire types (shared contract v1, "Beta diagnostics").
 *
 * The API side (`POST /v1/diagnostics/beta/{events,profile,call-summary}`)
 * validates every field again and drops what does not conform; these types
 * are the client's half of that contract and must not drift from it. Names
 * and shapes here are BINDING — another app (API + admin page) is built
 * against the same contract.
 *
 * Privacy: nothing in these shapes can hold message content, a name, an
 * e-mail, an IP or any conversation / channel / server / call / peer id —
 * peers are COUNTS, call type is dm | group | channel. See sanitize.ts for
 * the enforcement and privacyAudit.test.ts for the proof.
 */

export const BETA_SCHEMA = 1 as const;

export const BETA_EVENT_KINDS = [
    // Keys / messages
    'key_decrypt_failed', 'key_request_unanswered', 'key_stale_epoch_refused', 'session_reset',
    'prekeys_low', 'msg_send_failed', 'msg_pending_stuck', 'msg_fetch_gap', 'history_sync_failed',
    // Calls
    'call_join_failed', 'call_first_audio_slow', 'call_one_way_audio', 'call_keyless_wait',
    'call_e2ee_error', 'call_reconnect', 'call_dropped', 'share_failed', 'camera_failed', 'mic_failed',
    'call_audio_overload',
    // App
    'app_freeze', 'memory_high', 'startup_slow', 'unhandled_error', 'ws_churn', 'gpu_fallback',
    'update_failed', 'backup_failed',
] as const;
export type BetaEventKind = (typeof BETA_EVENT_KINDS)[number];

/** `detail` values: number | boolean | an enum-ish string (see DETAIL_STRING_RE). */
export type BetaDetailValue = number | boolean | string;
export type BetaDetail = Record<string, BetaDetailValue>;

export interface BetaEvent {
    kind: BetaEventKind;
    /** ISO time, ms precision. The ONLY timestamp an event carries. */
    at: string;
    /** sha256 hex of `kind + normalized top frames` (errors) / `kind + enum detail` (others). */
    fingerprint?: string;
    /** Scrubbed, ≤ 300 chars. Only ever set for unhandled_error. */
    message?: string;
    detail?: BetaDetail;
}

export type BetaPlatform = 'win32' | 'darwin' | 'linux';

export interface BetaEventsBody {
    schema: typeof BETA_SCHEMA;
    session_id: string;
    app_version: string;
    platform: BetaPlatform;
    events: BetaEvent[];
}

export type RamBucket = 4 | 8 | 16 | 32 | 64 | 128;
export type AudioApi = 'wasapi' | 'coreaudio' | 'pulse' | 'pipewire' | 'alsa' | 'unknown';
export type NetworkType = 'ethernet' | 'wifi' | 'cellular' | 'unknown';

export interface BetaProfileBody {
    schema: typeof BETA_SCHEMA;
    session_id: string;
    app_version: string;
    build_commit: string;
    platform: BetaPlatform;
    os_version: string;
    arch: string;
    cpu_model_class: string;
    cpu_cores: number;
    ram_gb_bucket: RamBucket;
    gpu_vendor: string;
    gpu_renderer: string;
    gpu_driver: string;
    gpu_accel: boolean;
    displays: number;
    max_scale_factor: number;
    audio_inputs: number;
    audio_outputs: number;
    audio_api: AudioApi;
    webcam_count: number;
    network_type: NetworkType;
    locale_lang: string;
    electron: string;
    chrome: string;
}

export type CallType = 'dm' | 'group' | 'channel';
export type DurationBucket = 0 | 30 | 60 | 300 | 900 | 1800 | 3600 | 7200;
export type CallTransport = 'udp' | 'tcp' | 'turn_udp' | 'turn_tcp' | 'unknown';
export type CallEndReason = 'user' | 'remote' | 'dropped' | 'error' | 'kicked' | 'shutdown';
export const RATING_TAGS = [
    'echo', 'robotic', 'cut_out', 'one_way', 'lag', 'video_frozen', 'video_blurry',
    'share_problem', 'too_quiet', 'too_loud', 'other',
] as const;
export type RatingTag = (typeof RATING_TAGS)[number];

export interface BetaCallSummaryBody {
    schema: typeof BETA_SCHEMA;
    /** uuid generated client-side; a rating arrives later under the same id (server upserts). */
    call_summary_id: string;
    session_id: string;
    app_version: string;
    platform: BetaPlatform;
    call_type: CallType;
    /** Lower bound of the bucket, seconds; 7200 means 7200+. */
    duration_s_bucket: DurationBucket;
    peers_max: number;
    e2ee: boolean;
    audio_codec: string;
    video_codec?: string;
    sent_video: boolean;
    screen_share: boolean;
    transport: CallTransport;
    rtt_ms_p50: number;
    rtt_ms_p95: number;
    jitter_ms_p95: number;
    loss_pct_p50: number;
    loss_pct_p95: number;
    video_freezes: number;
    fps_p50?: number;
    cpu_limited_s: number;
    bw_limited_s: number;
    reconnects: number;
    e2ee_errors: number;
    time_to_first_audio_ms?: number;
    end_reason: CallEndReason;
    rating?: 1 | 2 | 3 | 4 | 5;
    rating_tags?: RatingTag[];
}

/** A rating that arrives after its summary was sent: same route, same id, no metric fields. */
export interface BetaCallRatingBody {
    schema: typeof BETA_SCHEMA;
    call_summary_id: string;
    session_id: string;
    app_version: string;
    platform: BetaPlatform;
    rating: 1 | 2 | 3 | 4 | 5;
    rating_tags?: RatingTag[];
}
