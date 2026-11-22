/**
 * Two call events a call-audio report could not do without (report bc9aa8dc, 2026-11-18: "Microphone sounds robot to
 * friend").
 *
 * 1. `voice_settings` - the voice settings IN FORCE during the call. A report's `settings` block is read when the report
 *    is sent, and a user who "doesn't know what to change" changes things first: bc9aa8dc's snapshot said AGC off and mic
 *    volume 200 %, while every mic_level window of the call logged AGC gain +13..+32 dB and mic_gain_db 0 (slider at
 *    100 %), and its NS-stage levels read like Strong's +3.5 dB make-up while the snapshot said Light. Logged when the
 *    call's mic is bound (`reason: join`) and after each change during the call (`reason: change`, debounced so a slider
 *    drag is one entry). Enums, booleans and the two numbers the user set; nothing else.
 *
 * 2. `mic_capture` - what the capture device actually delivers: the rate and channel count Chromium opened it at, its
 *    reported latency, the browser processing flags it really applied, and the kind of device (`bus`). A Bluetooth
 *    headset's microphone runs in the hands-free profile at 8-16 kHz, which is the textbook "robot voice"; a virtual
 *    device (voice changer / mixer / another noise suppressor) stacks its own processing in front of ours. The bus is an
 *    enum derived on-device from the device's name; the name itself never leaves this function.
 *
 * Both are pinned (callEventLog PINNED_KINDS), so a long call keeps its join-time entries.
 */
import { logCallEvent } from './callEventLog';
import type { VoiceSettings } from '../hooks/useVoiceSettings';

export type MicBus = 'bluetooth' | 'virtual' | 'usb' | 'builtin' | 'unknown';

// Order matters: a virtual device that names a headset is still virtual; a Bluetooth headset's hands-free endpoint is
// Bluetooth even when the product name also matches the USB list.
const VIRTUAL_RE = /voicemeeter|vb-?audio|virtual|\bcable (output|input)\b|nvidia broadcast|\brtx voice\b|krisp|\bsonar\b|voicemod|\bobs\b|elgato wave link|wave link|steam streaming|nahimic mirroring|\bloopback\b/i;
const BLUETOOTH_RE = /bluetooth|hands[- ]?free|\bhfp\b|\bag audio\b|airpods|\bbuds\b|wh-1000|wf-1000|\bjabra\b.*\b(evolve2? 65|elite)\b/i;
const USB_RE = /\busb\b|yeti|snowball|quadcast|seiren|at2020|fifine|\bshure\b|\brode\b|\bnt-usb\b|\belgato wave\b|\bsamson\b|\bmaono\b|\bblue\b|\bscarlett\b|focusrite|\bmotu\b|\bgoxlr\b|\bwebcam\b|\bc9[0-9]{2}\b|\bbrio\b|\bstreamcam\b/i;
const BUILTIN_RE = /realtek|high definition audio|\bhd audio\b|microphone array|\barray\b|internal|built-?in|smart sound|\bconexant\b|\bidt\b|\bcirrus\b|\bmacbook\b|\bimac\b/i;

/** The kind of capture device, from its name. Pure; the name is not kept. */
export function classifyMicBus(deviceName: string | null | undefined): MicBus {
    const s = (deviceName ?? '').replace(/^\s*(default|communications)\s*-\s*/i, '').trim();
    if (!s) return 'unknown';
    if (VIRTUAL_RE.test(s)) return 'virtual';
    if (BLUETOOTH_RE.test(s)) return 'bluetooth';
    if (USB_RE.test(s)) return 'usb';
    if (BUILTIN_RE.test(s)) return 'builtin';
    return 'unknown';
}

export interface MicCaptureFacts {
    /** Hz, as Chromium reports the capture (0 = not reported). */
    sampleRate: number;
    channels: number;
    /** ms (getSettings().latency is in seconds). */
    latencyMs: number;
    bus: MicBus;
    /** The browser processing actually applied (true / false; null = not reported). */
    osEc: boolean | null; osAgc: boolean | null; osNs: boolean | null;
}

interface CaptureLike {
    getSettings: () => MediaTrackSettings;
}

/** Facts about the RAW capture track (not the processor's output). Pure apart from the getSettings() read. */
export function micCaptureFacts(track: CaptureLike & { label?: string }): MicCaptureFacts {
    let st: MediaTrackSettings & { latency?: number } = {};
    try { st = track.getSettings() ?? {}; } catch { /* a stopped track */ }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
    return {
        sampleRate: num(st.sampleRate),
        channels: num(st.channelCount),
        latencyMs: Math.round(num(st.latency) * 1000 * 10) / 10,
        bus: classifyMicBus(typeof track.label === 'string' ? track.label : ''),
        osEc: bool(st.echoCancellation), osAgc: bool(st.autoGainControl), osNs: bool(st.noiseSuppression),
    };
}

/** Log `mic_capture` for the call's raw capture track (null-safe). Repeats within 2 s coalesce in the ring. */
export function logMicCapture(track: (CaptureLike & { label?: string }) | null | undefined): void {
    if (!track) return;
    const f = micCaptureFacts(track);
    const ecFlag = f.osEc === null ? 'na' : f.osEc ? 'on' : 'off';
    const agcFlag = f.osAgc === null ? 'na' : f.osAgc ? 'on' : 'off';
    const nsFlag = f.osNs === null ? 'na' : f.osNs ? 'on' : 'off';
    logCallEvent('mic_capture', { sample_rate: f.sampleRate, channels: f.channels, lat_ms: f.latencyMs, bus: f.bus, os_ec: ecFlag, os_agc: agcFlag, os_ns: nsFlag });
}

export interface VoiceSettingsDetail {
    ns: 'off' | 'light' | 'strong';
    gate: boolean;
    thrDb: number;
    agc: boolean;
    ec: boolean;
    ecAuto: boolean;
    micPct: number;
    eq: boolean;
    ptt: boolean;
    /** 'v2' = the new audio engine (always, now); absent only for entries of the old legacy chain. `gate` / `thrDb` are then the manual noise gate. */
    engine?: 'v2';
}

/** The send-side voice settings as logged. Pure. */
export function voiceSettingsDetail(s: VoiceSettings): VoiceSettingsDetail {
    return {
        ns: !s.noiseSuppression ? 'off' : s.noiseSuppressionMode === 'light' ? 'light' : 'strong',
        gate: s.audioEngine === 'v2' ? s.voiceGateManual === true : !!s.voiceGate,
        thrDb: Math.round(Number(s.audioEngine === 'v2' ? s.voiceGateManualDb : s.voiceGateThreshold) || 0),
        agc: !!s.volumeNormalization,
        ec: !!s.echoCancellation,
        ecAuto: !!s.echoCancellationAuto,
        micPct: Math.round(Number(s.micVolume) || 0),
        eq: !!s.eqEnabled,
        ptt: !!s.pushToTalk,
        ...(s.audioEngine === 'v2' ? { engine: 'v2' as const } : {}),
    };
}

/** Debounce for `reason: change` (a slider drag settles into one entry). */
export const VOICE_SETTINGS_SETTLE_MS = 1500;

/**
 * `voice_settings` for one call: `join` logs at once; `change` logs once the settings have been stable for
 * VOICE_SETTINGS_SETTLE_MS and only if they differ from the last entry. `reset` at call end drops a pending entry.
 */
export class VoiceSettingsLogger {
    private last = '';
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending: VoiceSettingsDetail | null = null;

    join(s: VoiceSettings): void {
        this.cancel();
        this.write(voiceSettingsDetail(s), 'join');
    }

    change(s: VoiceSettings): void {
        if (!this.last) return; // not in a call (no join yet)
        const d = voiceSettingsDetail(s);
        if (JSON.stringify(d) === this.last) { this.cancel(); return; }
        this.pending = d;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            const p = this.pending;
            this.pending = null;
            if (p && JSON.stringify(p) !== this.last) this.write(p, 'change');
        }, VOICE_SETTINGS_SETTLE_MS);
    }

    reset(): void {
        this.cancel();
        this.last = '';
    }

    private cancel(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.pending = null;
    }

    private write(d: VoiceSettingsDetail, reasonValue: 'join' | 'change'): void {
        this.last = JSON.stringify(d);
        logCallEvent('voice_settings', { reason: reasonValue, ns: d.ns, gate: d.gate, thr_db: d.thrDb, agc: d.agc, aec_on: d.ec, ec_auto: d.ecAuto, mic_pct: d.micPct, eq: d.eq, ptt: d.ptt, ...(d.engine ? { engine: d.engine } : {}) });
    }
}
