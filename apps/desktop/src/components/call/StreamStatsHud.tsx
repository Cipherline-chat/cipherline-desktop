import React from 'react';
import { Track, type LocalVideoTrack, type RemoteVideoTrack, type TrackPublication } from 'livekit-client';
import {
    summarizeSender, summarizeReceiver, fpsTone, captureLimitHint, h264ProfileFromFmtp, bandwidthHint,
    type SenderHudStats, type ReceiverHudStats, type SenderSnapshot, type ReceiverSnapshot, type StatsEntry,
    type CaptureVerdict,
} from '../../utils/streamStatsHud';
import {
    useScreenShareSession, parseCaptureTiming,
    type CaptureTiming, type ScreenShareSession,
} from '../../utils/screenShareDiagnostics';

/**
 * Live stream-stats overlay (Settings → Advanced → "Stream stats overlay").
 *
 * On YOUR share it shows the sender side — what the capturer delivered, what
 * the encoder produced, with which encoder (hardware or software), the
 * bitrate against its cap and the link estimate, and what (if anything) is
 * holding quality back. On someone else's it shows the receiver side — what
 * arrived, what was dropped, which decoder. Reading the two side by side
 * locates a frame-rate shortfall in one hop instead of guessing.
 *
 * Polls the track's own getStats() once a second while mounted; it is only
 * mounted while the overlay is switched on.
 */

const TONE: Record<'ok' | 'warn' | 'bad' | 'neutral', string> = {
    ok: 'text-green-400',
    warn: 'text-amber-300',
    bad: 'text-red-400',
    neutral: 'text-white/90',
};

const fmtFps = (v?: number) => (v === undefined ? '—' : `${Math.round(v)} fps`);
const fmtRes = (w?: number, h?: number) => (w && h ? `${w}×${h}` : '—');
const fmtMbps = (v?: number) => (v === undefined ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)}`);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex gap-2 leading-[1.35]">
        <span className="w-[62px] shrink-0 text-white/45">{label}</span>
        <span className="min-w-0 truncate">{children}</span>
    </div>
);

const HwBadge: React.FC<{ hw: boolean | null }> = ({ hw }) => (
    hw === null
        ? <span className="text-white/45">?</span>
        : <span className={hw ? 'text-green-400' : 'text-amber-300'}>{hw ? 'HW' : 'SW'}</span>
);

interface SenderCaps { maxFramerate?: number; maxBitrate?: number; degradation?: string }

function readSenderCaps(track: LocalVideoTrack): SenderCaps {
    try {
        const p = track.sender?.getParameters();
        const enc = p?.encodings?.reduce<RTCRtpEncodingParameters | undefined>(
            (best, e) => (e.active !== false && (!best || (e.maxBitrate ?? 0) > (best.maxBitrate ?? 0)) ? e : best),
            undefined,
        );
        return { maxFramerate: enc?.maxFramerate, maxBitrate: enc?.maxBitrate, degradation: p?.degradationPreference };
    } catch {
        return {};
    }
}

const VERDICT_TONE: Record<CaptureVerdict, string> = {
    ok: 'text-green-400',
    display: 'text-white/90',
    throttle: 'text-amber-300',
    timer: 'text-amber-300',
    unchanged: 'text-amber-300',
    pipeline: 'text-amber-300',
    capturer: 'text-amber-300',
    encoder: 'text-amber-300',
    network: 'text-amber-300',
    unknown: 'text-white/45',
};

const BACKEND_LABEL: Record<string, string> = {
    wgc: 'WGC', dxgi: 'DXGI', pipewire: 'PipeWire', x11: 'X11', macos: 'macOS', unknown: '?',
};

const yn = (v: boolean | undefined) => (v === undefined ? '?' : v ? '✓' : '✗');

/** Screen-share-only rows: the OS/Chromium side that getStats() cannot show. */
const ShareRows: React.FC<{ session: ScreenShareSession }> = ({ session }) => {
    const m = session.main;
    const hw = session.hw;
    const gpuText = m?.gpus.length
        ? m.gpus.map(g => g.name ?? `${g.vendor} ${g.deviceId.toString(16)}`).join(' + ')
        : '—';
    return (
        <>
            <Row label="source">
                {m ? m.sourceKind : '—'}
                {m?.displayHz
                    // ≈ = not the captured display itself but a stand-in
                    // (the only / the primary display) — see resolveCapturedDisplayHz.
                    ? ` · ${m.displayHzSource && m.displayHzSource !== 'matched' ? '≈' : ''}${Math.round(m.displayHz)} Hz`
                    : ' · ? Hz'}
                {' · '}{m ? BACKEND_LABEL[m.capturer.backend] ?? m.capturer.backend : '?'}
                {m?.capturer.why ? <span className="text-white/45">{` (${m.capturer.why})`}</span> : null}
            </Row>
            <Row label="codec">
                <span className="text-white/60">{session.codecReason}</span>
            </Row>
            <Row label="gpu">
                <span className="text-white/60">{gpuText}</span>
                {m?.videoEncode && m.videoEncode !== 'enabled'
                    ? <span className="text-amber-300">{` · HW encode ${m.videoEncode}`}</span>
                    : null}
            </Row>
            <Row label="hw enc">
                {hw
                    ? <span className="text-white/60">
                        {`H264-CB ${yn(hw.h264)} · High ${yn(hw.h264High)} · VP9 ${yn(hw.vp9)} · VP8 ${yn(hw.vp8)}`}
                    </span>
                    : <span className="text-white/45">probe unavailable</span>}
            </Row>
        </>
    );
};

const encryptionLabel = (pub: TrackPublication | undefined): { text: string; ok: boolean } | null => {
    // Encryption_Type: 0 NONE, 1 GCM, 2 CUSTOM — what the SFU recorded for this
    // publication, i.e. the server's view, not this client's belief.
    const e = (pub as unknown as { trackInfo?: { encryption?: number } } | undefined)?.trackInfo?.encryption;
    if (e === undefined) return null;
    return e === 0 ? { text: 'OFF', ok: false } : { text: e === 1 ? 'GCM' : 'on', ok: true };
};

export const StreamStatsHud: React.FC<{
    track: LocalVideoTrack | RemoteVideoTrack;
    isLocal: boolean;
    publication?: TrackPublication;
}> = ({ track, isLocal, publication }) => {
    const [sender, setSender] = React.useState<SenderHudStats | null>(null);
    const [caps, setCaps] = React.useState<SenderCaps>({});
    const [receiver, setReceiver] = React.useState<ReceiverHudStats | null>(null);
    // What the CAPTURE was asked for — the track's own settings, i.e. the
    // frame rate Chromium's capturer was configured with (not the encoder cap).
    const [captureReqFps, setCaptureReqFps] = React.useState<number | undefined>(undefined);
    const [timing, setTiming] = React.useState<CaptureTiming | null>(null);
    // performance.now() of the last stats poll — read in render instead of
    // calling performance.now() there (render must stay pure).
    const [polledAt, setPolledAt] = React.useState<number | undefined>(undefined);

    const isShare = isLocal && publication?.source === Track.Source.ScreenShare;
    const sessionAll = useScreenShareSession();
    const session = isShare ? sessionAll : null;
    const captureLogOn = !!session?.main?.captureLog;

    // Chromium's per-frame capture timing (Settings → Advanced → Capture timing log).
    React.useEffect(() => {
        if (!captureLogOn || !window.electronAPI?.getScreenCaptureTiming) return;
        let cancelled = false;
        const poll = async () => {
            try {
                const t = parseCaptureTiming(await window.electronAPI!.getScreenCaptureTiming!());
                if (!cancelled) setTiming(t);
            } catch { /* keep last */ }
        };
        void poll();
        const id = setInterval(poll, 2000);
        return () => { cancelled = true; clearInterval(id); };
    }, [captureLogOn]);

    React.useEffect(() => {
        let cancelled = false;
        let prevS: SenderSnapshot | null = null;
        let prevR: ReceiverSnapshot | null = null;
        const poll = async () => {
            try {
                const report = await track.getRTCStatsReport();
                if (cancelled || !report) return;
                const now = performance.now();
                setPolledAt(now);
                if (isLocal) {
                    const r = summarizeSender(report as unknown as Iterable<StatsEntry>, prevS, now);
                    prevS = r.snapshot;
                    setSender(r.stats);
                    setCaps(readSenderCaps(track as LocalVideoTrack));
                    const fr = track.mediaStreamTrack?.getSettings?.().frameRate;
                    setCaptureReqFps(typeof fr === 'number' && fr > 0 ? fr : undefined);
                } else {
                    const r = summarizeReceiver(report as unknown as Iterable<StatsEntry>, prevR, now);
                    prevR = r.snapshot;
                    setReceiver(r.stats);
                }
            } catch { /* track ended between polls — next tick or unmount */ }
        };
        void poll();
        const id = setInterval(poll, 1000);
        return () => { cancelled = true; clearInterval(id); };
    }, [track, isLocal]);

    const enc = encryptionLabel(publication);
    // The bar a share is measured against is the rate it should SEND. The
    // capturer is deliberately asked for more (captureFrameRateFor), so the
    // track's own frameRate is headroom, not the target.
    const reqFps = session?.requestedFps ?? captureReqFps ?? caps.maxFramerate;
    // Labelled "req" only when something actually REQUESTED a rate (the
    // share's target, else the capture track's own setting) — never the
    // encoder cap, which already has its own "/ N" on the encoded row.
    const shownReq = session?.requestedFps ?? captureReqFps;
    const hint = isShare && sender
        ? captureLimitHint({
            captureFps: sender.captureFps,
            requestedFps: reqFps,
            displayHz: session?.main?.displayHz,
            encodedFps: sender.encodedFps,
            limitation: sender.limitation,
            timing,
        })
        : null;
    const bwHint = isLocal && sender
        ? bandwidthHint({
            limitation: sender.limitation,
            availableMbps: sender.availableMbps,
            encodedWidth: sender.encodedWidth, encodedHeight: sender.encodedHeight,
            captureWidth: sender.captureWidth, captureHeight: sender.captureHeight,
            ageSec: session?.startedAt !== undefined && polledAt !== undefined ? (polledAt - session.startedAt) / 1000 : undefined,
        })
        : null;
    const h264Profile = sender?.codec === 'H264' ? h264ProfileFromFmtp(sender.codecFmtp) : undefined;

    return (
        <div className="font-mono text-[10.5px] text-white/90 flex flex-col gap-[1px] min-w-[210px]">
            {isLocal ? (
                sender ? (
                    <>
                        <Row label="capture">
                            <span className={TONE[fpsTone(sender.captureFps, reqFps)]}>{fmtFps(sender.captureFps)}</span>
                            {shownReq ? <span className="text-white/45">{` / req ${Math.round(shownReq)}`}</span> : null}
                            {captureReqFps && shownReq && Math.round(captureReqFps) > Math.round(shownReq)
                                ? <span className="text-white/45">{` (asks ${Math.round(captureReqFps)})`}</span>
                                : null}
                            {' '}<span className="text-white/60">{fmtRes(sender.captureWidth, sender.captureHeight)}</span>
                        </Row>
                        {session && <ShareRows session={session} />}
                        {timing && (
                            <Row label="grab">
                                <span className="text-white/60">
                                    {`${timing.captureMs}ms · every ${timing.periodMs}ms`}
                                    {timing.intervalMs !== undefined ? ` (real ${timing.intervalMs}ms)` : ''}
                                    {` · no-new ${Math.round(timing.unchangedRatio * 100)}%`}
                                    {timing.maxCpuPercent !== undefined ? ` · cpu cap ${timing.maxCpuPercent}%` : ''}
                                    {/* What Chromium actually configured (Windows options line), not the prediction. */}
                                    {timing.wgcScreenAllowed !== undefined ? ` · chromium WGC-screen ${timing.wgcScreenAllowed ? 'on' : 'off (DXGI)'}` : ''}
                                </span>
                            </Row>
                        )}
                        <Row label="encoded">
                            <span className={TONE[fpsTone(sender.encodedFps, caps.maxFramerate)]}>{fmtFps(sender.encodedFps)}</span>
                            {caps.maxFramerate ? <span className="text-white/45"> / {caps.maxFramerate}</span> : null}
                            {' '}<span className="text-white/60">{fmtRes(sender.encodedWidth, sender.encodedHeight)}</span>
                        </Row>
                        <Row label="encoder">
                            {sender.codec ?? '—'}{h264Profile ? ` ${h264Profile}` : ''}{sender.scalabilityMode ? ` ${sender.scalabilityMode}` : ''}{' · '}
                            <HwBadge hw={sender.hardware} />{' '}
                            <span className="text-white/60">{sender.encoder ?? 'hidden'}</span>
                        </Row>
                        <Row label="bitrate">
                            {fmtMbps(sender.sendMbps)}
                            <span className="text-white/45"> / cap {fmtMbps(caps.maxBitrate !== undefined ? caps.maxBitrate / 1e6 : undefined)}</span>
                            <span className="text-white/45"> · link {fmtMbps(sender.availableMbps)} Mbps</span>
                        </Row>
                        <Row label="limit">
                            <span className={sender.limitation && sender.limitation !== 'none' ? 'text-amber-300' : 'text-green-400'}>
                                {sender.limitation ?? '—'}
                            </span>
                            <span className="text-white/45">
                                {' · enc '}{sender.encodeMs !== undefined ? `${sender.encodeMs.toFixed(1)}ms` : '—'}
                                {' · kf '}{sender.keyFramesEncoded ?? '—'}
                                {' · rs '}{sender.resolutionChanges ?? '—'}
                            </span>
                        </Row>
                        <Row label="mode">
                            <span className={caps.degradation === 'maintain-framerate' ? 'text-white/90' : 'text-amber-300'}>
                                {caps.degradation ?? '—'}
                            </span>
                            {enc && <span className={enc.ok ? 'text-green-400' : 'text-red-400'}>{' · e2ee '}{enc.text}</span>}
                            {sender.rttMs !== undefined && <span className="text-white/45">{` · rtt ${Math.round(sender.rttMs)}ms`}</span>}
                        </Row>
                        {hint && hint.verdict !== 'unknown' && (
                            <Row label="limited">
                                <span className={VERDICT_TONE[hint.verdict]}>{hint.text}</span>
                            </Row>
                        )}
                        {bwHint && (
                            // Separate from `limited`: capture and bandwidth can
                            // both bite at once (frame rate from the capturer,
                            // resolution from the link) — name both.
                            <Row label="bw">
                                <span className="text-amber-300">{bwHint}</span>
                            </Row>
                        )}
                    </>
                ) : <span className="text-white/50">stats…</span>
            ) : (
                receiver ? (
                    <>
                        <Row label="received">
                            {/* No colour: the viewer can't know what rate the sharer asked for. */}
                            <span className="text-white/90">{fmtFps(receiver.fps)}</span>
                            {' '}<span className="text-white/60">{fmtRes(receiver.width, receiver.height)}</span>
                        </Row>
                        <Row label="decoder">
                            {receiver.codec ?? '—'}{' · '}<HwBadge hw={receiver.hardware} />{' '}
                            <span className="text-white/60">{receiver.decoder ?? 'hidden'}</span>
                        </Row>
                        <Row label="bitrate">
                            {fmtMbps(receiver.recvMbps)} Mbps
                            <span className={(receiver.lossPct ?? 0) >= 1 ? 'text-amber-300' : 'text-white/45'}>
                                {' · loss '}{receiver.lossPct !== undefined ? `${receiver.lossPct.toFixed(1)}%` : '—'}
                            </span>
                        </Row>
                        <Row label="dropped">
                            <span className={(receiver.droppedPerSec ?? 0) >= 1 ? 'text-amber-300' : 'text-white/90'}>
                                {receiver.droppedPerSec !== undefined ? `${receiver.droppedPerSec.toFixed(0)}/s` : '—'}
                            </span>
                            <span className="text-white/45">
                                {' · total '}{receiver.framesDropped ?? '—'}{' · freezes '}{receiver.freezes ?? '—'}
                            </span>
                        </Row>
                        <Row label="latency">
                            <span className="text-white/60">
                                {'jitter buf '}{receiver.jitterBufferMs !== undefined ? `${Math.round(receiver.jitterBufferMs)}ms` : '—'}
                                {' · dec '}{receiver.decodeMs !== undefined ? `${receiver.decodeMs.toFixed(1)}ms` : '—'}
                            </span>
                            {enc && <span className={enc.ok ? 'text-green-400' : 'text-red-400'}>{' · e2ee '}{enc.text}</span>}
                        </Row>
                    </>
                ) : <span className="text-white/50">stats…</span>
            )}
        </div>
    );
};
