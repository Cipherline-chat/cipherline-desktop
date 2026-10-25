import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Play, Upload, Trash2, RefreshCw } from 'lucide-react';
import { ClButton } from '../../cl';
import { ClSlider } from '../../ClSlider';
import '../../../styles/entrance-sound.css';
import {
    FILE_ACCEPT, MAX_CLIP_SECONDS, MAX_INPUT_BYTES, MIN_CLIP_SECONDS, customContentId, customEntranceSoundValue,
} from '../../../utils/customEntranceSound/constants';
import { describeSoundError, fmtSecs, fmtSize, fmtTime } from '../../../utils/customEntranceSound/ui';
import { processClip, waveformPeaks } from '../../../utils/customEntranceSound/process';
import { checkInputFile, decodeSound, decodeToMono48k, encodeSound } from '../../../utils/customEntranceSound/browser';
import { listenerGain } from '../../../utils/customEntranceSound/playbackGain';
import { ownEntranceSound, type OwnSound } from '../../../utils/customEntranceSound/ownStore';
import { previewCustomEntranceSound } from '../../../utils/entrancePlayback';
import { saveOwnCallPersonalization } from '../../../utils/callPersonalizationStore';
import type { SoundsPrefs } from '../../../utils/notificationSounds';

/**
 * Settings > Personalize > Calls > Entrance sound > Custom.
 *
 * Pick an audio file, choose up to 2.5 s of it on a waveform strip (Start +
 * Length sliders, or click the strip), Preview what the others will hear,
 * then Use it. Everything happens on this device: decode, trim, loudness
 * normalize, true-peak limit, fade, Opus encode (utils/customEntranceSound/).
 * The sound is stored encrypted on your devices only; the server learns just
 * `custom:<content id>` so people in a call know to expect it.
 */

const STRIP_BARS = 160;

interface Source { name: string; mono: Float32Array; seconds: number; peaks: Float32Array }
interface Result { window: string; bytes: Uint8Array; durationMs: number; url: string; gain: number; lufs: number }

type Phase = 'idle' | 'reading' | 'ready' | 'working' | 'saving';

export interface CustomEntranceEditorProps {
    userId: string;
    prefs: SoundsPrefs | null | undefined;
    onDone: (announce: string) => void;
    onCancel: () => void;
    /** A save that half-worked (stored here, server refused) or failed. */
    onError: (message: string) => void;
}

/** The pick-trim-preview-use flow. */
export const CustomEntranceEditor: React.FC<CustomEntranceEditorProps> = ({ userId, prefs, onDone, onCancel, onError }) => {
    const ids = useId();
    const fileRef = useRef<HTMLInputElement>(null);
    const [phase, setPhase] = useState<Phase>('idle');
    const [src, setSrc] = useState<Source | null>(null);
    const [start, setStart] = useState(0);
    const [len, setLen] = useState(MAX_CLIP_SECONDS);
    // The last processed result. It only counts for the window it was made
    // from (`current`); a stale one just waits to be replaced.
    const [result, setResult] = useState<Result | null>(null);
    const [msg, setMsg] = useState('');
    const windowKey = `${start.toFixed(3)}|${len.toFixed(3)}`;
    const current = result && result.window === windowKey ? result : null;
    // Each result's blob: URL dies with it (replaced, discarded, or the editor closed).
    useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);

    const pick = () => fileRef.current?.click();

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setMsg('');
        const bad = checkInputFile(file);
        if (bad) { setMsg(describeSoundError(bad)); return; }
        setPhase('reading');
        try {
            const { mono, seconds } = await decodeToMono48k(await file.arrayBuffer());
            if (seconds < MIN_CLIP_SECONDS) throw new Error('window too short');
            // Scaled to the file's own loudest point, so a quiet recording still draws a readable strip.
            const peaks = waveformPeaks(mono, STRIP_BARS);
            const top = peaks.reduce((m, v) => Math.max(m, v), 0);
            if (top > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= top;
            setSrc({ name: file.name, mono, seconds, peaks });
            setStart(0);
            setLen(Math.min(MAX_CLIP_SECONDS, seconds));
            setPhase('ready');
        } catch (err) {
            setMsg(describeSoundError(err instanceof Error ? err.message : ''));
            setPhase(src ? 'ready' : 'idle');
        }
    };

    const maxLen = src ? Math.min(MAX_CLIP_SECONDS, src.seconds) : MAX_CLIP_SECONDS;
    const maxStart = src ? Math.max(0, src.seconds - len) : 0;
    const setLength = (v: number) => {
        const l = Math.min(maxLen, Math.max(MIN_CLIP_SECONDS, v));
        setLen(l);
        if (src && start + l > src.seconds) setStart(Math.max(0, src.seconds - l));
    };

    /** Process + encode the current window (cached until the window changes). */
    const build = useCallback(async (): Promise<Result | null> => {
        if (!src) return null;
        if (current) return current;
        setPhase('working');
        setMsg('');
        try {
            const clip = processClip(src.mono, start, len);
            const { bytes } = await encodeSound(clip.pcm);
            const decoded = await decodeSound(bytes);
            const gain = decoded ? listenerGain(decoded.channels, decoded.sampleRate) : 0;
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/webm' }));
            const r: Result = { window: windowKey, bytes, durationMs: clip.durationMs, url, gain, lufs: clip.outputLufs };
            setResult(r);
            return r;
        } catch (err) {
            setMsg(describeSoundError(err instanceof Error ? err.message : ''));
            return null;
        } finally {
            setPhase('ready');
        }
    }, [src, current, windowKey, start, len]);

    const preview = async () => {
        const r = await build();
        if (r) previewCustomEntranceSound(r.url, r.gain, prefs);
    };

    const use = async () => {
        const r = await build();
        if (!r) return;
        setPhase('saving');
        let id: string;
        try {
            id = await ownEntranceSound().set(r.bytes, r.durationMs);
        } catch (err) {
            const code = err instanceof Error ? err.message.replace(/^invalid_sound:.*/, 'encode_failed') : '';
            setMsg(describeSoundError(code));
            setPhase('ready');
            return;
        }
        try {
            await saveOwnCallPersonalization(userId, { entrance_sound: customEntranceSoundValue(id) });
            onDone(`Entrance sound: your custom sound, ${fmtSecs(r.durationMs)}`);
        } catch {
            onError('Your sound is saved on this device, but it could not be turned on for calls. Check your connection and pick Custom again.');
            onCancel();
        }
    };

    const onStrip = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!src || phase !== 'ready') return;
        const box = e.currentTarget.getBoundingClientRect();
        const at = ((e.clientX - box.left) / Math.max(1, box.width)) * src.seconds;
        setStart(Math.min(maxStart, Math.max(0, at - len / 2)));
    };

    const busy = phase === 'reading' || phase === 'working' || phase === 'saving';
    const leftPct = src ? (start / src.seconds) * 100 : 0;
    const widthPct = src ? (len / src.seconds) * 100 : 0;

    return (
        <div className="ces-panel" role="group" aria-labelledby={`${ids}-title`} aria-busy={busy || undefined}>
            <div className="ces-head">
                <span className="ces-title" id={`${ids}-title`}>{src ? src.name : 'Your own entrance sound'}</span>
                {src && <span className="ces-meta">{fmtTime(src.seconds)}</span>}
            </div>
            <input
                ref={fileRef} type="file" accept={FILE_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true"
                onChange={e => { void onFile(e); }}
            />

            {!src && (
                <div className="ces-empty">
                    <p className="ces-hint">
                        MP3, OGG, WAV, M4A or WebM, up to {Math.round(MAX_INPUT_BYTES / (1024 * 1024))} MB. You choose up to {MAX_CLIP_SECONDS} seconds of it.
                        It is processed and kept on your devices only.
                    </p>
                    <div className="ces-actions">
                        <ClButton size="sm" onClick={pick} loading={phase === 'reading'}>
                            <Upload size={13} className="mr-1" aria-hidden="true" />Choose a file
                        </ClButton>
                        <ClButton size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</ClButton>
                    </div>
                </div>
            )}

            {src && (
                <>
                    {/* Pointer shortcut for the Start slider below; the sliders are the keyboard path. */}
                    <div className="ces-strip" onClick={onStrip} aria-hidden="true" data-testid="ces-strip">
                        <svg viewBox={`0 0 ${STRIP_BARS} 40`} preserveAspectRatio="none" className="ces-wave">
                            {Array.from(src.peaks, (p, i) => {
                                const h = Math.max(1, p * 38);
                                const t = ((i + 0.5) / STRIP_BARS) * src.seconds;
                                const inside = t >= start && t <= start + len;
                                return <rect key={i} x={i + 0.15} y={20 - h / 2} width={0.7} height={h} className={inside ? 'ces-bar ces-bar--on' : 'ces-bar'} />;
                            })}
                        </svg>
                        <div className="ces-sel" style={{ left: `${leftPct}%`, width: `${widthPct}%` }} />
                    </div>

                    <div className="ces-sliders">
                        <div className="ces-field">
                            <span className="ces-field-label" aria-hidden="true">Start <b>{fmtTime(start)}</b></span>
                            <ClSlider
                                value={Math.min(start, maxStart)} min={0} max={Math.max(0.01, maxStart)} step={0.05}
                                onChange={v => setStart(Math.min(maxStart, Math.max(0, v)))} resetValue={0}
                                formatLabel={fmtTime} disabled={busy || maxStart <= 0}
                                ariaLabel="Start of the clip" ariaValueText={fmtTime(start)}
                            />
                        </div>
                        <div className="ces-field">
                            <span className="ces-field-label" aria-hidden="true">Length <b>{len.toFixed(2)} s</b></span>
                            <ClSlider
                                value={len} min={MIN_CLIP_SECONDS} max={Math.max(MIN_CLIP_SECONDS + 0.01, maxLen)} step={0.05}
                                onChange={setLength} resetValue={maxLen}
                                formatLabel={v => `${v.toFixed(2)} s`} disabled={busy}
                                ariaLabel="Length of the clip" ariaValueText={`${len.toFixed(2)} seconds`}
                            />
                        </div>
                    </div>

                    <p className="ces-hint" aria-live="polite">
                        {phase === 'working' ? 'Processing on this device…'
                            : phase === 'saving' ? 'Saving…'
                            : current ? `Ready: ${fmtSecs(current.durationMs)}, ${fmtSize(current.bytes.length)}, leveled to ${Math.round(current.lufs)} LUFS.`
                            : `${fmtTime(start)} to ${fmtTime(start + len)}. Preview to hear what the others will hear.`}
                    </p>

                    <div className="ces-actions">
                        <ClButton size="sm" variant="ghost" onClick={() => { void preview(); }} disabled={busy}>
                            <Play size={13} className="mr-1" aria-hidden="true" />Preview
                        </ClButton>
                        <ClButton size="sm" onClick={() => { void use(); }} loading={phase === 'saving' || phase === 'working'} disabled={busy}>
                            Use this sound
                        </ClButton>
                        <ClButton size="sm" variant="ghost" onClick={pick} disabled={busy}>Other file</ClButton>
                        <ClButton size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</ClButton>
                    </div>
                </>
            )}

            {msg && <p className="ces-error" role="alert">{msg}</p>}
        </div>
    );
};

export interface CustomEntranceStatusProps {
    own: OwnSound | null;
    /** The server value (`custom:<id>`), or null when Custom is not selected. */
    serverValue: string | null;
    prefs: SoundsPrefs | null | undefined;
    onReplace: () => void;
    onRemove: () => void;
    removing: boolean;
}

/** Custom is selected: what this device holds, Preview / Replace / Remove. */
export const CustomEntranceStatus: React.FC<CustomEntranceStatusProps> = ({ own, serverValue, prefs, onReplace, onRemove, removing }) => {
    const wantId = customContentId(serverValue);
    const here = !!own && (!wantId || own.id === wantId);
    const [previewErr, setPreviewErr] = useState('');
    // Removing reaches every one of your devices (sync carries the removal), so it asks once.
    const [confirming, setConfirming] = useState(false);
    const preview = async () => {
        setPreviewErr('');
        const store = ownEntranceSound();
        const url = await store.previewUrl();
        const bytes = await store.read();
        const decoded = bytes ? await decodeSound(bytes) : null;
        if (!url || !decoded) { setPreviewErr('Your sound could not be read on this device.'); return; }
        previewCustomEntranceSound(url, listenerGain(decoded.channels, decoded.sampleRate), prefs);
    };
    return (
        <div className="ces-panel ces-panel--status">
            {here ? (
                <p className="ces-hint ces-hint--strong">
                    Your sound: {fmtSecs(own!.durationMs)}, {fmtSize(own!.size)}. Kept on your devices only and sent, encrypted, to the people in a call when you join.
                </p>
            ) : (
                <p className="ces-hint ces-hint--strong">
                    Your custom sound is not on this device yet. It arrives with your other devices&rsquo; sync or a backup restore; until then, nobody hears it from here. You can also choose a new one.
                </p>
            )}
            {confirming ? (
                <div className="ces-actions" role="group" aria-label="Confirm removal">
                    <span className="ces-hint ces-hint--strong">Remove your custom sound from all your devices?</span>
                    <ClButton size="sm" variant="danger" onClick={() => { setConfirming(false); onRemove(); }} autoFocus>
                        <Trash2 size={13} className="mr-1" aria-hidden="true" />Remove
                    </ClButton>
                    <ClButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep it</ClButton>
                </div>
            ) : (
                <div className="ces-actions">
                    {here && (
                        <ClButton size="sm" variant="ghost" onClick={() => { void preview(); }}>
                            <Play size={13} className="mr-1" aria-hidden="true" />Preview
                        </ClButton>
                    )}
                    <ClButton size="sm" variant="ghost" onClick={onReplace}>
                        <RefreshCw size={13} className="mr-1" aria-hidden="true" />{here ? 'Replace' : 'Choose a file'}
                    </ClButton>
                    <ClButton size="sm" variant="ghost" onClick={() => setConfirming(true)} loading={removing}>
                        <Trash2 size={13} className="mr-1" aria-hidden="true" />Remove
                    </ClButton>
                </div>
            )}
            {previewErr && <p className="ces-error" role="alert">{previewErr}</p>}
        </div>
    );
};
