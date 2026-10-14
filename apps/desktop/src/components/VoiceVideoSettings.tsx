import React, { useRef, useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { Mic, Volume2, Headphones, Radio, VideoOff } from 'lucide-react';
import { eventToCombo, formatCombo } from '../hooks/useKeybinds';
import {
    type VoiceSettings,
    type VoiceSettingsHook,
} from '../hooks/useVoiceSettings';
import { useMediaDevices, deviceLabel } from '../hooks/useMediaDevices';
import { CipherlineVoiceProcessor } from '../utils/voiceProcessor';
import { ClSlider } from './ClSlider';
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
import type { ClSelectOption } from './cl';
import { useCameraQualityTier, setCameraQualityTier, useIncomingVideoMode, setIncomingVideoMode } from '../utils/cameraQualityPrefs';
import type { IncomingVideoMode } from '../utils/remoteVideoQuality';
import { CAMERA_QUALITY_TIERS, tierLabel, type CameraQualityTier } from '../utils/cameraQuality';

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

/**
 * Twilight · Voice & Video — Descent redesign (phase 2): sd-card sections,
 * a live VU bar instead of the 5-dot meter, keycap-chip push-to-talk, and
 * the Picture sliders folded into the Camera card. All audio plumbing
 * (monitor loop, processor, gate) unchanged.
 */
interface VoiceVideoSettingsProps {
    voice: VoiceSettingsHook;
}

const rowCls = 'flex items-center justify-between gap-3';

// ── Volume Slider (0-300%) ────────────────────────────────────────────────────

const VolumeSlider: React.FC<{
    value: number;
    onChange: (v: number) => void;
}> = ({ value, onChange }) => (
    <div className="flex items-center gap-2.5">
        <ClSlider
            min={0}
            max={300}
            step={1}
            value={value}
            onChange={onChange}
            resetValue={100}
            formatLabel={v => `${v}%`}
            style={{ flex: 1 }}
        />
        <span className="text-xs font-mono w-9 text-right flex-shrink-0" style={{ color: 'var(--cl-faint)' }}>
            {value}%
        </span>
    </div>
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

const GATE_DEFAULT_THRESHOLD = -45; // dBFS

/**
 * `level` is the gate's OWN detector — the loudest 128-sample block of each
 * 50 ms, measured where the gate measures it (after noise suppression, before
 * EQ / auto gain / mic volume) — and `open` is the gate's real state. It used
 * to be the end-of-chain level instead: shifted by AGC and mic volume, and
 * blank whenever the gate was closed, so with noise suppression off the room
 * noise could sit visibly under the thumb while the gate let it through.
 */
const GateSlider: React.FC<{
    threshold: number;
    level: number;
    open: boolean;
    onChange: (v: number) => void;
    disabled?: boolean;
}> = ({ threshold, level, open, onChange, disabled }) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);
    const [grabbing, setGrabbing] = useState(false);

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

    return (
        <div className={`mt-2.5 ${disabled ? 'opacity-35 pointer-events-none' : ''}`}>
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>
                    Activity Threshold
                    {!disabled && (
                        <span className="sd-mono" style={{ marginLeft: 8, color: open ? 'var(--cl-ok)' : 'var(--cl-faint)' }}>
                            {open ? '● transmitting' : '○ gated'}
                        </span>
                    )}
                </span>
                <span className="text-[11px] font-mono" style={{ color: 'var(--cl-muted)' }}>{threshold} dBFS</span>
            </div>
            {/* Kit slider chrome (.cls/.strk/.sfill/.sthw) — the fill is the LIVE
                mic level rather than the value, so the meter stays built into the
                track; the thumb marks the threshold. Interaction unchanged. */}
            <span className="cl-kit" style={{ display: 'contents' }}>
                <div
                    ref={trackRef}
                    className={`cls${grabbing ? ' grab' : ''} select-none`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onDoubleClick={() => onChange(GATE_DEFAULT_THRESHOLD)}
                >
                    <span className="sbody">
                        <span className="strk" />
                        <span
                            className="sfill"
                            style={{ width: `${levelPct}%`, background: levelColor, transition: 'width 75ms linear, background .2s' }}
                        />
                        <span className="sthw" style={{ left: `${thumbPct}%` }}>
                            <span className="ssh" />
                            <span className="sth" />
                        </span>
                        <span className="sbub" style={{ left: `${thumbPct}%` }}>{threshold} dBFS</span>
                    </span>
                </div>
            </span>
            <div className="flex justify-between text-[9px] mt-0.5 px-0.5" style={{ color: 'var(--cl-faint)' }}>
                <span>Sensitive</span>
                <span>Loud only</span>
            </div>
        </div>
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
        <div className="mt-2 flex items-center justify-end gap-2">
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
                onClick={() => setRecording(r => !r)}
                className={`sd-kbd${recording ? ' sd-rec' : ''}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}
                title={recording ? 'Press a key combo — Esc cancels' : 'Click to rebind'}
            >
                {recording ? (
                    <i>Press keys…</i>
                ) : value ? (
                    formatCombo(value).split(' + ').map((k, i) => <i key={i}>{k}</i>)
                ) : (
                    <i style={{ color: 'var(--cl-faint)' }}>Set keybind</i>
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
    // Camera does NOT auto-start. The user has to opt in explicitly so opening
    // the settings tab never silently flips the webcam on.
    const [active, setActive] = useState(false);

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

        navigator.mediaDevices.getUserMedia({
            video: {
                deviceId: deviceId || undefined,
                width: { ideal: 1280 },
                height: { ideal: 720 },
            },
        }).then(stream => {
            if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
            streamRef.current = stream;
            if (videoRef.current) videoRef.current.srcObject = stream;
        }).catch(e => {
            if (!cancelled) setErr(e?.name === 'NotFoundError' ? 'No camera found' : 'Camera access denied');
        });

        return () => { cancelled = true; stop(); };
    }, [deviceId, active]);

    useEffect(() => () => {
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
    }, []);

    const cssFilter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;

    if (!active) {
        return (
            <div className="w-full aspect-video rounded-lg flex flex-col items-center justify-center gap-3 mt-3" style={{ background: 'rgba(0,0,0,.4)', border: '1px solid var(--cl-border)' }}>
                <VideoOff className="w-7 h-7" style={{ color: 'var(--cl-faint)' }} />
                <p className="text-xs max-w-[220px] text-center leading-relaxed" style={{ color: 'var(--cl-faint)' }}>
                    Preview is off. Turn it on to test your camera.
                </p>
                <ClButton size="sm" onClick={() => setActive(true)}>Enable Camera</ClButton>
            </div>
        );
    }

    if (err) {
        return (
            <div className="w-full aspect-video rounded-lg flex flex-col items-center justify-center gap-2 mt-3" style={{ background: 'rgba(0,0,0,.4)', border: '1px solid var(--cl-border)' }}>
                <VideoOff className="w-6 h-6" style={{ color: 'var(--cl-faint)' }} />
                <span className="text-xs" style={{ color: 'var(--cl-faint)' }}>{err}</span>
                <ClButton variant="ghost" size="sm" onClick={() => { setErr(null); setActive(false); }}>Try again</ClButton>
            </div>
        );
    }

    return (
        <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-black mt-3">
            <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover scale-x-[-1]"
                style={{ filter: cssFilter }}
            />
            <div className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/[0.06] pointer-events-none" />
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
    resetValue?: number;
}> = ({ label, value, onChange, min = 0, max = 200, resetValue = 100 }) => (
    <div className="flex items-center gap-3">
        <span className="text-xs w-20 flex-shrink-0" style={{ color: 'var(--cl-muted)' }}>{label}</span>
        <ClSlider
            min={min}
            max={max}
            step={1}
            value={value}
            onChange={onChange}
            resetValue={resetValue}
            formatLabel={v => `${v}%`}
            style={{ flex: 1 }}
        />
        <span className="text-xs font-mono w-9 text-right flex-shrink-0" style={{ color: 'var(--cl-faint)' }}>{value}%</span>
    </div>
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

/** One vertical band: inset rail, lume fill growing from the 0 dB midline,
 *  kit-style thumb that scales+glows while grabbed. Drag anywhere on the
 *  column; double-click snaps the band back to 0. */
const EqBand: React.FC<{
    def: { freq: number; label: string };
    gain: number;
    onChange: (v: number) => void;
}> = ({ def, gain, onChange }) => {
    const trackRef = useRef<HTMLDivElement>(null);
    const [grabbing, setGrabbing] = useState(false);

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
                ref={trackRef}
                className={`sd-eq-track${grabbing ? ' sd-grab' : ''}`}
                role="slider"
                aria-label={`${def.label} Hz band`}
                aria-valuemin={EQ_MIN}
                aria-valuemax={EQ_MAX}
                aria-valuenow={gain}
                tabIndex={0}
                onPointerDown={e => { setGrabbing(true); (e.target as Element).setPointerCapture(e.pointerId); fromEvent(e); }}
                onPointerMove={e => { if (grabbing) fromEvent(e); }}
                onPointerUp={() => setGrabbing(false)}
                onPointerCancel={() => setGrabbing(false)}
                onDoubleClick={() => onChange(0)}
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
    <div className={`sd-eq-wrap mt-1${disabled ? ' sd-disabled' : ''}`}>
        <div className="sd-eq">
            {EQ_BAND_DEFS.map((def, i) => (
                <EqBand key={def.freq} def={def} gain={bands[i] ?? 0} onChange={v => onChange(i, v)} />
            ))}
        </div>
        <div className="flex items-center justify-between mt-2">
            <span className="sd-mono" style={{ fontSize: 9.5 }}>double-click a band to zero it</span>
            <ClButton variant="ghost" size="sm" onClick={onReset}>Reset</ClButton>
        </div>
    </div>
);

// ── Audio health (debug) ────────────────────────────────────────────────────
// Read-only diagnostics for the call-audio pipeline — underrun/auto-bypass
// counts and the currently-applied AGC gain, so a regression in the jitter
// buffer or AGC (see nsKernel.js / agcKernel.js) is visible instead of only
// inferable from "someone said it sounded bad." Reflects the most recent
// call this session (audioHealth resets its counters at the start of every
// CallPane mount — see CallPane.tsx); shows "no data yet" before any call.
// Collapsed by default — it's a debug surface, not a primary control.
const AudioHealthPanel: React.FC = () => {
    const [expanded, setExpanded] = useState(false);
    const health = useSyncExternalStore(subscribeAudioHealth, getAudioHealthSnapshot);

    return (
        <div className="sd-row" style={{ display: 'block' }}>
            <div className={rowCls}>
                <div className="sd-rl">
                    <b>Audio health</b>
                    <span>Live diagnostics for this call's noise suppression &amp; AGC.</span>
                </div>
                <div className="sd-rc">
                    <ClButton variant="ghost" size="sm" onClick={() => setExpanded(v => !v)}>
                        {expanded ? 'Hide' : 'Show'}
                    </ClButton>
                </div>
            </div>
            {expanded && (
                <div className="sd-mono" style={{ fontSize: 11, lineHeight: 1.7, opacity: 0.85, marginTop: 4 }}>
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
            )}
        </div>
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
    const { settings } = voice;
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

    return (
        <>
            {/* ── Input ────────────────────────────────────────────────── */}
            <div className="sd-card">
                <h3>Input</h3>
                <p className="sd-sub">Your voice is encrypted per frame on the way out — tune it here first.</p>
                <ClSelect<string>
                    value={settings.micDeviceId}
                    onChange={pickFrom(inputDevices, settings.micDeviceId, voice.setMicDeviceId)}
                    options={makeDeviceOptions(inputDevices, 'Default Microphone', settings.micDeviceId, settings.micDeviceLabel)}
                    style={{ width: '100%' }}
                />
                <div className="flex items-center gap-2.5 mt-3">
                    <Mic className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--cl-faint)' }} />
                    <div className="flex-1">
                        <VolumeSlider value={settings.micVolume} onChange={voice.setMicVolume} />
                    </div>
                </div>
                {/* live level — say something and watch it glow */}
                <div className="mt-3">
                    <VuMeter level={localLevel} />
                </div>
                <div className="flex items-center justify-between mt-2.5">
                    <ClButton
                        size="sm"
                        variant={monitorOn ? 'ok' : 'ghost'}
                        active={monitorOn}
                        onClick={toggleMonitor}
                    >
                        <Headphones className="w-3 h-3" />
                        <span>{monitorOn ? 'Listening…' : 'Listen to mic'}</span>
                    </ClButton>
                    <span className="sd-mono">{isFinite(localLevel) ? `${Math.round(localLevel)} dBFS` : 'quiet'}</span>
                </div>
            </div>

            {/* ── Output ───────────────────────────────────────────────── */}
            <div className="sd-card">
                <h3>Output</h3>
                <ClSelect<string>
                    value={settings.speakerDeviceId}
                    onChange={pickFrom(outputDevices, settings.speakerDeviceId, voice.setSpeakerDeviceId)}
                    options={makeDeviceOptions(outputDevices, 'Default Speakers', settings.speakerDeviceId, settings.speakerDeviceLabel)}
                    style={{ width: '100%' }}
                />
                <div className="flex items-center gap-2.5 mt-3">
                    <Volume2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--cl-faint)' }} />
                    <div className="flex-1">
                        <VolumeSlider value={settings.speakerVolume} onChange={voice.setSpeakerVolume} />
                    </div>
                </div>
                <div className="flex items-center gap-2.5 mt-3">
                    <ClButton variant="ghost" size="sm" onClick={runSpeakerTest} disabled={speakerTest?.running}>
                        <Volume2 className="w-3.5 h-3.5" /> Test speakers
                    </ClButton>
                    {speakerTest && (
                        <span
                            role="status"
                            aria-live="polite"
                            style={{ fontSize: 12.5, fontWeight: 600, color: speakerTest.tone === 'bad' ? 'var(--cl-danger, #e5484d)' : 'var(--cl-faint)' }}
                        >
                            {speakerTest.text}
                        </span>
                    )}
                </div>
            </div>

            {/* ── Camera (device + preview + picture) ──────────────────── */}
            <div className="sd-card">
                <div className="flex items-center justify-between">
                    <h3>Camera</h3>
                    <ClButton variant="ghost" size="sm" onClick={voice.resetCameraPicture}>Reset picture</ClButton>
                </div>
                <p className="sd-sub">Preview never auto-starts — the camera is yours to switch on.</p>
                <ClSelect<string>
                    value={settings.cameraDeviceId}
                    onChange={voice.setCameraDeviceId}
                    options={makeDeviceOptions(videoDevices, 'Default Camera', '', undefined)}
                    style={{ width: '100%' }}
                />
                <div className="sd-row">
                    <div className="sd-rl">
                        <b>Camera quality</b>
                        <span>Auto sends the best your camera does at 30 fps — up to 1440p when your GPU can encode it, 1080p otherwise. Pick a lower one if your PC struggles in calls.</span>
                    </div>
                    <ClSelect<CameraQualityTier>
                        value={cameraTier}
                        onChange={setCameraQualityTier}
                        options={CAMERA_TIER_OPTIONS}
                        style={{ width: 200 }}
                    />
                </div>
                <div className="sd-row">
                    <div className="sd-rl">
                        <b>Incoming video quality</b>
                        <span>{INCOMING_MODE_HELP[incomingMode]}</span>
                    </div>
                    <ClSelect<IncomingVideoMode>
                        value={incomingMode}
                        onChange={setIncomingVideoMode}
                        options={INCOMING_MODE_OPTIONS}
                        style={{ width: 200 }}
                    />
                </div>
                <CameraPreview
                    deviceId={settings.cameraDeviceId}
                    brightness={settings.cameraBrightness}
                    contrast={settings.cameraContrast}
                    saturation={settings.cameraSaturation}
                />
                <div className="space-y-2.5 mt-4">
                    <PictureSlider label="Brightness" value={settings.cameraBrightness} onChange={voice.setCameraBrightness} min={0} max={200} />
                    <PictureSlider label="Contrast"   value={settings.cameraContrast}   onChange={voice.setCameraContrast}   min={0} max={200} />
                    <PictureSlider label="Saturation" value={settings.cameraSaturation} onChange={voice.setCameraSaturation} min={0} max={200} />
                </div>
            </div>

            {/* ── While gaming (camera / screen-share freezes) ─────────── */}
            <GamingVideoSetting />

            {/* ── Voice Processing ─────────────────────────────────────── */}
            <div className="sd-card">
                <h3>Voice processing</h3>
                <p className="sd-sub">All of this runs on your device — the unfiltered signal never leaves.</p>

                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <div className="sd-rl">
                        <b>Noise suppression</b>
                        <span>Fans, keyboards, the dishwasher — gone.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={settings.noiseSuppression} onChange={voice.setNoiseSuppression} />
                    </div>
                </div>

                <div className="sd-row">
                    <div className="sd-rl">
                        <b>Echo cancellation</b>
                        <span>Stops others from hearing themselves when you use speakers. Turn off if you use headphones and want the most natural sound.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={echoCancellationSetting} onChange={voice.setEchoCancellation} />
                    </div>
                </div>

                <div className="sd-row" style={{ display: 'block' }}>
                    <div className={rowCls}>
                        <div className="sd-rl">
                            <b>Mic EQ</b>
                            <span>Five bands, your voice, your call.</span>
                        </div>
                        <div className="sd-rc">
                            <ClToggle checked={settings.eqEnabled} onChange={voice.setEqEnabled} />
                        </div>
                    </div>
                    <EqBands
                        bands={settings.eqBands}
                        onChange={voice.setEqBand}
                        onReset={voice.resetEqBands}
                        disabled={!settings.eqEnabled}
                    />
                </div>

                <div className="sd-row">
                    <div className="sd-rl">
                        <b>Auto gain control</b>
                        <span>Evens out whisper-to-shout swings.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={settings.volumeNormalization} onChange={voice.setVolumeNormalization} />
                    </div>
                </div>

                <div className="sd-row" style={{ display: 'block' }}>
                    <div className={rowCls}>
                        <div className="sd-rl">
                            <b>Voice gate</b>
                            <span>Only transmit above the threshold — drag it against your live level.</span>
                        </div>
                        <div className="sd-rc">
                            <ClToggle checked={settings.voiceGate} onChange={voice.setVoiceGate} />
                        </div>
                    </div>
                    <GateSlider
                        threshold={settings.voiceGateThreshold}
                        level={gateLevel.db}
                        open={gateLevel.open}
                        onChange={voice.setVoiceGateThreshold}
                        disabled={!settings.voiceGate}
                    />
                </div>

                <div className="sd-row" style={{ display: 'block' }}>
                    <div className={rowCls}>
                        <div className="sd-rl">
                            <b className="flex items-center gap-2"><Radio size={14} style={{ color: 'var(--cl-faint)' }} /> Push to talk</b>
                            <span>Hold a key to transmit; silence otherwise.</span>
                        </div>
                        <div className="sd-rc">
                            <ClToggle checked={settings.pushToTalk} onChange={voice.setPushToTalk} />
                        </div>
                    </div>
                    {settings.pushToTalk && (
                        <PttKeybind
                            value={settings.pushToTalkKey}
                            onSet={voice.setPushToTalkKey}
                        />
                    )}
                </div>

                <AudioHealthPanel />
            </div>
        </>
    );
};
