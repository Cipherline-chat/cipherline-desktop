/**
 * CallPerformanceGuard — watches whether this PC keeps up during a call, on
 * both sides:
 *   - SEND: our camera / screen-share encoder CPU-limited
 *     (utils/callLoadMonitor.ts);
 *   - RECEIVE: decoding other people's video dropping frames / slow to decode
 *     while the network is fine (utils/receiveLoadMonitor.ts).
 * When either is sustained it offers, once per call, the fix that matches
 * (utils/performanceOffer.ts choosePerfOffer): lower our camera to 720p,
 * show other people's cameras in lower quality ("Reduced" incoming video),
 * or both in one card.
 *
 * Mounted once per call inside <LiveKitRoom> (CallPane). Renders nothing
 * except, at most once per call, the offer card — portalled to <body>
 * because CallPane's own subtree can be display:none, at the same spot as the
 * gaming-mode freeze offer, and only while it holds the shared in-call offer
 * slot, so two prompts never stack.
 *
 * Samples only while an offer is possible: one getStats() per published
 * video source and per subscribed remote camera per second, plus one cheap
 * IPC for process CPU. Nothing is logged, stored or sent about the call; the
 * only persisted state is the offer's snooze/never flags.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useRoomContext } from '@livekit/components-react';
import { Track, RemoteVideoTrack, type Room } from 'livekit-client';
import { Gauge, X } from 'lucide-react';
import { ClButton } from '../cl';
import { useToast } from '../../contexts/ToastContext';
import { CallLoadDetector, layerLimitStats, SAMPLE_INTERVAL_MS, type SourceSample } from '../../utils/callLoadMonitor';
import { ReceiveLoadDetector, inboundVideoStats, parseProcessCpu, type InboundVideoStats } from '../../utils/receiveLoadMonitor';
import {
    canOfferPerf, answerPerfOffer, readPerfOfferState, writePerfOfferState, choosePerfOffer, perfOfferCopy, perfOfferEffects,
    acquireCallOfferSlot, releaseCallOfferSlot, CALL_OFFER_ENTER_CLASS,
    type PerfOfferAnswer, type PerfOfferKind,
} from '../../utils/performanceOffer';
import { useCallOfferAnchor } from '../../hooks/useCallOfferAnchor';
import { setCameraQualityTier, setIncomingVideoMode, getIncomingVideoMode } from '../../utils/cameraQualityPrefs';
import { logCallEvent } from '../../utils/callEventLog';

const SLOT_ID = 'performance';

type SenderTrack = { sender?: RTCRtpSender; mediaStreamTrack?: MediaStreamTrack };
type StatsReportLike = { forEach(cb: (s: Record<string, unknown>) => void): void };

function senderOf(room: Room, source: Track.Source): SenderTrack | undefined {
    const pub = room.localParticipant.getTrackPublication(source);
    if (!pub || pub.isMuted) return undefined;
    return pub.track as unknown as SenderTrack | undefined;
}

function cameraHeight(room: Room): number {
    const t = senderOf(room, Track.Source.Camera);
    const s = t?.mediaStreamTrack?.getSettings?.();
    if (!s?.width || !s?.height) return 0;
    return Math.min(s.width, s.height);
}

async function sampleSource(t: SenderTrack | undefined): Promise<SourceSample | null> {
    if (!t?.sender) return null;
    const report = await t.sender.getStats();
    return { layers: layerLimitStats(report as unknown as StatsReportLike) };
}

/** Inbound stats of every remote camera currently subscribed (paused ones decode nothing and drop out by themselves). */
async function sampleIncoming(room: Room): Promise<InboundVideoStats[]> {
    const out: InboundVideoStats[] = [];
    await Promise.all([...room.remoteParticipants.values()].map(async p => {
        const pub = p.getTrackPublication(Track.Source.Camera);
        const track = pub?.track;
        if (!pub?.isSubscribed || !(track instanceof RemoteVideoTrack)) return;
        try {
            const rep = await track.getRTCStatsReport();
            const s = rep ? inboundVideoStats(pub.trackSid, rep as unknown as StatsReportLike) : null;
            if (s) out.push(s);
        } catch { /* track went away mid-sample */ }
    }));
    return out;
}

async function processCpu(): Promise<number | null> {
    const api = (typeof window !== 'undefined' ? window.electronAPI : undefined) as { getProcessCpu?: () => Promise<unknown> } | undefined;
    if (!api?.getProcessCpu) return null;
    try { return parseProcessCpu(await api.getProcessCpu()); } catch { return null; }
}

export const CallPerformanceGuard: React.FC = () => {
    const room = useRoomContext();
    const toast = useToast();
    const [offer, setOffer] = useState<{ room: Room; kind: PerfOfferKind } | null>(null);
    const offerOpen = !!room && offer?.room === room;
    const shownForRoomRef = useRef<Room | null>(null);

    useEffect(() => {
        if (!room) return;
        const send = new CallLoadDetector();
        const recv = new ReceiveLoadDetector();
        let inFlight = false;
        let stopped = false;
        const gate = () => canOfferPerf({
            state: readPerfOfferState(), now: Date.now(), shownThisCall: shownForRoomRef.current === room,
            cameraHeight: cameraHeight(room), incomingAdjustable: getIncomingVideoMode() === 'auto',
        });
        const tick = async () => {
            if (inFlight || stopped || shownForRoomRef.current === room) return;
            if (!gate()) { send.reset(); recv.reset(); return; }
            inFlight = true;
            try {
                const [camera, share, incoming, cpu] = await Promise.all([
                    sampleSource(senderOf(room, Track.Source.Camera)).catch(() => null),
                    sampleSource(senderOf(room, Track.Source.ScreenShare)).catch(() => null),
                    sampleIncoming(room).catch(() => []),
                    processCpu(),
                ]);
                if (stopped) return;
                const at = performance.now();
                const sv = send.observe({ at, camera, share });
                const rv = recv.observe({ at, tracks: incoming, rendererCpuPct: cpu });
                const kind = choosePerfOffer({
                    encodeStrained: sv.struggling,
                    decodeStrained: rv.decodeBound,
                    cameraHeight: cameraHeight(room),
                    incomingMode: getIncomingVideoMode(),
                    remoteVideoCount: rv.tick?.decodingTracks ?? 0,
                });
                if (!kind || !gate()) return;
                logCallEvent('load_trigger', {
                    encode: sv.struggling, decode: rv.decodeBound, network: rv.networkBound,
                    sources: sv.sources.join('+') || 'none', decoding: rv.tick?.decodingTracks ?? 0,
                    drop_pct: Math.round((rv.tick?.dropRatio ?? 0) * 100), decode_ms: Math.round(rv.tick?.decodeMs ?? 0),
                });
                if (!acquireCallOfferSlot(SLOT_ID)) return; // another offer is up; try again next tick
                shownForRoomRef.current = room;
                setOffer({ room, kind });
                logCallEvent('offer_shown', { offer: kind });
            } catch { /* a failed tick is a skipped sample */ } finally {
                inFlight = false;
            }
        };
        const iv = setInterval(() => { void tick(); }, SAMPLE_INTERVAL_MS);
        return () => { stopped = true; clearInterval(iv); send.reset(); recv.reset(); };
    }, [room]);

    // Free the slot if the call ends with the card open.
    useEffect(() => () => releaseCallOfferSlot(SLOT_ID), []);

    const kind = offer?.kind ?? null;
    const answer = useCallback((a: PerfOfferAnswer) => {
        writePerfOfferState(answerPerfOffer(readPerfOfferState(), a, Date.now()));
        logCallEvent('offer_answer', { offer: kind ?? 'none', answer: a });
        setOffer(null);
        releaseCallOfferSlot(SLOT_ID);
        if (a !== 'lower' || !kind) return;
        const fx = perfOfferEffects(kind);
        if (fx.cameraTier) setCameraQualityTier(fx.cameraTier);
        if (fx.incomingMode) setIncomingVideoMode(fx.incomingMode);
        toast.push({
            kind: 'success',
            message: kind === 'camera'
                ? 'Camera set to 720p. You can change it in Settings → Voice & Video.'
                : kind === 'incoming'
                    ? 'Other people’s cameras now show in lower quality. You can change it in Settings → Voice & Video.'
                    : 'Camera set to 720p and other people’s cameras to lower quality. You can change both in Settings → Voice & Video.',
            durationMs: 6000,
        });
    }, [toast, kind]);

    const anchor = useCallOfferAnchor(offerOpen);
    if (!offerOpen || !kind || typeof document === 'undefined') return null;
    const copy = perfOfferCopy(kind);
    return ReactDOM.createPortal(
        <div className={anchor.className} style={anchor.style}>
            <div
                role="status"
                aria-live="polite"
                aria-label={copy.title}
                className={`pointer-events-auto relative flex items-start gap-3 pl-4 pr-2 py-3 bg-cl-deep border border-white/[0.08] ring-1 ring-cl-lume/30 rounded-xl shadow-2xl overflow-hidden ${CALL_OFFER_ENTER_CLASS}`}
            >
                <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-cl-lume" aria-hidden="true" />
                <span className="shrink-0 mt-0.5 w-8 h-8 rounded-lg grid place-items-center text-cl-lume bg-cl-lume/10" aria-hidden="true">
                    <Gauge size={17} />
                </span>
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-white leading-tight m-0">{copy.title}</p>
                    <p className="text-[12px] text-cl-muted leading-snug m-0 mt-0.5 break-words">{copy.body}</p>
                    <div className="flex items-center gap-2 mt-2.5">
                        <ClButton size="sm" variant="primary" onClick={() => answer('lower')}>{copy.accept}</ClButton>
                        <ClButton size="sm" variant="ghost" onClick={() => answer('not-now')}>{copy.decline}</ClButton>
                    </div>
                    <button
                        type="button"
                        onClick={() => answer('never')}
                        className="mt-2 p-0 bg-transparent border-0 text-[11px] text-cl-faint hover:text-cl-muted underline-offset-2 hover:underline cursor-pointer"
                    >
                        {copy.never}
                    </button>
                </div>
                <ClButton icon size="sm" variant="ghost" onClick={() => answer('not-now')} tooltip="Dismiss">
                    <X size={14} />
                </ClButton>
            </div>
        </div>,
        document.body,
    );
};

export default CallPerformanceGuard;
