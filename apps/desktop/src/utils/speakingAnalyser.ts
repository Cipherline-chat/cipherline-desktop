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
import { logCallEvent } from './callEventLog';
import { slotFor } from './avSyncMonitor';

/**
 * RMS (linear, full scale = 1) above which the ring is lit: -60 dBFS. The rule is "if you can hear them, their ring is
 * lit" (owner, 2026-11-21: "I hate hearing someone and not seeing anyone's ring"). It was 0.018 (-35 dBFS), a SPEECH
 * threshold: room noise, breathing and keys leaving a mic at -40..-55 dBFS were plainly audible with no ring at all,
 * and the analyser read 8-bit samples, which cannot resolve anything under about -45 dBFS in the first place.
 */
export const SPEAKING_THRESHOLD = 0.001;
/** One `ring_level` call event per participant per this much analysed time. */
export const RING_LEVEL_LOG_MS = 60_000;
export const POLL_MS = 30;
export const RELEASE_MS = 300;
export const IDLE_CLOSE_MS = 5000;

interface Entry {
    refCount: number;
    track: MediaStreamTrack;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    buf: Float32Array<ArrayBuffer>;
    speaking: boolean;
    /** our own microphone (logged as self-mic, never given a remote slot) */
    local: boolean;
    /** ring_level window: polls, polls with the ring lit, summed mean-square lit / unlit, loudest unlit mean-square */
    dN: number; dLit: number; dLitMs: number; dQuietMs: number; dQuietMax: number;
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

const db10 = (ms: number): number => Math.round(100 * Math.log10(Math.max(ms, 1e-12))) / 10;

/** The `ring_level` detail for one participant's window, or null when there is nothing to say. Pure. */
export function summarizeRingLevel(e: { dN: number; dLit: number; dLitMs: number; dQuietMs: number; dQuietMax: number }): Record<string, number> | null {
    if (e.dN <= 0) return null;
    const quiet = e.dN - e.dLit;
    const d: Record<string, number> = { lit_pct: Math.round((100 * e.dLit) / e.dN), thr_db: db10(SPEAKING_THRESHOLD * SPEAKING_THRESHOLD) };
    if (e.dLit > 0) d.lit_db = db10(e.dLitMs / e.dLit);
    if (quiet > 0) { d.quiet_db = db10(e.dQuietMs / quiet); d.quiet_max_db = db10(e.dQuietMax); }
    return d;
}

function tick(): void {
    for (const [identity, entry] of entries) {
        entry.analyser.getFloatTimeDomainData(entry.buf);
        let sum = 0;
        for (let i = 0; i < entry.buf.length; i++) {
            const v = entry.buf[i];
            sum += v * v;
        }
        const ms = sum / entry.buf.length;
        const rms = Math.sqrt(ms);
        // Diagnostics: what this track carried while the ring was lit and while it was not, levels only. `speaking`
        // includes the release tail, so `quiet` is strictly "ring off": quiet_max_db under thr_db proves no audible
        // sound went unringed.
        entry.dN++;
        if (rms > SPEAKING_THRESHOLD || entry.speaking) { entry.dLit++; entry.dLitMs += ms; }
        else { entry.dQuietMs += ms; if (ms > entry.dQuietMax) entry.dQuietMax = ms; }
        if (entry.dN * POLL_MS >= RING_LEVEL_LOG_MS) {
            const d = summarizeRingLevel(entry);
            entry.dN = 0; entry.dLit = 0; entry.dLitMs = 0; entry.dQuietMs = 0; entry.dQuietMax = 0;
            // a track that was digital silence for the whole window (muted) says nothing
            if (d && (d.lit_pct > 0 || (d.quiet_db ?? -120) > -110)) {
                try { logCallEvent('ring_level', { slot: entry.local ? 'self-mic' : slotFor(identity), ...d }); } catch { /* logging never breaks the ring */ }
            }
        }
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

function attachSource(mst: MediaStreamTrack): { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null {
    const c = getContext();
    if (!c) return null;
    try {
        const source = c.createMediaStreamSource(new MediaStream([mst]));
        const analyser = c.createAnalyser();
        // 2048 samples = 43 ms at 48 kHz: longer than the 30 ms poll, so no sound falls between two polls (256
        // looked at 5 ms out of every 30)
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.1;
        source.connect(analyser);
        return { source, analyser, buf: new Float32Array(analyser.fftSize) };
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
    local = false,
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
        entry = { ...nodes, track: mst, refCount: 0, speaking: false, offTimer: null, subscribers: new Map(), local, dN: 0, dLit: 0, dLitMs: 0, dQuietMs: 0, dQuietMax: 0 };
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
