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

export interface VoiceSettingsLike {
    noiseSuppression?: boolean; volumeNormalization?: boolean; voiceGate?: boolean; voiceGateThreshold?: number;
    pushToTalk?: boolean; micDeviceId?: string; speakerDeviceId?: string; cameraDeviceId?: string;
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

export function buildSettingsSnapshot(s: SettingsSources): SettingsSnapshot {
    const devs = s.devices ?? null;
    const count = (kind: string) => (devs ? devs.filter(d => d.kind === kind).length : null);
    const v = s.voice ?? null;
    const sess = s.shareSession ?? null;
    const np = s.notifications ?? null;

    const general = compact({
        hardware_acceleration: b(s.hardwareAcceleration),
        reduced_motion: b(s.reducedMotion),
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
        volume_normalization: b(v?.volumeNormalization),
        voice_gate: b(v?.voiceGate),
        voice_gate_threshold_db: n(v?.voiceGateThreshold),
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
