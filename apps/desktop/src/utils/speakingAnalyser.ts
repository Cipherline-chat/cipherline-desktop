/**
 * Fast "is this participant speaking?" detection, shared by every call tile,
 * participant card and roster snapshot (VideoTile's useFastIsSpeaking /
 * subscribeFastSpeaking).
 *
 * LiveKit's own isSpeaking lags (server Active Speaker Detection for remote
 * participants arrives ~1 s apart), so the call UI reads the audio itself:
 * one AnalyserNode per participant identity, polled every 30 ms, RMS against
 * a fixed threshold, with a 300 ms release.
 *
 * ── Cost model (perf pass, 2026-10) ─────────────────────────────────────────
 * This used to create a dedicated AudioContext AND a dedicated 30 ms
 * setInterval per participant. Each AudioContext in Chromium is a real-time
 * audio render thread plus an output stream opened on the default device
 * (on Windows, a WASAPI stream through the audio service), and each was
 * running for the whole call just to feed an analyser that outputs nothing.
 * An 8-person call therefore ran 8 extra audio render threads, 8 device
 * streams and 8 timers (~270 main-thread wakeups/s).
 *
 * Now: ONE analysis context for the whole call, created with a silent sink
 * (`sinkId: { type: 'none' }`, Chromium ≥ 110 — renders on a timer without
 * opening any output device; falls back to a normal context where that
 * option is unsupported), and ONE 30 ms timer that walks every entry. Same
 * threshold, same 30 ms cadence, same 300 ms release — identical behaviour,
 * one render thread instead of N, zero device streams instead of N.
 *
 * Still a SEPARATE context from the playback one (useParticipantAudio): a
 * second MediaStreamAudioSourceNode for the same track inside the playback
 * context makes Chromium split reads between the two consumers ("volume drops
 * after unmute"). Within this analysis context each track has exactly one
 * source node, so sharing it is safe.
 *
 * The context is closed again once nothing has used it for IDLE_CLOSE_MS, so
 * an app with no call keeps no audio thread alive.
 */
import { registerCtxForUnlock } from './audioUnlock';

export const SPEAKING_THRESHOLD = 0.018;
export const POLL_MS = 30;
export const RELEASE_MS = 300;
export const IDLE_CLOSE_MS = 5000;

interface Entry {
    refCount: number;
    track: MediaStreamTrack;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    buf: Uint8Array<ArrayBuffer>;
    speaking: boolean;
    offTimer: ReturnType<typeof setTimeout> | null;
    subscribers: Map<symbol, (speaking: boolean) => void>;
}

const entries = new Map<string, Entry>();
let ctx: AudioContext | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

function createAnalysisContext(): AudioContext {
    // No output device needed: nothing is connected to the destination.
    try {
        return new AudioContext({ sinkId: { type: 'none' } } as AudioContextOptions);
    } catch {
        return new AudioContext();
    }
}

function getContext(): AudioContext | null {
    if (idleCloseTimer) { clearTimeout(idleCloseTimer); idleCloseTimer = null; }
    if (ctx && ctx.state !== 'closed') return ctx;
    try {
        ctx = createAnalysisContext();
    } catch {
        ctx = null;
        return null;
    }
    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => { /* retried on the next user gesture */ });
        registerCtxForUnlock(ctx);
    }
    return ctx;
}

function tick(): void {
    for (const entry of entries.values()) {
        entry.analyser.getByteTimeDomainData(entry.buf);
        let sum = 0;
        for (let i = 0; i < entry.buf.length; i++) {
            const v = (entry.buf[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / entry.buf.length);
        if (rms > SPEAKING_THRESHOLD) {
            if (entry.offTimer) { clearTimeout(entry.offTimer); entry.offTimer = null; }
            if (!entry.speaking) { entry.speaking = true; entry.subscribers.forEach(cb => cb(true)); }
        } else if (entry.speaking && !entry.offTimer) {
            const e = entry;
            e.offTimer = setTimeout(() => {
                e.speaking = false;
                e.offTimer = null;
                e.subscribers.forEach(cb => cb(false));
            }, RELEASE_MS);
        }
    }
}

function ensurePolling(): void {
    if (!pollTimer && entries.size > 0) pollTimer = setInterval(tick, POLL_MS);
}

function stopIfIdle(): void {
    if (entries.size > 0) return;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (ctx && !idleCloseTimer) {
        idleCloseTimer = setTimeout(() => {
            idleCloseTimer = null;
            if (entries.size === 0 && ctx) {
                const c = ctx;
                ctx = null;
                c.close().catch(() => {});
            }
        }, IDLE_CLOSE_MS);
    }
}

function attachSource(mst: MediaStreamTrack): { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> } | null {
    const c = getContext();
    if (!c) return null;
    try {
        const source = c.createMediaStreamSource(new MediaStream([mst]));
        const analyser = c.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.1;
        source.connect(analyser);
        return { source, analyser, buf: new Uint8Array(analyser.frequencyBinCount) };
    } catch {
        return null;
    }
}

function detach(entry: Entry): void {
    if (entry.offTimer) { clearTimeout(entry.offTimer); entry.offTimer = null; }
    try { entry.source.disconnect(); } catch { /* already gone */ }
    try { entry.analyser.disconnect(); } catch { /* already gone */ }
}

/** Subscribe `onChange` to identity's speaking state, analysing `mst`.
 *  Returns a token for release, or null when analysis is unavailable. */
export function acquireSpeakingAnalyser(
    identity: string,
    mst: MediaStreamTrack,
    onChange: (speaking: boolean) => void,
): symbol | null {
    let entry = entries.get(identity);

    if (entry && entry.track !== mst) {
        // Track replaced (participant unmuted or rejoined) — re-point in
        // place, carrying over refCount and subscribers.
        detach(entry);
        const nodes = attachSource(mst);
        if (!nodes) {
            entries.delete(identity);
            stopIfIdle();
            return null;
        }
        entry = { ...entry, ...nodes, track: mst, speaking: false, offTimer: null };
        entries.set(identity, entry);
    } else if (!entry) {
        const nodes = attachSource(mst);
        if (!nodes) { stopIfIdle(); return null; }
        entry = { ...nodes, track: mst, refCount: 0, speaking: false, offTimer: null, subscribers: new Map() };
        entries.set(identity, entry);
    }
    ensurePolling();

    const token = Symbol();
    entry.refCount++;
    entry.subscribers.set(token, onChange);
    onChange(entry.speaking); // sync to current state immediately
    return token;
}

export function releaseSpeakingAnalyser(identity: string, token: symbol): void {
    const entry = entries.get(identity);
    if (!entry || !entry.subscribers.has(token)) return;
    entry.subscribers.delete(token);
    entry.refCount--;
    if (entry.refCount <= 0) {
        detach(entry);
        entries.delete(identity);
        stopIfIdle();
    }
}

/** Test/diagnostic hook. */
export function speakingAnalyserStats(): { entries: number; contextOpen: boolean; polling: boolean } {
    return { entries: entries.size, contextOpen: !!ctx && ctx.state !== 'closed', polling: !!pollTimer };
}
