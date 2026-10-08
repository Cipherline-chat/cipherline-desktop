/**
 * Runtime A/V-sync monitor state: the latest per-participant estimate (fed by
 * the stream-stats overlay while it is on, or sampled on demand by
 * sampleAvSync()), plus the A/V-sync call events (callEventLog.ts:
 * av_sync_offset / av_sync_playback_path / av_sync_webaudio_latency, and
 * av_sync_estimate for the issue reporter's snapshot).
 *
 * Privacy: participants are keyed internally by identity, but nothing that
 * leaves this module carries one — snapshots and log events name them by a
 * per-call placeholder ("remote-av-1", "remote-av-2", …), scalars only.
 */
import {
    estimateAvSync, OFFSET_LOG_STEP_MS,
    type AvSyncEstimate, type AvSyncSnapshot, type AvSyncSnapshotEntry, type PlaybackInfo, type PlaybackPath,
    type StatsEntry,
} from './avSync';
import { logCallEvent, type CallEvent } from './callEventLog';

type Source = AvSyncSnapshotEntry['source'];

const slots = new Map<string, string>();
const latest = new Map<string, AvSyncSnapshotEntry>();
const lastLogged = new Map<string, { offsetMs: number; verdict: string; path: PlaybackPath }>();
const loggedContexts = new WeakSet<object>();

/** Placeholder for an identity, stable for the life of the call. */
export function slotFor(identity: string): string {
    let s = slots.get(identity);
    if (!s) {
        s = `remote-av-${slots.size + 1}`;
        slots.set(identity, s);
    }
    return s;
}

const round = (n: number) => Math.round(n);

/** Store an estimate and log it when it moved enough to matter. */
export function recordAvSyncEstimate(identity: string, source: Source, est: AvSyncEstimate, now = Date.now()): void {
    const slot = slotFor(identity);
    const key = `${identity}\u0000${source}`;
    latest.set(key, {
        slot, source, path: est.path,
        offsetMs: round(est.offsetMs), uncertaintyMs: round(est.uncertaintyMs),
        audioPathMs: round(est.audioPathMs), videoPathMs: round(est.videoPathMs),
        verdict: est.verdict, at: now,
    });
    const prev = lastLogged.get(key);
    if (!prev || Math.abs(prev.offsetMs - est.offsetMs) >= OFFSET_LOG_STEP_MS
        || prev.verdict !== est.verdict || prev.path !== est.path) {
        lastLogged.set(key, { offsetMs: est.offsetMs, verdict: est.verdict, path: est.path });
        // snake_case keys and `stream`, not `source` (reserved by the
        // call-event contract — callEventLog.ts / the reporter's call_events).
        logCallEvent('av_sync_offset', {
            slot, stream: source, path: est.path, verdict: est.verdict,
            offset_ms: round(est.offsetMs), uncertainty_ms: round(est.uncertaintyMs),
            audio_path_ms: round(est.audioPathMs), video_path_ms: round(est.videoPathMs),
        });
    }
}

/** Latest estimates no older than `maxAgeMs`, identity-free. For the issue
 *  reporter's call bundle. */
export function getAvSyncSnapshot(maxAgeMs = 15_000, now = Date.now()): AvSyncSnapshotEntry[] {
    return [...latest.values()].filter(e => now - e.at <= maxAgeMs).map(e => ({ ...e }));
}

/**
 * The snapshot as call events (`av_sync_estimate`, one per stream, `t` = when
 * it was estimated) — how the issue reporter's call bundle carries the A/V
 * sync estimate: inside `call_events`, so no wire-schema change. Scalars and
 * placeholders only, same contract as every other call event.
 */
export function avSyncSnapshotEvents(snapshot: readonly AvSyncSnapshotEntry[] = getAvSyncSnapshot()): CallEvent[] {
    return snapshot.map(e => ({
        t: e.at,
        kind: 'av_sync_estimate',
        detail: {
            slot: e.slot, stream: e.source, path: e.path, verdict: e.verdict,
            offset_ms: e.offsetMs, uncertainty_ms: e.uncertaintyMs,
            audio_path_ms: e.audioPathMs, video_path_ms: e.videoPathMs,
        },
    }));
}

// ── On-demand sampling for the issue reporter ───────────────────────────────
// The in-call recorder (components/diagnostics/CallDiagnosticsRecorder) registers
// a sampler bound to the live Room while a call is up; the reporter calls
// sampleAvSyncNow() when it opens, so a report carries a fresh estimate even
// when the stream-stats overlay (the other feeder) is off. No call → no sampler
// → the snapshot is whatever is left (usually nothing).

type AvSyncSampler = () => Promise<AvSyncSnapshotEntry[]>;
let sampler: AvSyncSampler | null = null;

/** Register (or with null, clear) the live-call sampler. Returns an unregister
 *  that only clears it if it is still the registered one. */
export function setAvSyncSampler(fn: AvSyncSampler | null): () => void {
    sampler = fn;
    return () => { if (sampler === fn) sampler = null; };
}

/** Sample now if a call is up (bounded by `timeoutMs`), else return the
 *  current snapshot. Never throws. */
export async function sampleAvSyncNow(timeoutMs = 1500): Promise<AvSyncSnapshotEntry[]> {
    const fn = sampler;
    if (!fn) return getAvSyncSnapshot();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            fn().catch(() => getAvSyncSnapshot()),
            new Promise<AvSyncSnapshotEntry[]>(res => { timer = setTimeout(() => res(getAvSyncSnapshot()), timeoutMs); }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Log a remote audio chain's playback path decision (and what Web Audio
 *  costs, so "compensation" applied/removed is visible with its ms value). */
export function notePlaybackPath(identity: string, kind: 'mic' | 'screen', path: PlaybackPath, webAudioExtraEstMs: number, reason: string): void {
    logCallEvent('av_sync_playback_path', {
        // `chain`, not `kind` (reserved by the call-event contract).
        slot: slotFor(identity), chain: kind, path, reason,
        // Latency the Web Audio path adds over the element path (estimate);
        // 0 when on the element path.
        web_audio_extra_ms: round(webAudioExtraEstMs),
    });
}

/** Log the playback AudioContext's latency figures once per context. */
export function noteWebAudioContext(ctx: { baseLatency?: number; outputLatency?: number; sampleRate?: number }): void {
    if (loggedContexts.has(ctx as object)) return;
    loggedContexts.add(ctx as object);
    logCallEvent('av_sync_webaudio_latency', {
        base_latency_ms: round(((ctx.baseLatency ?? 0) * 1000) * 10) / 10,
        output_latency_ms: round(((ctx.outputLatency ?? 0) * 1000) * 10) / 10,
        sample_rate: ctx.sampleRate ?? 0,
    });
}

/** Call teardown: drop estimates and placeholders (the log keeps its events). */
export function resetAvSyncMonitor(): void {
    slots.clear();
    latest.clear();
    lastLogged.clear();
}

// ── On-demand sampling (no overlay needed) ──────────────────────────────────

interface StatsTrack { getRTCStatsReport?: () => Promise<unknown> }
interface PubLike { source?: string; track?: StatsTrack | null }
interface ParticipantLike { identity: string; trackPublications: { forEach(cb: (pub: PubLike) => void): void } }
export interface AvSyncRoomLike { remoteParticipants?: { forEach(cb: (p: ParticipantLike) => void): void } | null }

const PAIRS: Array<{ video: string; audio: string; source: Source; kind: 'mic' | 'screen' }> = [
    { video: 'camera', audio: 'microphone', source: 'camera', kind: 'mic' },
    { video: 'screen_share', audio: 'screen_share_audio', source: 'screen_share', kind: 'screen' },
];

async function report(t: StatsTrack | null | undefined): Promise<Iterable<StatsEntry> | null> {
    try {
        const r = await t?.getRTCStatsReport?.();
        return (r as Iterable<StatsEntry> | undefined) ?? null;
    } catch {
        return null;
    }
}

/**
 * Sample every remote participant's audio/video pair twice, `intervalMs`
 * apart, and record + return the interval estimates. `playbackOf` supplies
 * the playback path (useParticipantAudio's getRemotePlaybackInfo) — injected
 * so this stays free of the audio module's DOM/worker imports.
 */
export async function sampleAvSync(
    room: AvSyncRoomLike,
    playbackOf: (identity: string, kind: 'mic' | 'screen') => PlaybackInfo | null,
    intervalMs = 1000,
): Promise<AvSyncSnapshotEntry[]> {
    const jobs: Array<{ identity: string; pair: typeof PAIRS[number]; a: StatsTrack; v: StatsTrack }> = [];
    room.remoteParticipants?.forEach(p => {
        const bySource = new Map<string, StatsTrack>();
        p.trackPublications.forEach(pub => { if (pub.source && pub.track) bySource.set(pub.source, pub.track); });
        for (const pair of PAIRS) {
            const v = bySource.get(pair.video);
            const a = bySource.get(pair.audio);
            if (v && a) jobs.push({ identity: p.identity, pair, a, v });
        }
    });
    const first = await Promise.all(jobs.map(async j => ({ a: await report(j.a), v: await report(j.v) })));
    const snaps: Array<AvSyncSnapshot | null> = first.map((r, i) => {
        const pb = playbackOf(jobs[i].identity, jobs[i].pair.kind);
        return r.a && r.v && pb ? estimateAvSync(r.a, r.v, pb, null).snapshot : null;
    });
    await new Promise(res => setTimeout(res, intervalMs));
    await Promise.all(jobs.map(async (j, i) => {
        const pb = playbackOf(j.identity, j.pair.kind);
        const a = await report(j.a);
        const v = await report(j.v);
        if (!a || !v || !pb) return;
        const { estimate } = estimateAvSync(a, v, pb, snaps[i]);
        if (estimate) recordAvSyncEstimate(j.identity, j.pair.source, estimate);
    }));
    return getAvSyncSnapshot();
}
