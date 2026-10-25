import React, { useRef, useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { Volume2, Headphones, Video, VideoOff, SlidersHorizontal, AudioLines } from 'lucide-react';
import { eventToCombo, formatCombo } from '../hooks/useKeybinds';
import {
    DEFAULT_VOICE_SETTINGS,
    MIC_VOLUME_MAX,
    SPEAKER_VOLUME_MAX,
    type VoiceSettings,
    type VoiceSettingsHook,
} from '../hooks/useVoiceSettings';
import { MAX_VOLUME_PERCENT } from '../utils/volumeLimits';
import { VolumeCeilingWatch } from './moments/VolumeCeilingWatch';
import { useMediaDevices, deviceLabel } from '../hooks/useMediaDevices';
import { CipherlineVoiceProcessor } from '../utils/voiceProcessor';
import { ClSlider } from './ClSlider';
import { useSliderResetHint } from './sliderReset';
import {
    DEFAULT_AUDIO_INPUT_ID,
    hasRealDeviceInfo,
    micCaptureConstraints,
    micDeviceConstraint,
    pickMicDeviceId,
    resolveEchoCancellation,
} from '../utils/audioInput';
import { findStoredDevice, type DeviceHint } from '../utils/deviceResolve';
import { GATE_METER_REPORT_MS } from '../utils/voiceChain';
import { setMasterVolume } from '../hooks/useParticipantAudio';
import { registerOutputAudioContext, unregisterOutputAudioContext } from '../utils/audioOutput';
import { testSpeakers, DEFAULT_SOUNDS } from '../utils/notificationSounds';
import { describeSpeakerTest } from '../utils/speakerTestSummary';
import { subscribe as subscribeAudioHealth, getSnapshot as getAudioHealthSnapshot } from '../utils/audioHealth';
import { ClToggle, ClButton, ClSelect } from './cl';
import { NoiseSuppressionEngine, NoiseSuppressionInfo } from './NoiseSuppressionEngine';
import type { ClSelectOption } from './cl';
import { useCameraQualityTier, setCameraQualityTier, useIncomingVideoMode, setIncomingVideoMode } from '../utils/cameraQualityPrefs';
import type { IncomingVideoMode } from '../utils/remoteVideoQuality';
import { CAMERA_QUALITY_TIERS, tierLabel, type CameraQualityTier } from '../utils/cameraQuality';
import { openCameraPreview, describeCameraPreviewError, shouldReopenPreview } from '../utils/cameraPreview';

const CAMERA_TIER_OPTIONS: ClSelectOption<CameraQualityTier>[] = CAMERA_QUALITY_TIERS.map(t => ({ value: t, label: tierLabel(t) }));
const INCOMING_MODE_OPTIONS: ClSelectOption<IncomingVideoMode>[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'reduced', label: 'Reduced' },
    { value: 'datasaver', label: 'Data saver' },
];
const INCOMING_MODE_HELP: Record<IncomingVideoMode, string> = {
    auto: 'Other people’s cameras sharpen with the size you show them at, and drop in quality when lots of cameras are on.',
    reduced: 'Easier on your PC: other cameras in low quality (the one speaking a little sharper), at most 9 decoded at once — the rest show their avatar until they talk. A camera you focus stays sharp.',
    datasaver: 'For metered connections: every camera in low quality, a focused one in medium, at most 9 at once, and screen shares capped at 30 fps where the sharer allows it.',
};
import { useEscape } from '../hooks/useEscape';
import { GamingVideoSetting } from './settings/GamingVideoSetting';
import { SettingsDisclosure } from './settings/SettingsDisclosure';
import { VvRow as Row } from './settings/VvRow';
import { AudioDeviceList } from './settings/AudioDeviceList';
import { requestAudioDeviceResync, type ActiveAudioDevice } from '../hooks/useAudioDeviceProfiles';

/**
 * Twilight · Voice & Video. The two device cards first (Input, Output — where
 * they were before the redesign), then Voice processing, the remembered audio
 * devices, Video. Every setting is one row of the same shape: the name (and an
 * "i" with the longer explanation) on the left, the control on the right,
 * switches always on the far right. Only expert tuning folds away (mic EQ +
 * audio health, picture adjustments). The Input, Voice processing and Output
 * cards say which device their settings are being saved for — they are
 * remembered per device (hooks/useAudioDeviceProfiles.ts).
 */
interface VoiceVideoSettingsProps {
    voice: VoiceSettingsHook;
}

/** Shown under Echo cancellation, not only behind its "i". */
const ECHO_NOTE = 'Only recommended when using speakers — leave it off with headphones.';

// ── Volume Slider (0-200%) ────────────────────────────────────────────────────

const VolumeSlider: React.FC<{
    value: number;
    onChange: (v: number) => void;
    resetValue: number;
    max?: number;
}> = ({ value, onChange, resetValue, max = MAX_VOLUME_PERCENT }) => (
    <>
        <VolumeCeilingWatch>
            <ClSlider
                min={0}
                max={max}
                step={1}
                value={value}
                onChange={onChange}
                resetValue={resetValue}
                formatLabel={v => `${v}%`}
                style={{ flex: 1, minWidth: 0 }}
            />
        </VolumeCeilingWatch>
        <span className="vv-val">{value}%</span>
    </>
);

// ── Live VU bar — lume fill that warms toward glow when you get loud ─────────

const VuMeter: React.FC<{ level: number }> = ({ level }) => {
    const pct = isFinite(level) ? Math.min(Math.max((level + 60) / 60 * 100, 0), 100) : 0;
    return (
        <div className={`sd-vu${level > -16 ? ' sd-hot' : ''}`} role="meter" aria-label="Microphone level" aria-valuenow={Math.round(pct)}>
            <i style={{ width: `${pct}%` }} />
        </div>
    );
};

// ── Gate Slider — live level bar built into slider track ──────────────────────

const GATE_DEFAULT_THRESHOLD = DEFAULT_VOICE_SETTINGS.voiceGateThreshold; // dBFS
const GATE_MIN = -60, GATE_MAX = -20;

/**
 * `level` is the gate's OWN detector — the loudest 128-sample block of each
 * 50 ms, measured where the gate measures it (after noise suppression, before
 * EQ / auto gain / mic volume) — and `open` is the gate's real state. It used
 * to be the end-of-chain level instead: shifted by AGC and mic volume, and
 * blank whenever the gate was closed, so with noise suppression off the room
 * noise could sit visibly under the thumb while the gate let it through.
 *
 * Inline in the Voice gate row: the track, then the threshold (lume while the
 * gate is open = you are transmitting). Arrow keys move it 1 dB, Home/End jump
 * to the ends; double-click resets.
 */
const GateSlider: React.FC<{
    threshold: number;
    level: number;
    open: boolean;
    onChange: (v: number) => void;
    disabled?: boolean;
}> = ({ threshold, level, open, onChange, disabled }) => {
    const trackRef = useRef<HTMLDivElement | null>(null);
    const dragging = useRef(false);
    const [grabbing, setGrabbing] = useState(false);
    const hint = useSliderResetHint(!disabled);
    const { anchorRef: hintAnchorRef } = hint;
    const setTrack = useCallback((node: HTMLDivElement | null) => {
        trackRef.current = node;
        hintAnchorRef(node);
    }, [hintAnchorRef]);

    const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
    const dbToPercent = (db: number) => clamp((db + 60) / 40 * 100, 0, 100);

    const levelPct = isFinite(level) ? dbToPercent(level) : 0;
    const thumbPct = dbToPercent(threshold);

    // Live-meter color on the kit's own palette: flash when hot, glow when
    // warm, ok while speaking, near-invisible at the noise floor.
    const levelColor = level > -16
        ? 'var(--cl-flash)'
        : level > -28
        ? 'var(--cl-glow)'
        : level > -54
        ? 'var(--cl-ok)'
        : 'rgba(255,255,255,0.08)';

    const getDbFromEvent = useCallback((e: React.PointerEvent | PointerEvent) => {
        if (!trackRef.current) return threshold;
        const rect = trackRef.current.getBoundingClientRect();
        const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        return Math.round(pct * 40 - 60);
    }, [threshold]);

    const onPointerDown = (e: React.PointerEvent) => {
        hint.closeHint();
        if (disabled) return;
        dragging.current = true;
        setGrabbing(true);
        (e.target as Element).setPointerCapture(e.pointerId);
        onChange(getDbFromEvent(e));
    };
    const onPointerMove = (e: React.PointerEvent) => {
        if (!dragging.current || disabled) return;
        onChange(getDbFromEvent(e));
    };
    const onPointerUp = () => { dragging.current = false; setGrabbing(false); };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (disabled) return;
        const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1
            : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
        if (step) { onChange(clamp(threshold + step, GATE_MIN, GATE_MAX)); e.preventDefault(); return; }
        if (e.key === 'Home') { onChange(GATE_MIN); e.preventDefault(); }
        if (e.key === 'End') { onChange(GATE_MAX); e.preventDefault(); }
    };

    return (
        <>
            {/* Kit slider chrome (.cls/.strk/.sfill/.sthw) — the fill is the LIVE
                mic level rather than the value, so the meter stays built into the
                track; the thumb marks the threshold. */}
            <span className="cl-kit" style={{ display: 'contents' }}>
                <div
                    ref={setTrack}
                    {...hint.handlers}
                    aria-describedby={hint.describedBy}
                    className={`cls vv-gate${grabbing ? ' grab' : ''}${disabled ? ' vv-off' : ''} select-none`}
                    role="slider"
                    tabIndex={disabled ? -1 : 0}
                    aria-label="Activity threshold"
                    aria-valuemin={GATE_MIN}
                    aria-valuemax={GATE_MAX}
                    aria-valuenow={threshold}
                    aria-valuetext={`${threshold} dBFS${disabled ? '' : open ? ', transmitting' : ', gated'}`}
                    aria-disabled={disabled || undefined}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onKeyDown={onKeyDown}
                    onDoubleClick={() => { if (!disabled) onChange(GATE_DEFAULT_THRESHOLD); }}
                >
                    <span className="sbody">
                        <span className="strk" />
                        <span
                            className="sfill"
                            style={{ width: `${levelPct}%`, background: levelColor, transition: 'width 75ms linear, background-color .2s' }}
                        />
                        <span className="sthw" style={{ left: `${thumbPct}%` }}>
                            <span className="ssh" />
                            <span className="sth" />
                        </span>
                        <span className="sbub" style={{ left: `${thumbPct}%` }}>{threshold} dBFS</span>
                    </span>
                </div>
                {hint.tip}
            </span>
            {/* the dot is the gate's live state: green while you are transmitting */}
            <span
                className={`vv-val vv-gateval${!disabled && open ? ' vv-live' : ''}`}
                title={disabled ? undefined : open ? 'Transmitting' : 'Gated'}
            >
                {!disabled && <i className="vv-dot" aria-hidden="true" />}
                {threshold} dB
            </span>
        </>
    );
};

// ── PTT Keybind Recorder ──────────────────────────────────────────────────────

const PttKeybind: React.FC<{
    value: string | null;
    onSet: (v: string | null) => void;
}> = ({ value, onSet }) => {
    const [recording, setRecording] = useState(false);

    useEffect(() => {
        if (!recording) return;
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            // Escape (any modifiers) is handled entirely by the useEscape
            // layer below — unlike KeybindSettings' recorder, Escape is never
            // itself a bindable PTT key here, so there is no combo case to
            // fall through to.
            if (e.key === 'Escape') return;
            const combo = eventToCombo(e);
            if (combo) { onSet(combo); setRecording(false); }
        };
        window.addEventListener('keydown', onKey, { capture: true });
        return () => window.removeEventListener('keydown', onKey, { capture: true });
    }, [recording, onSet]);

    // Escape cancels the capture through the shared stack — the same
    // ordering guarantee as KeybindSettings' recorder (see its comment):
    // this layer, pushed while `recording`, wins over any host settings
    // panel's own Escape-to-close beneath it.
    useEscape(() => setRecording(false), recording);

    return (
        <div className="flex items-center gap-1.5">
            {value && !recording && (
                <ClButton
                    icon
                    variant="ghost"
                    size="sm"
                    onClick={() => onSet(null)}
                    tooltip="Clear keybind"
                >
                    ×
                </ClButton>
            )}
            <button
                type="button"
                onClick={() => setRecording(r => !r)}
                className={`sd-kbd vv-kbd${recording ? ' sd-rec' : ''}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                title={recording ? 'Press a key combo — Esc cancels' : 'Click to rebind'}
                aria-label={recording ? 'Recording push to talk key, press a key combo, Escape cancels' : value ? `Push to talk key: ${formatCombo(value)}. Click to change` : 'Set push to talk key'}
            >
                {recording ? (
                    <i>Press keys…</i>
                ) : value ? (
                    formatCombo(value).split(' + ').map((k, i) => <i key={i}>{k}</i>)
                ) : (
                    <i className="vv-kbd-empty">Set keybind</i>
                )}
            </button>
        </div>
    );
};

// ── Camera Preview ────────────────────────────────────────────────────────────

interface CameraPreviewProps {
    deviceId: string;
    brightness: number;
    contrast: number;
    saturation: number;
}

const CameraPreview: React.FC<CameraPreviewProps> = ({ deviceId, brightness, contrast, saturation }) => {
    const videoRef  = useRef<HTMLVideoElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [err, setErr] = useState<string | null>(null);
    // The stored pick is not plugged in, so the default camera is showing.
    const [fellBack, setFellBack] = useState(false);
    // Bumped to reopen the preview when the hardware changed under it.
    const [reopenTick, setReopenTick] = useState(0);
    // Camera does NOT auto-start. The user has to opt in explicitly so opening
    // the settings tab never silently flips the webcam on.
    const [active, setActive] = useState(false);
    const fellBackRef = useRef(false);
    // The devicechange listener reads the CURRENT pick without resubscribing.
    const deviceIdRef = useRef(deviceId);
    useEffect(() => { deviceIdRef.current = deviceId; }, [deviceId]);

    // (Re)open the preview whenever the picked camera changes: stop the old
    // tracks FIRST, then open the new one with `{ exact }` (utils/cameraPreview.ts
    // — a bare id was only an `ideal`, and Chromium kept the first camera).
    useEffect(() => {
        if (!active) return;

        let cancelled = false;

        const stop = () => {
            streamRef.current?.getTracks().forEach(t => t.stop());
            streamRef.current = null;
            if (videoRef.current) videoRef.current.srcObject = null;
        };

        stop();
        setErr(null);

        openCameraPreview(deviceId, c => navigator.mediaDevices.getUserMedia(c)).then(({ stream, fellBackFrom }) => {
            if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
            streamRef.current = stream;
            fellBackRef.current = fellBackFrom !== null;
            setFellBack(fellBackFrom !== null);
            if (videoRef.current) videoRef.current.srcObject = stream;
            // The camera was unplugged / taken away under a running preview:
            // reopen, which lands on the default camera (or a clear error).
            stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => {
                if (!cancelled && streamRef.current === stream) setReopenTick(n => n + 1);
            }));
        }).catch(e => {
            if (!cancelled) setErr(describeCameraPreviewError(e));
        });

        return () => { cancelled = true; stop(); };
    }, [deviceId, active, reopenTick]);

    // A camera was plugged in or removed.
    useEffect(() => {
        if (!active) return;
        const onDeviceChange = async () => {
            try {
                const stream = streamRef.current;
                const track = stream?.getVideoTracks()[0];
                const available = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
                if (shouldReopenPreview({
                    stored: deviceIdRef.current,
                    openedId: track?.getSettings().deviceId ?? null,
                    trackLive: !!track && track.readyState === 'live',
                    fellBack: fellBackRef.current,
                    available,
                })) setReopenTick(n => n + 1);
            } catch { /* enumeration can fail pre-permission; the next change retries */ }
        };
        navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
        return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    }, [active]);

    useEffect(() => () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
    }, []);

    const cssFilter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;

    // One fixed 16:9 tile beside the camera rows, in every state, so turning
    // the preview on never reflows the pane. Off = no stream is open at all.
    if (!active) {
        return (
            <div className="vv-cam vv-cam--off">
                <VideoOff className="w-5 h-5" aria-hidden="true" />
                <ClButton size="sm" onClick={() => setActive(true)}>
                    <Video className="w-3.5 h-3.5" /> Preview
                </ClButton>
            </div>
        );
    }

    if (err) {
        return (
            <div className="vv-cam vv-cam--off">
                <span className="vv-cam-err" role="status">{err}</span>
                <ClButton variant="ghost" size="sm" onClick={() => { setErr(null); setActive(false); }}>Try again</ClButton>
            </div>
        );
    }

    return (
        <div className="vv-cam">
            <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover scale-x-[-1]"
                style={{ filter: cssFilter }}
            />
            {fellBack && (
                <span role="status" className="vv-cam-note">
                    Selected camera isn’t connected — showing the default
                </span>
            )}
            {/* Plain <button>, not ClButton — ClButton's `style` prop lands on
                the outer wrapper span, not the inner .cap that actually
                renders, so shrinking below the kit's default 46px (even with
                size="sm"'s 40px) silently failed. Sizing/position now live in
                .cl-video-preview-close-btn (index.css). */}
            <button
                type="button"
                onClick={() => setActive(false)}
                title="Turn off preview"
                aria-label="Turn off preview"
                className="cl-video-preview-close-btn"
            >
                <VideoOff className="w-3.5 h-3.5" />
            </button>
        </div>
    );
};

// ── Picture Slider ────────────────────────────────────────────────────────────

const PictureSlider: React.FC<{
    label: string;
    value: number;
    onChange: (v: number) => void;
    min?: number;
    max?: number;
    resetValue: number;
}> = ({ label, value, onChange, min = 0, max = 200, resetValue }) => (
    <Row label={label}>
        <ClSlider
            min={min}
            max={max}
            step={1}
            value={value}
            onChange={onChange}
            resetValue={resetValue}
            formatLabel={v => `${v}%`}
            style={{ flex: 1, minWidth: 0 }}
        />
        <span className="vv-val">{value}%</span>
    </Row>
);

// ── EQ Band Slider (vertical) ─────────────────────────────────────────────────

const EQ_BAND_DEFS = [
    { freq: 80,    label: '80' },
    { freq: 250,   label: '250' },
    { freq: 1000,  label: '1k' },
    { freq: 4000,  label: '4k' },
    { freq: 12000, label: '12k' },
] as const;

const EQ_MIN = -12, EQ_MAX = 12, EQ_TRACK_H = 96;
const EQ_BAND_DEFAULT_GAIN = DEFAULT_VOICE_SETTINGS.eqBands[0]; // every band defaults to 0 dB

/** One vertical band: inset rail, lume fill growing from the 0 dB midline,
 *  kit-style thumb that scales+glows while grabbed. Drag anywhere on the
 *  column; double-click snaps the band back to 0. */
const EqBand: React.FC<{
    def: { freq: number; label: string };
    gain: number;
    onChange: (v: number) => void;
}> = ({ def, gain, onChange }) => {
    const trackRef = useRef<HTMLDivElement | null>(null);
    const [grabbing, setGrabbing] = useState(false);
    const hint = useSliderResetHint(true);
    const { anchorRef: hintAnchorRef } = hint;
    const setTrack = useCallback((node: HTMLDivElement | null) => {
        trackRef.current = node;
        hintAnchorRef(node);
    }, [hintAnchorRef]);

    const gainToY = (g: number) => (1 - (g - EQ_MIN) / (EQ_MAX - EQ_MIN)) * EQ_TRACK_H;
    const fromEvent = (e: React.PointerEvent) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect) return;
        const ratio = 1 - Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
        const raw = EQ_MIN + ratio * (EQ_MAX - EQ_MIN);
        onChange(Math.round(raw * 2) / 2); // 0.5 dB steps
    };

    const thumbY = gainToY(gain);
    const midY = EQ_TRACK_H / 2;
    const fillTop = Math.min(thumbY, midY);
    const fillH = Math.abs(thumbY - midY);
    const label = gain === 0 ? '0' : gain > 0 ? `+${gain}` : `${gain}`;

    return (
        <div className={`sd-eq-band${gain !== 0 ? ' sd-active' : ''}`}>
            <span className="sd-eq-val">{label}</span>
            <div
                ref={setTrack}
                {...hint.handlers}
                aria-describedby={hint.describedBy}
                className={`sd-eq-track${grabbing ? ' sd-grab' : ''}`}
                role="slider"
                aria-label={`${def.label} Hz band`}
                aria-valuemin={EQ_MIN}
                aria-valuemax={EQ_MAX}
                aria-valuenow={gain}
                tabIndex={0}
                onPointerDown={e => { hint.closeHint(); setGrabbing(true); (e.target as Element).setPointerCapture(e.pointerId); fromEvent(e); }}
                onPointerMove={e => { if (grabbing) fromEvent(e); }}
                onPointerUp={() => setGrabbing(false)}
                onPointerCancel={() => setGrabbing(false)}
                onDoubleClick={() => onChange(EQ_BAND_DEFAULT_GAIN)}
                onKeyDown={e => {
                    if (e.key === 'ArrowUp') { onChange(Math.min(EQ_MAX, gain + 0.5)); e.preventDefault(); }
                    if (e.key === 'ArrowDown') { onChange(Math.max(EQ_MIN, gain - 0.5)); e.preventDefault(); }
                }}
            >
                <span className="sd-eq-rail" />
                <span className="sd-eq-mid" />
                {fillH > 0 && <span className="sd-eq-fill" style={{ top: fillTop, height: fillH }} />}
                <span className="sd-eq-thumb" style={{ top: thumbY }} />
            </div>
            {hint.tip}
            <span className="sd-eq-freq">{def.label}</span>
        </div>
    );
};

const EqBands: React.FC<{
    bands: number[];
    onChange: (index: number, value: number) => void;
    onReset: () => void;
    disabled?: boolean;
}> = ({ bands, onChange, onReset, disabled }) => (
    <div className={`sd-eq-wrap vv-eq${disabled ? ' sd-disabled' : ''}`}>
        <div className="sd-eq">
            {EQ_BAND_DEFS.map((def, i) => (
                <EqBand key={def.freq} def={def} gain={bands[i] ?? 0} onChange={v => onChange(i, v)} />
            ))}
        </div>
        <ClButton variant="ghost" size="sm" onClick={onReset}>Reset</ClButton>
    </div>
);

// ── Audio health (debug) ────────────────────────────────────────────────────
// Read-only diagnostics for the call-audio pipeline — underrun/auto-bypass
// counts and the currently-applied AGC gain, so a regression in the jitter
// buffer or AGC (see nsKernel.js / agcKernel.js) is visible instead of only
// inferable from "someone said it sounded bad." Reflects the most recent
// call this session (audioHealth resets its counters at the start of every
// CallPane mount — see CallPane.tsx); shows "no data yet" before any call.
// It lives in the folded "Mic EQ & audio health" group, so it no longer has a
// Show/Hide of its own (a fold inside a fold).
const AudioHealthPanel: React.FC = () => {
    const health = useSyncExternalStore(subscribeAudioHealth, getAudioHealthSnapshot);

    return (
        <Row label="Audio health" info="Live diagnostics for the last call's noise suppression and auto gain, for when someone says you sound off.">
            <div className="vv-health sd-mono">
                {health.lastUpdatedAt === null ? (
                    <div>No data yet — join a call to see live numbers.</div>
                ) : (
                    <>
                        <div>Noise suppression: {health.nsState}{health.nsAutoBypassActive ? ' (paused — high CPU)' : ''}</div>
                        <div>Underruns this call: {health.nsUnderruns}</div>
                        <div>Auto-bypass trips: {health.nsAutoBypassCount}</div>
                        {health.nsUnavailable && <div>NS pipeline unavailable this call</div>}
                        <div>
                            AGC gain: {health.agcGainDb === null ? 'n/a' : `${health.agcGainDb >= 0 ? '+' : ''}${health.agcGainDb.toFixed(1)} dB`}
                            {' '}({health.agcVoiceActive ? 'speech detected' : 'idle'})
                        </div>
                    </>
                )}
            </div>
        </Row>
    );
};

// ── "Saving for" — which device a card's settings are remembered for ────────

const SavingFor: React.FC<{ device: ActiveAudioDevice | null | undefined; kind: 'mic' | 'output' }> = ({ device, kind }) => {
    if (!device) return null;
    const what = kind === 'mic' ? 'microphone' : 'speaker or headset';
    return (
        <span
            className="vv-for"
            data-testid={`saving-for-${kind}`}
            title={`Changes here are remembered for this ${what}${device.viaDefault ? ' (your system default right now)' : ''}.`}
        >
            <span className="vv-for-k">Saving for</span>
            <b>{device.label}</b>
            {device.viaDefault && <span className="vv-for-d">default</span>}
        </span>
    );
};

// ── Device picks ──────────────────────────────────────────────────────────────

const micHintOf = (s: VoiceSettings): DeviceHint => ({ label: s.micDeviceLabel, groupId: s.micDeviceGroupId });
const speakerHintOf = (s: VoiceSettings): DeviceHint => ({ label: s.speakerDeviceLabel, groupId: s.speakerDeviceGroupId });

/** The device id the mic test should open for the stored pick: the pick, the
 *  same device under a new id, or the default when it is not plugged in. Before
 *  permission (placeholder list) the stored id is tried as-is. */
async function resolvePreviewMic(stored: string, s: VoiceSettings): Promise<string> {
    if (!stored) return DEFAULT_AUDIO_INPUT_ID;
    try {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
        if (!hasRealDeviceInfo(inputs)) return stored;
        return pickMicDeviceId(stored, inputs, micHintOf(s));
    } catch {
        return stored;
    }
}

// ── Main Component ────────────────────────────────────────────────────────────

export const VoiceVideoSettings: React.FC<VoiceVideoSettingsProps> = ({ voice }) => {
    const { settings, deviceProfiles } = voice;
    const cameraTier = useCameraQualityTier();
    const incomingMode = useIncomingVideoMode();

    // Deduped/labelled lists shared with the call-control right-click menus.
    const { inputDevices, outputDevices, videoDevices, refresh: enumerateDevices } = useMediaDevices();

    const [monitorOn, setMonitorOn]   = useState(false);
    // "Test speakers": null = idle; otherwise the last verdict.
    const [speakerTest, setSpeakerTest] = useState<{ running: boolean; tone: 'ok' | 'bad'; text: string } | null>(null);
    const [localLevel, setLocalLevel] = useState<number>(-Infinity);
    // What the gate itself measures (its detector, before AGC/mic volume) and
    // whether it is open — the meter under the threshold slider. See
    // GATE_METER_REPORT_MS in utils/voiceChain.ts for why it is not localLevel.
    const [gateLevel, setGateLevel] = useState<{ db: number; open: boolean }>({ db: -Infinity, open: false });

    const monitorCtxRef       = useRef<AudioContext | null>(null);
    const monitorStreamRef    = useRef<MediaStream | null>(null);
    const monitorOnRef        = useRef(false);
    monitorOnRef.current      = monitorOn;
    const monitorProcessorRef = useRef<CipherlineVoiceProcessor | null>(null);
    const settingsRef         = useRef(settings);
    settingsRef.current       = settings;
    const initTokenRef        = useRef<{ cancelled: boolean } | null>(null);
    /** The device id the preview capture actually opened (DEFAULT_AUDIO_INPUT_ID
     *  when it fell back), so a devicechange can tell whether to reopen. */
    const monitorDeviceRef    = useRef<string | null>(null);


    const stopMicStream = useCallback(() => {
        const outputNode = monitorProcessorRef.current?.outputNode;
        const ctx = monitorCtxRef.current;
        if (outputNode && ctx) {
            try { outputNode.disconnect(ctx.destination); } catch { /* teardown is best-effort; the node/handle may already be closed */ }
        }
        monitorProcessorRef.current?.destroy().catch(() => {});
        monitorProcessorRef.current = null;
        monitorStreamRef.current?.getTracks().forEach(t => t.stop());
        if (monitorCtxRef.current) unregisterOutputAudioContext(monitorCtxRef.current);
        monitorCtxRef.current?.close().catch(() => {});
        monitorCtxRef.current  = null;
        monitorStreamRef.current = null;
        setLocalLevel(-Infinity);
        setGateLevel({ db: -Infinity, open: false });
    }, []);

    const startMicStream = useCallback(async (deviceId: string) => {
        if (initTokenRef.current) initTokenRef.current.cancelled = true;
        const token = { cancelled: false };
        initTokenRef.current = token;

        stopMicStream();

        try {
            // Identical capture settings to a real call (audioInput.ts), echo
            // cancellation included — the user's setting, like the call's. This
            // used to open with echoCancellation: TRUE while calls used false, so
            // the level meter — and therefore the voice-gate threshold you set
            // against it — reflected a differently-processed signal than the one
            // actually transmitted. (With echo cancellation on and "Listen to
            // mic" playing through speakers, the canceller removes that
            // playback from the capture, as it would in a call.)
            //
            // And the SAME device: the picked mic (followed to a new id if
            // Windows re-enumerated it — deviceResolve.ts), opened with
            // {exact}. This used to pass the bare id, which Chromium ignores:
            // the meter, the gate meter and "Listen to mic" all ran on the
            // system DEFAULT mic whatever was picked here.
            const target = await resolvePreviewMic(deviceId, settingsRef.current);
            const open = (id: string) => navigator.mediaDevices.getUserMedia({
                audio: {
                    ...micCaptureConstraints(resolveEchoCancellation(settingsRef.current.echoCancellation)),
                    deviceId: micDeviceConstraint(id),
                },
            });
            let stream: MediaStream;
            let opened = target;
            try {
                stream = await open(target);
            } catch (err) {
                // The pick vanished between enumerating and opening: follow the
                // default, as the call would.
                const name = (err as { name?: string } | null)?.name;
                if (target === DEFAULT_AUDIO_INPUT_ID || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw err;
                stream = await open(DEFAULT_AUDIO_INPUT_ID);
                opened = DEFAULT_AUDIO_INPUT_ID;
            }
            monitorDeviceRef.current = opened;

            if (token.cancelled) {
                stream.getTracks().forEach(t => t.stop());
                return;
            }

            const ctx = new AudioContext({ sampleRate: 48000 });
            // "Hear my mic" plays out of THIS context's destination, so it has
            // to follow the chosen output device too — otherwise the monitor
            // comes out of the system speakers while the call comes out of the
            // headphones you just picked. Unregistered in stopMicStream.
            registerOutputAudioContext(ctx);

            // The same processor as a call, so the same thresholds, attack,
            // hold and release — plus the gate's own detector for the meter.
            const processor = new CipherlineVoiceProcessor(settingsRef.current, {
                onInputLevel: (db) => setLocalLevel(db),
                onGateLevel: (db, open) => setGateLevel({ db, open }),
            }, { gateMeterMs: GATE_METER_REPORT_MS });

            const rawTrack = stream.getAudioTracks()[0];
            await processor.init({ track: rawTrack, audioContext: ctx });

            if (token.cancelled) {
                await processor.destroy();
                stream.getTracks().forEach(t => t.stop());
                unregisterOutputAudioContext(ctx);
                ctx.close().catch(() => {});
                return;
            }

            monitorStreamRef.current = stream;
            monitorCtxRef.current    = ctx;
            monitorProcessorRef.current = processor;

            if (monitorOnRef.current && processor.outputNode) {
                processor.outputNode.connect(ctx.destination);
            }

            enumerateDevices();
            // Labels are readable now (if they were not before): let the
            // per-device settings recognise the mic and speakers.
            requestAudioDeviceResync();
        } catch (err) {
            if (!token.cancelled) console.warn('[VoiceSettings] Mic access failed:', err);
            // Re-enumerate on the failure path too. The first enumerate happens
            // pre-permission and returns blank placeholders; if we only refresh
            // after a SUCCESSFUL capture then a denied prompt, a busy device or
            // an absent mic leaves the dropdown permanently showing that blank
            // list with no way back except a restart.
            enumerateDevices();
        }
    }, [stopMicStream, enumerateDevices]);

    useEffect(() => {
        startMicStream(settings.micDeviceId);
        return () => stopMicStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings.micDeviceId]);

    // Echo cancellation toggled: Chromium ignores applyConstraints for it, so
    // re-open the preview (same as the call does with restartTrack). Skipped on
    // mount, where the effect above has just opened it with the current value.
    const echoCancellationSetting = resolveEchoCancellation(settings.echoCancellation);
    const echoMountedRef = useRef(false);
    useEffect(() => {
        if (!echoMountedRef.current) { echoMountedRef.current = true; return; }
        startMicStream(settingsRef.current.micDeviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [echoCancellationSetting]);

    // Keep the monitor stream pointed at the right device as hardware changes.
    // Without this the preview binds to whatever was default when the pane
    // mounted and stays there: unplug that mic, or change the OS default, and
    // the meter sits dead while the dropdown still reads "Default Microphone".
    // Re-selecting "Default" doesn't help either, because '' → '' isn't a state
    // change and so never re-runs the effect above.
    useEffect(() => {
        const onDeviceChange = () => {
            const s = settingsRef.current;
            navigator.mediaDevices.enumerateDevices().then(devices => {
                const inputs = devices.filter(d => d.kind === 'audioinput');
                if (!hasRealDeviceInfo(inputs)) return;
                const target = pickMicDeviceId(s.micDeviceId, inputs, micHintOf(s));
                // A picked device the preview is already open on is left alone
                // — restarting it would pointlessly interrupt the meter. One
                // that came back after the preview fell back to the default is
                // reopened; following the default always reopens (it may have
                // moved).
                if (target !== DEFAULT_AUDIO_INPUT_ID && target === monitorDeviceRef.current) return;
                startMicStream(s.micDeviceId);
            }).catch(() => {});
        };
        navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
        return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
    }, [startMicStream]);

    // A stored pick whose id no longer matches anything. This used to RESET
    // the setting to "follow the system default" — so a headset that was
    // merely switched off (Bluetooth) or re-enumerated by Windows under a new
    // id lost its selection for good the moment this pane saw the list without
    // it: "I set my mic and it just uses the default". Now: a pick that is
    // still plugged in under a new id (same groupId+label, deviceResolve.ts) is
    // re-pointed at that id; a pick that is genuinely absent is KEPT (listed as
    // "not connected" below) while everything falls back to the default, and
    // is used again as soon as it is back.
    useEffect(() => {
        if (!settings.micDeviceId) return;
        if (inputDevices.length === 0 || !hasRealDeviceInfo(inputDevices)) return;
        const { device, match } = findStoredDevice(settings.micDeviceId, micHintOf(settings), inputDevices);
        if (device && match !== 'exact') voice.setMicDeviceId(device.deviceId, device);
    }, [inputDevices, settings, voice]);
    useEffect(() => {
        if (!settings.speakerDeviceId) return;
        if (outputDevices.length === 0 || !hasRealDeviceInfo(outputDevices)) return;
        const { device, match } = findStoredDevice(settings.speakerDeviceId, speakerHintOf(settings), outputDevices);
        if (device && match !== 'exact') voice.setSpeakerDeviceId(device.deviceId, device);
    }, [outputDevices, settings, voice]);

    useEffect(() => {
        monitorProcessorRef.current?.updateSettings(settings);
    }, [settings]);

    // Plays the bundled test sound on the SELECTED output through the same
    // routing calls use (notificationSounds.testSpeakers), then says what
    // actually happened - so a pick can be verified without joining a call.
    const runSpeakerTest = useCallback(async () => {
        setSpeakerTest({ running: true, tone: 'ok', text: 'Playing\u2026' });
        const volume = Math.max(0.25, Math.min(1, settingsRef.current.speakerVolume / 100)) * 0.8;
        try {
            const result = await testSpeakers(DEFAULT_SOUNDS.message, volume);
            const verdict = describeSpeakerTest(result, settingsRef.current.speakerDeviceId === '');
            setSpeakerTest({ running: false, tone: verdict.ok ? 'ok' : 'bad', text: verdict.text });
        } catch {
            setSpeakerTest({ running: false, tone: 'bad', text: "Couldn't play the test sound." });
        }
    }, []);

    const toggleMonitor = useCallback(() => {
        const next = !monitorOn;
        setMonitorOn(next);
        const outputNode = monitorProcessorRef.current?.outputNode;
        const ctx = monitorCtxRef.current;
        if (!outputNode || !ctx) return;
        if (next) {
            try { outputNode.connect(ctx.destination); } catch { /* listener registration is best-effort */ }
        } else {
            try { outputNode.disconnect(ctx.destination); } catch { /* teardown is best-effort; the node/handle may already be closed */ }
        }
    }, [monitorOn]);

    // Live speaker switching is applied by useVoiceSettings (audioOutput.ts)
    // for the whole session, in a call or not — so "Listen to mic" and the
    // sound previews here follow a pick made here at once. Exactly one place
    // writes audioOutput.ts's storage key, so it can't drift from
    // voice.settings.speakerDeviceId.

    useEffect(() => {
        setMasterVolume(settings.speakerVolume);
    }, [settings.speakerVolume]);

    /** `missingLabel`: the stored pick when it is not plugged in — still listed
     *  (and still selected) so the choice is visibly kept, not silently lost. */
    const makeDeviceOptions = (
        devices: MediaDeviceInfo[],
        placeholder: string,
        storedId: string,
        missingLabel: string | undefined,
    ): ClSelectOption<string>[] => {
        const options: ClSelectOption<string>[] = [
            { value: '', label: devices.length === 0 ? 'No devices found' : placeholder },
            ...devices.map(d => ({ value: d.deviceId, label: deviceLabel(d) })),
        ];
        if (storedId && hasRealDeviceInfo(devices) && !devices.some(d => d.deviceId === storedId)) {
            options.push({ value: storedId, label: `${missingLabel || 'Selected device'} (not connected — using default)` });
        }
        return options;
    };
    /** onChange for a device picker: records the picked device's label/groupId
     *  with its id (deviceResolve.ts). Re-picking the kept-but-absent entry is a
     *  no-op rather than wiping the label it would be found by. */
    const pickFrom = (devices: MediaDeviceInfo[], storedId: string, set: (id: string, device?: MediaDeviceInfo | null) => void) =>
        (id: string) => {
            const device = devices.find(d => d.deviceId === id) ?? null;
            if (id && !device && id === storedId) return;
            set(id, device);
        };

    const inDev = deviceProfiles?.activeInput ?? null;
    const outDev = deviceProfiles?.activeOutput ?? null;

    return (
        <div className="vv">
            {/* ── Input ────────────────────────────────────────────────── */}
            <div className="sd-card vv-card">
                <div className="vv-head">
                    <h3>Input</h3>
                    <SavingFor device={inDev} kind="mic" />
                </div>
                <Row label="Microphone">
                    <ClSelect<string>
                        value={settings.micDeviceId}
                        onChange={pickFrom(inputDevices, settings.micDeviceId, voice.setMicDeviceId)}
                        options={makeDeviceOptions(inputDevices, 'Default Microphone', settings.micDeviceId, settings.micDeviceLabel)}
                        ariaLabel="Microphone"
                        style={{ flex: 1, minWidth: 0 }}
                    />
                </Row>
                <Row label="Input volume" labels={['Microphone level']} info="How loud your mic is sent. Remembered per microphone.">
                    <VolumeSlider value={settings.micVolume} onChange={voice.setMicVolume} resetValue={DEFAULT_VOICE_SETTINGS.micVolume} max={MIC_VOLUME_MAX} />
                </Row>
                <Row
                    label="Mic test"
                    labels={['Listen to mic']}
                    info="Talk and watch the bar. Listen plays your mic back to you with the same processing a call uses, so you hear what others hear."
                >
                    {/* live level — say something and watch it glow */}
                    <div className="vv-meter"><VuMeter level={localLevel} /></div>
                    <span className="vv-val vv-val--wide">{isFinite(localLevel) ? `${Math.round(localLevel)} dB` : 'quiet'}</span>
                    <ClButton
                        size="sm"
                        variant={monitorOn ? 'ok' : 'ghost'}
                        active={monitorOn}
                        onClick={toggleMonitor}
                    >
                        <Headphones className="w-3 h-3" />
                        <span>{monitorOn ? 'Listening…' : 'Listen to mic'}</span>
                    </ClButton>
                </Row>
            </div>

            {/* ── Output (beside Input, where it always was) ───────────── */}
            <div className="sd-card vv-card">
                <div className="vv-head">
                    <h3>Output</h3>
                    <SavingFor device={outDev} kind="output" />
                </div>
                <Row label="Speakers">
                    <ClSelect<string>
                        value={settings.speakerDeviceId}
                        onChange={pickFrom(outputDevices, settings.speakerDeviceId, voice.setSpeakerDeviceId)}
                        options={makeDeviceOptions(outputDevices, 'Default Speakers', settings.speakerDeviceId, settings.speakerDeviceLabel)}
                        ariaLabel="Speakers"
                        style={{ flex: 1, minWidth: 0 }}
                    />
                </Row>
                <Row label="Output volume" labels={['Test speakers']} info="How loud calls play. Remembered per speaker or headset. Test speakers plays a sound on the device picked above.">
                    <VolumeSlider value={settings.speakerVolume} onChange={voice.setSpeakerVolume} resetValue={DEFAULT_VOICE_SETTINGS.speakerVolume} max={SPEAKER_VOLUME_MAX} />
                    <ClButton variant="ghost" size="sm" onClick={runSpeakerTest} disabled={speakerTest?.running}>
                        <Volume2 className="w-3.5 h-3.5" /> Test speakers
                    </ClButton>
                </Row>
                {speakerTest && (
                    <p
                        className="vv-note"
                        role="status"
                        aria-live="polite"
                        style={{ color: speakerTest.tone === 'bad' ? 'var(--cl-danger, #e5484d)' : undefined }}
                    >
                        {speakerTest.text}
                    </p>
                )}
                <Row
                    label="Normalize voice volume"
                    kind="switch"
                    info="Evens out how loud each person sounds to you, so the loud ones stop blasting and the quiet ones stop disappearing. Your per-person sliders still work, and screen-share audio is left alone. Remembered per speaker or headset."
                >
                    <ClToggle checked={settings.normalizeIncomingVolume !== false} onChange={voice.setNormalizeIncomingVolume} aria-label="Normalize voice volume" />
                </Row>
            </div>

            {/* ── Voice processing (input → what is sent) ──────────────── */}
            <div className="sd-card vv-card">
                <div className="vv-head">
                    <h3>Voice processing</h3>
                    <SavingFor device={inDev} kind="mic" />
                </div>
                <Row label="Noise suppression" kind="block" labels={['Noise suppression engine']} info={<NoiseSuppressionInfo />}>
                    <NoiseSuppressionEngine
                        enabled={settings.noiseSuppression}
                        mode={settings.noiseSuppressionMode}
                        onEnabledChange={voice.setNoiseSuppression}
                        onModeChange={voice.setNoiseSuppressionMode}
                    />
                </Row>
                <Row
                    label="Voice gate"
                    labels={['Activity threshold']}
                    info="Only sends your mic when it is louder than the marker. Drag the marker against your live level: left is more sensitive (quieter speech gets through), right sends only loud speech. The dot lights up green while you are transmitting. Double-click the track to reset it. Remembered per microphone."
                >
                    <GateSlider
                        threshold={settings.voiceGateThreshold}
                        level={gateLevel.db}
                        open={gateLevel.open}
                        onChange={voice.setVoiceGateThreshold}
                        disabled={!settings.voiceGate}
                    />
                    <ClToggle checked={settings.voiceGate} onChange={voice.setVoiceGate} aria-label="Voice gate" />
                </Row>
                <Row label="Push to talk" info="Hold a key to transmit; you are silent otherwise. Click the key to change it. The same on every microphone.">
                    {settings.pushToTalk && (
                        <PttKeybind
                            value={settings.pushToTalkKey}
                            onSet={voice.setPushToTalkKey}
                        />
                    )}
                    <ClToggle checked={settings.pushToTalk} onChange={voice.setPushToTalk} aria-label="Push to talk" />
                </Row>
                <Row
                    label="Echo cancellation"
                    kind="switch"
                    note={ECHO_NOTE}
                    info={`Stops people hearing themselves when your mic picks up your speakers. ${ECHO_NOTE} Off by default. Remembered per microphone, so it can be on for a laptop mic and off for your headset.`}
                >
                    <ClToggle checked={echoCancellationSetting} onChange={voice.setEchoCancellation} aria-label="Echo cancellation" />
                </Row>
                <Row
                    label="Auto gain control"
                    kind="switch"
                    labels={['Volume normalization']}
                    info="Evens out whisper-to-shout swings in your own voice before it is sent. Remembered per microphone."
                >
                    <ClToggle checked={settings.volumeNormalization} onChange={voice.setVolumeNormalization} aria-label="Auto gain control" />
                </Row>

                <SettingsDisclosure
                    id="voice.mic-eq"
                    title="Mic EQ & audio health"
                    summary="Five-band equalizer and live call diagnostics."
                    icon={<AudioLines size={15} />}
                >
                    <Row
                        label="Mic EQ"
                        kind="switch"
                        info="Five bands to shape your voice. Drag a band up or down; double-click it to zero it. Remembered per microphone."
                    >
                        <ClToggle checked={settings.eqEnabled} onChange={voice.setEqEnabled} aria-label="Mic EQ" />
                    </Row>
                    <EqBands
                        bands={settings.eqBands}
                        onChange={voice.setEqBand}
                        onReset={voice.resetEqBands}
                        disabled={!settings.eqEnabled}
                    />
                    <AudioHealthPanel />
                </SettingsDisclosure>
            </div>

            {/* ── Remembered microphones / speakers, each with its own settings ── */}
            {deviceProfiles && <AudioDeviceList api={deviceProfiles} />}

            {/* ── Video ────────────────────────────────────────────────── */}
            <div className="sd-card vv-card">
                <h3>Video</h3>
                <div className="vv-video">
                    <CameraPreview
                        deviceId={settings.cameraDeviceId}
                        brightness={settings.cameraBrightness}
                        contrast={settings.cameraContrast}
                        saturation={settings.cameraSaturation}
                    />
                    <div className="vv-stack">
                        <Row label="Camera" info="The preview never starts on its own. Your camera is only on while the preview is showing.">
                            <ClSelect<string>
                                value={settings.cameraDeviceId}
                                onChange={voice.setCameraDeviceId}
                                options={makeDeviceOptions(videoDevices, 'Default Camera', settings.cameraDeviceId, undefined)}
                                ariaLabel="Camera"
                                style={{ flex: 1, minWidth: 0 }}
                            />
                        </Row>
                        <Row
                            label="Camera quality"
                            info="Auto sends the best your camera does at 30 fps — up to 1440p when your GPU can encode it, 1080p otherwise. Pick a lower one if your PC struggles in calls."
                        >
                            <ClSelect<CameraQualityTier>
                                value={cameraTier}
                                onChange={setCameraQualityTier}
                                options={CAMERA_TIER_OPTIONS}
                                ariaLabel="Camera quality"
                                style={{ flex: 1, minWidth: 0 }}
                            />
                        </Row>
                        <Row
                            label="Incoming video quality"
                            info={
                                <>
                                    <p>How other people’s cameras are shown to you.</p>
                                    {INCOMING_MODE_OPTIONS.map(o => (
                                        <p key={o.value}><b>{o.label}</b>: {INCOMING_MODE_HELP[o.value]}</p>
                                    ))}
                                </>
                            }
                        >
                            <ClSelect<IncomingVideoMode>
                                value={incomingMode}
                                onChange={setIncomingVideoMode}
                                options={INCOMING_MODE_OPTIONS}
                                ariaLabel="Incoming video quality"
                                style={{ flex: 1, minWidth: 0 }}
                            />
                        </Row>
                    </div>
                </div>

                {/* ── While gaming (camera / screen-share freezes) ───── */}
                <GamingVideoSetting />

                <SettingsDisclosure
                    id="voice.picture"
                    title="Picture adjustments"
                    summary="Brightness, contrast and saturation of the video you send."
                    icon={<SlidersHorizontal size={15} />}
                    labels={['Camera adjustments']}
                >
                    <PictureSlider label="Brightness" value={settings.cameraBrightness} onChange={voice.setCameraBrightness} min={0} max={200} resetValue={DEFAULT_VOICE_SETTINGS.cameraBrightness} />
                    <PictureSlider label="Contrast"   value={settings.cameraContrast}   onChange={voice.setCameraContrast}   min={0} max={200} resetValue={DEFAULT_VOICE_SETTINGS.cameraContrast} />
                    <PictureSlider label="Saturation" value={settings.cameraSaturation} onChange={voice.setCameraSaturation} min={0} max={200} resetValue={DEFAULT_VOICE_SETTINGS.cameraSaturation} />
                    <div className="vv-actions">
                        <ClButton variant="ghost" size="sm" onClick={voice.resetCameraPicture}>Reset picture</ClButton>
                    </div>
                </SettingsDisclosure>
            </div>
        </div>
    );
};
