/**
 * Report-time snapshot of the screen shares in progress.
 *
 * The periodic share_rx_fps / share_net samples are 10 s apart and coalesced
 * while steady - good for "what happened over the last half hour", too coarse
 * for "what is it doing right now". When the user opens the problem reporter
 * while sharing or watching a share, this takes ~10 one-second samples of the
 * same numbers for each active share track, so the report carries a fresh
 * high-frequency window next to the long-running one.
 *
 *   viewer  -> `share_rx_snap`  rx_fps, dec_fps, drop_fps, disp_fps, jb_ms, res, layer, focus, tile
 *   sharer  -> `share_tx_snap`  kbps, cap_kbps, avail_kbps, rtt_ms, loss_pct, enc_ms, enc_fps, sent_fps, src_fps, limit
 *   both    ->  share_ref (shareRef.ts) so the two ends can be matched
 *
 * Same maths as the periodic samples (shareRxStats / shareNetStats /
 * shareHealth), same privacy rules: numbers, a decoder-free enum or two, and
 * the share_ref digest. Candidate pairs, addresses and SIDs are never copied -
 * the readers have no field for them - and every detail goes through the call
 * log's own sanitiser. The events are NOT put in the call-event ring (they would
 * be 10-30 entries of noise in a Copy-call-log): the reporter reads them from
 * the handle and merges them into `call_events`.
 *
 * Bounded: at most MAX_TARGETS tracks, MAX_EVENTS_PER_TARGET events each, one
 * collection of SNAPSHOT_MS. The collection runs in the background; the report
 * built before it finishes simply carries the samples taken so far.
 */
import { sanitizeCallEventDetail, type CallEventDetail } from './callEventLog';
import type { CallEventInput } from './diagnostics/callEventsSource';
import {
    readShareRxSnapshot, buildShareRxDetail, dispFpsBetween,
    type ShareRxSnapshot, type VideoPlaybackSnapshot, type StatsLike,
} from './shareRxStats';
import { readShareNetSnapshot, buildShareNetDetail, type ShareNetSnapshot } from './shareNetStats';
import { readShareEncoderSnapshot, buildShareFpsDetail, type ShareEncoderSnapshot } from './shareHealth';

export const SNAPSHOT_MS = 10_000;
export const SNAPSHOT_INTERVAL_MS = 1_000;
export const MAX_TARGETS = 3;
export const MAX_EVENTS_PER_TARGET = 10;
export const MAX_EVENTS = MAX_TARGETS * MAX_EVENTS_PER_TARGET;

export interface ShareSnapTarget {
    role: 'viewer' | 'sharer';
    /** share_ref, or a promise of it; null when unavailable (the field is then omitted). */
    ref: string | null | Promise<string | null>;
    /** Viewer: the call-log placeholder (remote-video-N). */
    track?: string;
    getReport(): Promise<StatsLike | null | undefined>;
    viewer?: {
        layer(): number | undefined;
        tile(): number | undefined;
        playback(): VideoPlaybackSnapshot | null;
        focus(): boolean;
    };
    sharer?: { capKbps(): number | undefined };
}

export type ShareSnapProvider = () => ShareSnapTarget[];

let provider: ShareSnapProvider | null = null;

/** CallEventMonitor registers this while a call is up (and clears it on leave). Returns an unregister. */
export function setShareSnapProvider(fn: ShareSnapProvider | null): () => void {
    provider = fn;
    return () => { if (provider === fn) provider = null; };
}

export interface ShareSnapshotHandle {
    /** Events taken so far, oldest first, as call-event inputs (`t` = epoch ms). */
    events(): CallEventInput[];
    /** Epoch ms of the newest event (0 when none). */
    latestAt(): number;
    /** Resolves when the collection ended. */
    done: Promise<void>;
    cancel(): void;
}

export interface SnapshotOptions {
    provider?: ShareSnapProvider | null;
    durationMs?: number;
    intervalMs?: number;
    /** performance.now() clock for the maths; Date.now() for event times. */
    perfNow?: () => number;
    epochNow?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

interface TargetState {
    t: ShareSnapTarget;
    ref: string | null;
    count: number;
    prevRx: ShareRxSnapshot | null;
    prevPlay: VideoPlaybackSnapshot | null;
    prevEnc: ShareEncoderSnapshot | null;
    prevNet: ShareNetSnapshot | null;
}

/** Start collecting. Returns null at once when no share is being sent or watched. Never throws. */
export function startShareSnapshot(o: SnapshotOptions = {}): ShareSnapshotHandle | null {
    let targets: ShareSnapTarget[] = [];
    try { targets = (o.provider === undefined ? provider : o.provider)?.().slice(0, MAX_TARGETS) ?? []; } catch { targets = []; }
    if (targets.length === 0) return null;

    const perfNow = o.perfNow ?? (() => performance.now());
    const epochNow = o.epochNow ?? (() => Date.now());
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const interval = o.intervalMs ?? SNAPSHOT_INTERVAL_MS;
    const rounds = Math.max(1, Math.round((o.durationMs ?? SNAPSHOT_MS) / interval));
    const out: CallEventInput[] = [];
    let cancelled = false;
    let latest = 0;

    const states: TargetState[] = targets.map(t => ({ t, ref: null, count: 0, prevRx: null, prevPlay: null, prevEnc: null, prevNet: null }));

    const push = (kind: string, detail: CallEventDetail | undefined) => {
        const d = sanitizeCallEventDetail(detail);
        if (!d || out.length >= MAX_EVENTS) return;
        const t = epochNow();
        out.push({ t, kind, detail: d });
        latest = t;
    };

    const sampleOne = async (s: TargetState): Promise<void> => {
        const report = await s.t.getReport();
        if (cancelled || !report) return;
        const at = perfNow();
        if (s.t.role === 'viewer') {
            const cur = readShareRxSnapshot(report, at);
            if (!cur) return;
            const v = s.t.viewer;
            const play = v?.playback() ?? null;
            const detail = buildShareRxDetail(s.prevRx, cur, {
                shareRef: s.ref ?? undefined, track: s.t.track,
                dispFps: dispFpsBetween(s.prevPlay, play),
                tile: v?.tile(), layer: v?.layer(), focus: v?.focus() ?? false,
            });
            s.prevRx = cur;
            s.prevPlay = play;
            if (detail && s.count < MAX_EVENTS_PER_TARGET) { s.count++; push('share_rx_snap', detail); }
            return;
        }
        const enc = readShareEncoderSnapshot(report, at);
        const net = readShareNetSnapshot(report, at);
        const prevEnc = s.prevEnc;
        const prevNet = s.prevNet;
        if (enc) s.prevEnc = enc;
        if (net) s.prevNet = net;
        if (!enc || !net) return;
        const netD = buildShareNetDetail(prevNet, net, { shareRef: s.ref ?? undefined, capKbps: s.t.sharer?.capKbps() });
        if (!netD) return;
        const fps = buildShareFpsDetail(prevEnc, enc, { targetFps: 0, focused: true, visible: true });
        const detail: CallEventDetail = { ...netD };
        for (const k of ['enc_fps', 'sent_fps', 'src_fps', 'limit']) if (fps[k] !== undefined) detail[k] = fps[k];
        if (s.count < MAX_EVENTS_PER_TARGET) { s.count++; push('share_tx_snap', detail); }
    };

    const run = async (): Promise<void> => {
        for (const s of states) {
            try { s.ref = (await s.t.ref) ?? null; } catch { s.ref = null; }
        }
        for (let i = 0; i <= rounds && !cancelled; i++) {
            await Promise.all(states.map(s => sampleOne(s).catch(() => { /* a track that went away mid-sample */ })));
            if (i < rounds && !cancelled) await sleep(interval);
        }
    };
    const done = run().catch(() => {});

    return {
        events: () => out.map(e => ({ ...e, ...(e.detail ? { detail: { ...e.detail } } : {}) })),
        latestAt: () => latest,
        done,
        cancel: () => { cancelled = true; },
    };
}
