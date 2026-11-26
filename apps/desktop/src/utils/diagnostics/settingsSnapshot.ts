/**
 * Issue-relevant settings for a diagnostic report — SCALARS ONLY, grouped so
 * the builder can pick the groups each category needs (bundle.ts
 * CATEGORY_SPEC).
 *
 * Pure: the caller hands in what it already read (voice settings, notification
 * prefs, the screen-share session, startup flags, the device list). What is
 * deliberately turned into a count or an enum rather than copied:
 *   • media devices → how many of each kind, and whether the chosen one is the
 *     system default. Never a label ("Dawson's AirPods") or a device id.
 *   • notification keywords / custom sounds → counts. Never the words or the
 *     file paths.
 *   • the capture-timing log → on/off. Never its path.
 *   • the screen-share source → screen or window. Never its title or id.
 */
import type { SettingsSnapshot, SettingsValue } from './bundle';
import { holdKeyKind, holdKeyReportName } from '../holdKeys';

export interface VoiceSettingsLike {
    noiseSuppression?: boolean; noiseSuppressionMode?: string; audioEngine?: string; echoCancellation?: boolean; volumeNormalization?: boolean; voiceGate?: boolean; voiceGateThreshold?: number; voiceGateManual?: boolean; voiceGateManualDb?: number;
    pushToTalk?: boolean; pushToTalkKey?: string | null; pushToMuteKey?: string | null; micDeviceId?: string; speakerDeviceId?: string; cameraDeviceId?: string;
    micVolume?: number; speakerVolume?: number; eqEnabled?: boolean;
    cameraBrightness?: number; cameraContrast?: number; cameraSaturation?: number;
}

export interface NotificationPrefsLike {
    desktop_notifications_enabled?: boolean; sounds_enabled?: boolean; master_volume?: number;
    show_preview?: string; quick_reply_enabled?: boolean; keywords?: unknown[]; dnd_manual?: boolean;
    dnd_schedule?: { enabled?: boolean };
    dnd_auto?: Record<string, unknown>;
    dnd_let_mentions_through?: boolean; custom_sounds?: unknown[];
    suppress_when_active_conv?: boolean; suppress_when_window_focused?: boolean;
    show_badge_count?: boolean; flash_taskbar?: boolean; badge_only_mentions?: boolean; badge_includes_muted?: boolean;
}

export interface ShareSessionLike {
    requestedFps?: number; captureFps?: number; resolution?: string;
    codecPref?: string; codec?: string; h264Profile?: string;
    hw?: { h264?: boolean; h264High?: boolean; vp9?: boolean; vp8?: boolean } | null;
    main?: {
        sourceKind?: string; displayHz?: number | null; capturer?: { backend?: string };
        capturerPref?: string; videoEncode?: string | null; h264CbpHwEnabled?: boolean; captureLog?: boolean;
    } | null;
}

export interface DeviceInfoLike { kind: string; deviceId?: string }

/** How push-to-talk / push-to-mute are delivered on this machine (main's hold-key:diagnostics + dry runs). */
export interface HoldKeyReportLike {
    /** win32 | x11 | portal | none */
    backend?: string;
    nativeWatcher?: boolean;
    /** The Windows elevated-foreground check exists in this build. */
    elevationCheck?: boolean;
    /** The focused window was an elevated program hiding key state from us, at report time. */
    foregroundBlocked?: boolean;
    /** Last game window seen while a watch ran: 'yes' (confirmed admin) / 'no' / 'unknown' (Windows hid it). */
    adminGame?: string | null;
    /** Per slot: 'ok' or 'focused-only' + reason, and whether that came from a live watch or a dry run. */
    pushToTalk?: { status?: string; reason?: string; live?: boolean } | null;
    pushToMute?: { status?: string; reason?: string; live?: boolean } | null;
}

export interface SettingsSources {
    hardwareAcceleration?: boolean;
    reducedMotion?: boolean;
    voice?: VoiceSettingsLike | null;
    notifications?: NotificationPrefsLike | null;
    /** Notification.permission, or 'unsupported'. */
    notificationPermission?: string;
    screenShareCodecPref?: string;
    streamStatsHud?: boolean;
    shareSession?: ShareSessionLike | null;
    startupFlags?: { active?: { screenCapturer?: string; captureLog?: boolean } } | null;
    devices?: readonly DeviceInfoLike[] | null;
    /**
     * This device's encrypted store: did it load? Labels only (utils/storeHealthReport.ts
     * — a status word, `<stage>_<ErrorName>`, a count). In every category's report,
     * because a store that did not load explains "my history is gone" in any of them.
     */
    storage?: { status?: string; failure?: string; attempts?: number; recovered?: boolean; unreadable?: number } | null;
    /**
     * The last backup / restore / repair outcome as labels (utils/backupDiagnostics.ts: step, error
     * name, reason code, a count). In every category's report, because "my backup won't run" is filed
     * as anything.
     */
    backup?: Record<string, string | number | boolean> | null;
    /**
     * Push-to-talk delivery (in every category's report: "I can't talk in my game" is
     * filed as anything). The key is reported as its kind and its token name
     * ("numpad1", "mouse4", "ctrl_shift_keyv"), never anything typed.
     */
    holdKeys?: HoldKeyReportLike | null;
}

const ENUM_RE = /^[a-z0-9_-]{1,32}$/i;
const en = (v: unknown): string | null => (typeof v === 'string' && ENUM_RE.test(v) ? v : null);
const b = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
/** '' / 'default' → 'default'; anything else → 'selected'. Never the id. */
const chosen = (id: unknown): string => (typeof id !== 'string' || id === '' || id === 'default' ? 'default' : 'selected');

function compact(o: Record<string, SettingsValue>): Record<string, SettingsValue> {
    const out: Record<string, SettingsValue> = {};
    for (const [k, v] of Object.entries(o)) if (v !== null) out[k] = v;
    return out;
}

/** The push-to-talk keys of a report's `general` group. Scalars only; null-valued keys are dropped by compact(). */
export function holdKeyFields(v: VoiceSettingsLike | null, h: HoldKeyReportLike | null): Record<string, SettingsValue> {
    const slot = (x: HoldKeyReportLike['pushToTalk']) => x ? {
        status: en(x.status), reason: en(x.reason), live: b(x.live),
    } : { status: null, reason: null, live: null };
    const ptt = slot(h?.pushToTalk);
    const ptm = slot(h?.pushToMute);
    return {
        ptt_enabled: b(v?.pushToTalk),
        ptt_key_kind: v ? holdKeyKind(v.pushToTalkKey) : null,
        ptt_key: v ? en(holdKeyReportName(v.pushToTalkKey)) : null,
        ptm_key_kind: v ? holdKeyKind(v.pushToMuteKey) : null,
        ptm_key: v ? en(holdKeyReportName(v.pushToMuteKey)) : null,
        ptt_backend: en(h?.backend),
        ptt_native_watcher: b(h?.nativeWatcher),
        ptt_watcher: ptt.status,
        ptt_watcher_reason: ptt.reason,
        ptt_watcher_live: ptt.live,
        ptm_watcher: ptm.status,
        ptm_watcher_reason: ptm.reason,
        ptt_elevation_check: b(h?.elevationCheck),
        ptt_foreground_elevated: b(h?.foregroundBlocked),
        ptt_admin_game: en(h?.adminGame),
    };
}

/** The `backup_last_*` / `restore_last_*` / `repair_last_*` keys, re-validated (labels, short, no free text). */
const BACKUP_KEY_RE = /^(?:backup|restore|repair)_last_(?:ok|step|error|reason|dest|held|age_h)$/;
function backupFields(src: Record<string, string | number | boolean> | null): Record<string, SettingsValue> {
    const out: Record<string, SettingsValue> = {};
    if (!src) return out;
    for (const [k, v] of Object.entries(src)) {
        if (!BACKUP_KEY_RE.test(k)) continue;
        if (typeof v === 'boolean') out[k] = v;
        else if (typeof v === 'number') out[k] = n(v);
        else out[k] = /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : null;
    }
    return out;
}

export function buildSettingsSnapshot(s: SettingsSources): SettingsSnapshot {
    const devs = s.devices ?? null;
    const count = (kind: string) => (devs ? devs.filter(d => d.kind === kind).length : null);
    const v = s.voice ?? null;
    const sess = s.shareSession ?? null;
    const np = s.notifications ?? null;

    const general = compact({
        hardware_acceleration: b(s.hardwareAcceleration),
        reduced_motion: b(s.reducedMotion),
        storage_status: en(s.storage?.status),
        storage_load_failure: en(s.storage?.failure),
        storage_load_attempts: n(s.storage?.attempts),
        storage_load_recovered: b(s.storage?.recovered),
        storage_unreadable_records: n(s.storage?.unreadable),
        ...backupFields(s.backup ?? null),
        ...holdKeyFields(v, s.holdKeys ?? null),
    });

    const screen_share = compact({
        screen_share_codec: en(s.screenShareCodecPref),
        stream_stats_hud: b(s.streamStatsHud),
        screen_capturer: en(s.startupFlags?.active?.screenCapturer),
        capture_timing_log: b(s.startupFlags?.active?.captureLog),
        ...(sess ? {
            screen_share_fps: n(sess.requestedFps),
            screen_share_capture_request_fps: n(sess.captureFps),
            screen_share_resolution: en(sess.resolution),
            screen_share_codec_used: en(sess.codec),
            screen_share_h264_profile: en(sess.h264Profile),
            screen_share_source_kind: en(sess.main?.sourceKind),
            captured_display_hz: n(sess.main?.displayHz),
            capture_backend: en(sess.main?.capturer?.backend),
            gpu_video_encode: en(sess.main?.videoEncode),
            h264_cbp_hw_enabled: b(sess.main?.h264CbpHwEnabled),
            hw_encoder_h264: b(sess.hw?.h264),
            hw_encoder_h264_high: b(sess.hw?.h264High),
            hw_encoder_vp9: b(sess.hw?.vp9),
            hw_encoder_vp8: b(sess.hw?.vp8),
        } : {}),
    });

    const call = compact({
        noise_suppression: b(v?.noiseSuppression),
        noise_suppression_mode: en(v?.noiseSuppressionMode),
        audio_engine: en(v?.audioEngine),
        echo_cancellation: b(v?.echoCancellation),
        volume_normalization: b(v?.volumeNormalization),
        // The manual noise gate under the new engine (the only engine); the old automatic gate's keys otherwise.
        voice_gate: b(v?.audioEngine === 'v2' ? v?.voiceGateManual === true : v?.voiceGate),
        voice_gate_threshold_db: n(v?.audioEngine === 'v2' ? v?.voiceGateManualDb : v?.voiceGateThreshold),
        push_to_talk: b(v?.pushToTalk),
        mic_volume: n(v?.micVolume),
        speaker_volume: n(v?.speakerVolume),
        eq_enabled: b(v?.eqEnabled),
        mic_device: v ? chosen(v.micDeviceId) : null,
        speaker_device: v ? chosen(v.speakerDeviceId) : null,
        audio_input_devices: count('audioinput'),
        audio_output_devices: count('audiooutput'),
    });

    const camera = compact({
        camera_device: v ? chosen(v.cameraDeviceId) : null,
        video_input_devices: count('videoinput'),
        camera_brightness: n(v?.cameraBrightness),
        camera_contrast: n(v?.cameraContrast),
        camera_saturation: n(v?.cameraSaturation),
    });

    const auto = np?.dnd_auto ?? {};
    const notifications = compact({
        os_notification_permission: en(s.notificationPermission),
        desktop_notifications: b(np?.desktop_notifications_enabled),
        sounds: b(np?.sounds_enabled),
        master_volume: n(np?.master_volume),
        show_preview: en(np?.show_preview),
        quick_reply: b(np?.quick_reply_enabled),
        keyword_count: Array.isArray(np?.keywords) ? np!.keywords!.length : null,
        custom_sound_count: Array.isArray(np?.custom_sounds) ? np!.custom_sounds!.length : null,
        dnd_manual: b(np?.dnd_manual),
        dnd_schedule: b(np?.dnd_schedule?.enabled),
        dnd_auto_in_call: b(auto.when_in_call),
        dnd_auto_screensharing: b(auto.when_screensharing),
        dnd_auto_in_game: b(auto.when_in_game),
        dnd_auto_status_dnd: b(auto.when_status_dnd),
        dnd_auto_status_away: b(auto.when_status_away),
        dnd_let_mentions_through: b(np?.dnd_let_mentions_through),
        suppress_when_active_conv: b(np?.suppress_when_active_conv),
        suppress_when_window_focused: b(np?.suppress_when_window_focused),
        show_badge_count: b(np?.show_badge_count),
        flash_taskbar: b(np?.flash_taskbar),
        badge_only_mentions: b(np?.badge_only_mentions),
        badge_includes_muted: b(np?.badge_includes_muted),
    });

    return { general, screen_share, call, camera, notifications };
}
