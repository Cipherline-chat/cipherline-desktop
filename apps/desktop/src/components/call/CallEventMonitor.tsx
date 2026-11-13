/**
 * CallEventMonitor — feeds utils/callEventLog.ts with what the call's own
 * stats say, every 2 s, inside <LiveKitRoom> (CallPane). Renders nothing.
 *
 *   - call_join / call_leave / participants: COUNTS only;
 *   - reconnecting / reconnected;
 *   - ice_route: per peer connection, the selected candidate pair's local and
 *     remote candidate TYPES (host / srflx / prflx / relay), whether TURN is
 *     in use and its transport — never an address or port;
 *   - quality_limitation: our camera / share encoder's reason transitions
 *     (none ↔ cpu / bandwidth / other) with how long the previous one lasted;
 *   - dynacast_layers: which of our simulcast encodings are running;
 *   - freeze_start / freeze_end: a remote video that is subscribed, enabled
 *     and was decoding stops decoding (and later resumes, with the duration);
 *     freeze_start says whether Cipherline was in the background (`bg`) and
 *     whether packets were still arriving (`rx`) - "the sender stopped" and
 *     "we stopped decoding what arrives" need different fixes. A SCREEN SHARE's
 *     freeze lines also carry its share_ref, the packets / frames received,
 *     loss %, keyframe requests, NACKs and jitter buffer during the freeze
 *     (`rx` = no_packets | packets | frames), and a share_rx_ring of the last
 *     seconds, one value per second (utils/shareFreezeContext.ts, shareFreezeLog.ts,
 *     shareSecondRing.ts - fed by a 1 s read of each watched share);
 *   - share_rx_dead: a remote SCREEN SHARE that has not decoded one frame
 *     RX_DEAD_MS after subscribing (utils/rxDeadShare.ts) - the freeze
 *     detector never sees a video that never started;
 *   - rx_layer: a remote video's DECODED size changed (a layer switch — ours
 *     or the SFU's congestion control — or the sender scaling), with the
 *     quality we were asking for;
 *   - rx_video_health: per remote video, every 10 s window that lost packets
 *     or sent keyframe requests (PLI/FIR): loss %, PLIs, keyframes decoded,
 *     NACKs — nothing for a healthy camera; a screen share also gets one
 *     quiet line a minute (packets in the window), so silence means "not
 *     sampled" rather than "fine";
 *   - share_rx_fallback: a remote SCREEN SHARE's full layer was losing
 *     packets / stuck, so we hold it at its lower layer (or lifted that) —
 *     utils/shareLossFallback.ts. The viewer is told on the share itself once
 *     the lighter copy is on screen (utils/shareFallbackNotice.ts →
 *     call/ShareFallbackNote.tsx);
 *   - share_rx_optout: the viewer chose "Keep full quality" on that notice:
 *     the fallback is off for the rest of that share (capped = a cap came off);
 *   - share_rx_fps / share_rx_start / share_display (utils/shareRxWatch.ts):
 *     per watched remote SCREEN SHARE, from the SAME stats report as the
 *     freeze / loss checks - frames received / decoded / dropped / presented
 *     per second, jitter-buffer ms, size, layer, focus, tile size every ~10 s
 *     (coalesced while steady), the decoder once, and this window's display
 *     refresh rate (one ~0.5 s rAF measurement per share). All carry `share_ref`,
 *     a digest of the track SID (utils/shareRef.ts), to match the sharer's report;
 *   - rx_decoder_lost: a remote video (camera or share) whose decoder became
 *     libwebrtc's "NullVideoDecoder" - the hardware H.265 decoder died mid-stream
 *     and Chromium has no software HEVC, so packets arrive and nothing is ever
 *     shown. Says how long ago that video's displayed <video> element last
 *     changed, and withdraws OUR H.265 decode so publishers resend in H.264
 *     (utils/rxDecoderLost.ts);
 *   - share_rx_flush: a remote SCREEN SHARE that keeps receiving frames while
 *     none decodes (share_rx_stall) gets its input paused at the SFU so the
 *     decoder can drain, then the lighter copy, then H.264 if it keeps happening
 *     (utils/shareRxStallRecovery.ts);
 *   - e2ee_decrypt_error: LiveKit's frame cryptor failed to decrypt a peer's
 *     frame (reason enum only — the SDK's message can carry an identity).
 *     Already throttled by the SDK (≤ 1/s, ≤ 5/min per cryptor) and coalesced
 *     here. A steady trickle with freezes = frames dropped before the decoder
 *     (see utils/e2eeAnnexB.ts).
 *
 * Tracks are named by placeholder (self-camera, remote-video-1, …) — see
 * callEventLog.trackPlaceholder. Nothing here is sent anywhere.
 */
import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track, RemoteVideoTrack, type Room, type RemoteTrackPublication } from 'livekit-client';
import { logCallEvent, markCallStart, markCallEnd, trackPlaceholder } from '../../utils/callEventLog';
import { resetAvSyncMonitor } from '../../utils/avSyncMonitor';
import { iceRouteFromStats, layerStateString, type StatsLike } from '../../utils/callEventStats';
import { decryptErrorReason } from '../../utils/e2eeWorkerStats';
import { ShareLossFallback, readInboundVideo, lossPctBetween, shareRxFallbackDetail, type InboundVideoCounters } from '../../utils/shareLossFallback';
import { appliedQuality, claimedQuality, normaliseLayers, setQualityCeiling } from '../../utils/remoteVideoQuality';
import { shareFallbackNotice } from '../../utils/shareFallbackNotice';
import { isWindowBackground } from '../../utils/shareBackgroundProbe';
import { RxDeadShareWatch, rxSince } from '../../utils/rxDeadShare';
import { ShareRxWatch } from '../../utils/shareRxWatch';
import { presentProbeFor } from '../../utils/videoPresentProbe';
import { readPlaybackSnapshot, readShareRxSnapshot, pickShareVideoElements, type StatsLike as ShareStatsLike, type VideoPlaybackSnapshot } from '../../utils/shareRxStats';
import { freezeCounters, freezeDelta, quietHealthDue, type FreezeCounters } from '../../utils/shareFreezeContext';
import { logShareFreezeStart, logShareFreezeEnd } from '../../utils/shareFreezeLog';
import { RxDecoderLostWatch, isDecoderDead, withdrawH265Decode } from '../../utils/rxDecoderLost';
import { ShareRxStallRecovery } from '../../utils/shareRxStallRecovery';
import { pauseRemoteVideoBriefly } from '../../utils/remoteVideoDemand';
import { resolveShareRef } from '../../utils/shareRef';
import { measureDisplayHz } from '../../utils/displayRefresh';
import { capKbpsFromEncodings } from '../../utils/shareNetStats';
import { setShareSnapProvider, type ShareSnapTarget } from '../../utils/shareSnapshot';

/** rx_video_health window: one line per remote video per window, only when it lost packets or asked for keyframes. */
const RX_HEALTH_WINDOW_MS = 10_000;

interface PcLike { getStats(): Promise<StatsLike> }

function peerConnections(room: Room): { name: string; pc: PcLike }[] {
    const mgr = (room as unknown as { engine?: { pcManager?: { publisher?: { getStats(): Promise<StatsLike> }; subscriber?: { getStats(): Promise<StatsLike> } } } }).engine?.pcManager;
    const out: { name: string; pc: PcLike }[] = [];
    if (mgr?.publisher) out.push({ name: 'publisher', pc: mgr.publisher });
    if (mgr?.subscriber) out.push({ name: 'subscriber', pc: mgr.subscriber });
    return out;
}

/**
 * The <video> elements a share is shown in: the largest rendered one (its size
 * is the tile) and the largest one that is actually being drawn (its playback
 * counters are the presented frames - a hidden / off-screen / paused copy
 * presents nothing, and its zeros are not the display's; none = unknown).
 */
function shareVideoElements(track: RemoteVideoTrack): { largest: HTMLVideoElement | null; presenting: HTMLVideoElement | null } {
    try {
        const els = track.attachedElements.filter((el): el is HTMLVideoElement => typeof HTMLVideoElement !== 'undefined' && el instanceof HTMLVideoElement);
        return pickShareVideoElements(els, { width: window.innerWidth, height: window.innerHeight });
    } catch { /* detached mid-read */ }
    return { largest: null, presenting: null };
}

interface ShareTileInfo { tile?: number; playback: VideoPlaybackSnapshot | null; playbackKey: object | null }
function shareTileInfo(track: RemoteVideoTrack, at: number): ShareTileInfo {
    const { largest, presenting } = shareVideoElements(track);
    const short = largest ? Math.min(largest.clientWidth, largest.clientHeight) : 0;
    return {
        tile: short > 0 ? short : undefined,
        playback: presenting ? readPlaybackSnapshot(presenting, at) : null,
        playbackKey: presenting,
    };
}
const hasFocus = (): boolean => { try { return document.hasFocus(); } catch { return false; } };

/** The publication's layers, and whether its tiles ask for the top one (before any fallback cap). */
function layersAndWant(pub: RemoteTrackPublication): { layers: ReturnType<typeof normaliseLayers>; wantsTop: boolean } {
    const layers = normaliseLayers(pub.trackInfo?.layers);
    const claimed = claimedQuality(pub);
    return { layers, wantsTop: layers.length > 1 && claimed !== undefined && claimed >= layers[layers.length - 1].quality };
}

export const CallEventMonitor: React.FC = () => {
    const room = useRoomContext();

    useEffect(() => {
        if (!room) return;
        markCallStart();
        resetAvSyncMonitor(); // A/V-sync placeholders (remote-av-N) are per call too
        const count = () => room.remoteParticipants.size + 1;
        logCallEvent('call_join', { participants: count() });
        const onCount = () => logCallEvent('participants', { count: count() });
        const onReconnecting = () => logCallEvent('reconnecting');
        const onReconnected = () => { logCallEvent('reconnected'); ice.clear(); };
        room.on(RoomEvent.ParticipantConnected, onCount);
        room.on(RoomEvent.ParticipantDisconnected, onCount);
        room.on(RoomEvent.Reconnecting, onReconnecting);
        room.on(RoomEvent.Reconnected, onReconnected);
        const onDecryptError = (err: unknown) => logCallEvent('e2ee_decrypt_error', { reason: decryptErrorReason(err) });
        room.on(RoomEvent.EncryptionError, onDecryptError);

        const ice = new Map<string, string>();
        const qlr = new Map<string, { reason: string; since: number }>();
        const layers = new Map<string, string>();
        // fc / fbase (shares): the freeze counters at the last sample / at the sample before the freeze was seen (shareFreezeContext.ts).
        const decode = new Map<string, { frames: number; packets: number; frozenSince: number | null; dead: RxDeadShareWatch | null; lost: RxDecoderLostWatch; fc: FreezeCounters | null; fbase: FreezeCounters | null }>();
        // `noticed`: the viewer has been told about the current cap (shareFallbackNotice.ts).
        const rx = new Map<string, { pub: RemoteTrackPublication; prev: InboundVideoCounters; win: InboundVideoCounters; winAt: number; size: string; fb: ShareLossFallback | null; noticed: boolean; quietAt: number }>();
        // "Keep full quality" on the notice: off for the rest of this share, and the cap comes off now.
        const offKeep = shareFallbackNotice.onKeepFullQuality(sid => {
            const r = rx.get(sid);
            const name = trackPlaceholder(sid, 'remote-screen');
            const d = r?.fb ? r.fb.optOut() : null;
            if (r && d?.changed) {
                setQualityCeiling(r.pub, null);
                logCallEvent('share_rx_fallback', shareRxFallbackDetail(name, d, null));
            }
            logCallEvent('share_rx_optout', { track: name, capped: !!d?.changed });
        });
        // One per watched remote screen share (share_rx_fps...), keyed by track SID (a map key only).
        const watches = new Map<string, { watch: ShareRxWatch; pub: RemoteTrackPublication; name: string; recovery: ShareRxStallRecovery }>();
        const newShareWatch = (pub: RemoteTrackPublication, name: string) => {
            const watch = new ShareRxWatch();
            const recovery = new ShareRxStallRecovery({
                now: () => performance.now(),
                pause: () => pauseRemoteVideoBriefly(pub),
                cap: () => {
                    const r = rx.get(pub.trackSid);
                    if (!r?.fb) return false;
                    const { layers, wantsTop } = layersAndWant(pub);
                    const d = r.fb.capForStall({ now: performance.now(), wantsTop, layers: layers.length });
                    if (!d.changed) return false;
                    setQualityCeiling(pub, layers[0]?.quality ?? null);
                    logCallEvent('share_rx_fallback', shareRxFallbackDetail(name, d, null));
                    r.noticed = false;
                    return true;
                },
                withdrawH265: () => watch.latest?.codec === 'h265' && withdrawH265Decode(room, { codec: 'h265', el_ms: -1 }),
                log: d => logCallEvent('share_rx_flush', { ...d, track: name, ...(watch.shareRef ? { share_ref: watch.shareRef } : {}) }),
                setTimer: (cb, ms) => setTimeout(cb, ms),
                clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
            });
            return { watch, pub, name, recovery };
        };
        // Report-time snapshot of the shares in progress (utils/shareSnapshot.ts).
        const offSnap = setShareSnapProvider((): ShareSnapTarget[] => {
            const out: ShareSnapTarget[] = [];
            const lp = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
            const sender = (lp?.track as { sender?: RTCRtpSender } | undefined)?.sender;
            if (lp && sender && !lp.isMuted) {
                out.push({
                    role: 'sharer', ref: resolveShareRef(lp.trackSid),
                    getReport: () => sender.getStats() as unknown as Promise<ShareStatsLike>,
                    sharer: { capKbps: () => { try { return capKbpsFromEncodings(sender.getParameters().encodings); } catch { return undefined; } } },
                });
            }
            for (const { watch, pub, name } of watches.values()) {
                const track = pub.track;
                if (!(track instanceof RemoteVideoTrack)) continue;
                out.push({
                    role: 'viewer', ref: watch.shareRef ?? resolveShareRef(pub.trackSid), track: name,
                    getReport: () => track.getRTCStatsReport() as Promise<ShareStatsLike | undefined>,
                    viewer: {
                        layer: () => appliedQuality(pub),
                        tile: () => shareTileInfo(track, performance.now()).tile,
                        playback: () => shareTileInfo(track, performance.now()).playback,
                        focus: hasFocus,
                    },
                });
            }
            return out;
        });
        let busy = false;

        const sample = async () => {
            if (busy) return;
            busy = true;
            try {
                const now = performance.now();
                for (const { name, pc } of peerConnections(room)) {
                    try {
                        const route = iceRouteFromStats(await pc.getStats());
                        if (!route) continue;
                        const key = `${route.local}/${route.remote}/${route.protocol}`;
                        if (ice.get(name) !== key) {
                            ice.set(name, key);
                            logCallEvent('ice_route', { pc: name, type: route.relay ? 'relay' : route.local, local: route.local, remote: route.remote, turn: route.relay, protocol: route.protocol });
                        }
                    } catch { /* pc closing */ }
                }
                // Our encoders.
                for (const [source, label] of [[Track.Source.Camera, 'self-camera'], [Track.Source.ScreenShare, 'self-screen']] as const) {
                    const pub = room.localParticipant.getTrackPublication(source);
                    const sender = (pub?.track as { sender?: RTCRtpSender } | undefined)?.sender;
                    if (!sender || pub?.isMuted) { qlr.delete(label); layers.delete(label); continue; }
                    const ls = layerStateString(sender.getParameters().encodings);
                    if (ls && layers.get(label) !== ls) {
                        if (layers.has(label)) logCallEvent('dynacast_layers', { track: label, layers: ls });
                        layers.set(label, ls);
                    }
                    let reason = 'none';
                    let topArea = -1;
                    (await sender.getStats()).forEach((s: Record<string, unknown>) => {
                        if (s.type !== 'outbound-rtp' || s.kind !== 'video' || s.active === false) return;
                        const a = (Number(s.frameWidth) || 0) * (Number(s.frameHeight) || 0);
                        if (a > topArea && typeof s.qualityLimitationReason === 'string') { topArea = a; reason = s.qualityLimitationReason; }
                    });
                    const prev = qlr.get(label);
                    if (!prev) qlr.set(label, { reason, since: now });
                    else if (prev.reason !== reason) {
                        logCallEvent('quality_limitation', { track: label, from: prev.reason, to: reason, prev_seconds: Math.round((now - prev.since) / 1000) });
                        qlr.set(label, { reason, since: now });
                    }
                }
                // Remote video freezes.
                const seen = new Set<string>();
                for (const p of room.remoteParticipants.values()) {
                    for (const source of [Track.Source.Camera, Track.Source.ScreenShare]) {
                        const pub = p.getTrackPublication(source);
                        const track = pub?.track;
                        // Paused by the stall recovery: still this share, not one that went away.
                        const flushing = !!pub && !!watches.get(pub.trackSid)?.recovery.flushing;
                        if (!pub?.isSubscribed || (!pub.isEnabled && !flushing) || pub.isMuted || !(track instanceof RemoteVideoTrack)) continue;
                        seen.add(pub.trackSid);
                        const report = await track.getRTCStatsReport() as StatsLike | undefined;
                        const cur = readInboundVideo(report);
                        const frames = cur?.framesDecoded ?? 0;
                        const packets = cur?.packetsReceived ?? 0;
                        const st = decode.get(pub.trackSid);
                        const name = trackPlaceholder(pub.trackSid, source === Track.Source.Camera ? 'remote-video' : 'remote-screen');
                        const isShare = source === Track.Source.ScreenShare;
                        const fcNow = isShare && cur ? freezeCounters(cur, readShareRxSnapshot(report as ShareStatsLike | undefined, now)) : null;
                        if (!st) {
                            const dead = source === Track.Source.ScreenShare ? new RxDeadShareWatch() : null;
                            dead?.observe(now, frames, packets);
                            decode.set(pub.trackSid, { frames, packets, frozenSince: null, dead, lost: new RxDecoderLostWatch(), fc: fcNow, fbase: null });
                        } else {
                            if (frames === st.frames && frames > 0 && st.frozenSince === null) {
                                st.frozenSince = now;
                                if (isShare) {
                                    // A share freeze says which side stopped: counters, jitter buffer, the last seconds (shareFreezeLog.ts).
                                    st.fbase = st.fc;
                                    logShareFreezeStart({ track: name, bg: isWindowBackground(), delta: freezeDelta(st.fc, fcNow), watch: watches.get(pub.trackSid)?.watch, now });
                                } else {
                                    logCallEvent('freeze_start', { track: name, bg: isWindowBackground(), rx: rxSince(st.packets, packets) });
                                }
                            } else if (frames !== st.frames && st.frozenSince !== null) {
                                if (isShare) {
                                    logShareFreezeEnd({ track: name, ms: Math.round(now - st.frozenSince), delta: freezeDelta(st.fbase, fcNow), watch: watches.get(pub.trackSid)?.watch, now });
                                } else {
                                    logCallEvent('freeze_end', { track: name, ms: Math.round(now - st.frozenSince) });
                                }
                                st.frozenSince = null;
                                st.fbase = null;
                            }
                            const dead = st.dead?.observe(now, frames, packets);
                            if (dead) {
                                logCallEvent('share_rx_dead', { track: name, phase: dead.phase, rx: dead.rx, packets: dead.packets, ms: dead.ms ?? NaN, bg: isWindowBackground() });
                            }
                            st.frames = frames;
                            st.packets = packets;
                            st.fc = fcNow;
                        }
                        {
                            // Camera or share: has the decoder been replaced by the one that shows nothing?
                            const info = shareTileInfo(track, now);
                            const rxs = readShareRxSnapshot(report as ShareStatsLike | undefined, now);
                            const lost = decode.get(pub.trackSid)?.lost.observe(now, rxs, { tile: info.tile, playbackKey: info.playbackKey });
                            if (lost) {
                                const withdrawn = withdrawH265Decode(room, lost);
                                logCallEvent('rx_decoder_lost', {
                                    track: name, codec: lost.codec ?? '', decoder: rxs?.decoder ?? '', tile: lost.tile ?? NaN,
                                    el_ms: lost.el_ms, action: withdrawn ? 'h264' : 'none',
                                });
                            }
                        }
                        if (source === Track.Source.ScreenShare) {
                            let w = watches.get(pub.trackSid);
                            if (!w) {
                                w = newShareWatch(pub, name);
                                w.watch.setRef(await resolveShareRef(pub.trackSid));
                                watches.set(pub.trackSid, w);
                            }
                            const tileInfo = shareTileInfo(track, now);
                            const o = w.watch.observe(now, report as ShareStatsLike | undefined, {
                                track: name, layer: appliedQuality(pub), tile: tileInfo.tile, focus: hasFocus(),
                                playback: tileInfo.playback, playbackKey: tileInfo.playbackKey,
                            });
                            // NaN / '' / undefined = not measured: the log drops them.
                            if (o.start) {
                                logCallEvent('share_rx_start', {
                                    share_ref: o.start.share_ref, track: o.start.track, codec: o.start.codec, decoder: o.start.decoder,
                                    hw: o.start.hw, res: o.start.res, layer: o.start.layer,
                                });
                            }
                            if (o.stall) logCallEvent('share_rx_stall', o.stall);
                            // A dead decoder has its own way out (rx_decoder_lost above); a pause cannot help it.
                            w.recovery.tick(w.watch.stalled && !isDecoderDead(w.watch.latest?.decoder), frames);
                            if (o.fps) {
                                logCallEvent('share_rx_fps', {
                                    share_ref: o.fps.share_ref, track: o.fps.track, rx_fps: o.fps.rx_fps, dec_fps: o.fps.dec_fps,
                                    drop_fps: o.fps.drop_fps, disp_fps: o.fps.disp_fps, jb_ms: o.fps.jb_ms, res: o.fps.res,
                                    layer: o.fps.layer, focus: o.fps.focus, tile: o.fps.tile,
                                });
                            }
                            // Where decoded frames go before the paint (utils/videoPresentProbe.ts): same 10 s cadence as
                            // share_rx_fps, its own event because that one already carries 12 keys.
                            if (o.fps) {
                                const el = shareVideoElements(track).presenting;
                                const pw = el && !document.hidden ? presentProbeFor(el)?.drain() : null;
                                if (pw) logCallEvent('share_present', { share_ref: o.fps.share_ref, track: o.fps.track, vf_fps: pw.vf_fps, pres_fps: pw.pres_fps ?? NaN, gap_p95_ms: pw.gap_p95_ms, gap_max_ms: pw.gap_max_ms, late_pct: pw.late_pct, dec_fps: o.fps.dec_fps });
                            }
                            // The display refresh rate, once per watched share (a short rAF burst, not a loop).
                            if (!document.hidden && w.watch.claimHzMeasurement(now)) {
                                const watch = w.watch;
                                void measureDisplayHz({ visible: () => !document.hidden }).then(hz => {
                                    const d = watch.finishHz(hz, performance.now());
                                    if (d) logCallEvent('share_display', { share_ref: d.share_ref, role: d.role, hz: d.hz, hz_src: d.hz_src });
                                }).catch(() => { watch.finishHz(null, performance.now()); });
                            }
                        }
                        if (!cur) continue;
                        // Receive-side health: layer changes, loss / keyframe requests,
                        // and (screen shares) the fall-back to the lower layer.
                        const size = cur.frameWidth > 0 && cur.frameHeight > 0 ? `${cur.frameWidth}x${cur.frameHeight}` : '';
                        const r = rx.get(pub.trackSid);
                        if (!r) {
                            // First reading: a baseline only (no deltas yet).
                            const fb = source === Track.Source.ScreenShare ? new ShareLossFallback() : null;
                            // Watched again after a pause: the viewer's choice for this share still holds.
                            if (fb && shareFallbackNotice.isOptedOut(pub.trackSid)) fb.optOut();
                            rx.set(pub.trackSid, { pub, prev: cur, win: cur, winAt: now, size, fb, noticed: false, quietAt: now });
                            continue;
                        }
                        if (size && size !== r.size) {
                            if (r.size) logCallEvent('rx_layer', { track: name, size, from: r.size, quality: appliedQuality(pub) ?? -1 });
                            r.size = size;
                        }
                        const loss = lossPctBetween(r.prev, cur);
                        // A pause of our own is not "the lower layer stopped arriving".
                        if (r.fb && !flushing) {
                            const { layers, wantsTop } = layersAndWant(pub);
                            const d = r.fb.observe({
                                now,
                                lossPct: loss,
                                frozen: frames > 0 && frames === r.prev.framesDecoded,
                                keyframeAsked: cur.pliCount + cur.firCount > r.prev.pliCount + r.prev.firCount,
                                wantsTop,
                                layers: layers.length,
                                packets: Math.max(0, cur.packetsReceived - r.prev.packetsReceived),
                                frameShort: cur.frameWidth > 0 && cur.frameHeight > 0 ? Math.min(cur.frameWidth, cur.frameHeight) : undefined,
                                decoderStalled: watches.get(pub.trackSid)?.watch.stalled,
                            });
                            if (d.changed) {
                                setQualityCeiling(pub, d.cap ? layers[0]?.quality ?? null : null);
                                logCallEvent('share_rx_fallback', shareRxFallbackDetail(name, d, loss));
                                if (!d.cap) shareFallbackNotice.lifted(pub.trackSid, d.reason);
                                r.noticed = false;
                            }
                            // Told only once the lighter copy is what is on screen: until then it
                            // may never arrive ('no_low_layer'), and the note would be untrue.
                            if (r.fb.lowShowing && !r.noticed) {
                                r.noticed = true;
                                const low = layers[0];
                                shareFallbackNotice.showLighter(pub.trackSid, r.fb.lowShort ?? (low && low.width > 0 && low.height > 0 ? Math.min(low.width, low.height) : null));
                            }
                        }
                        r.prev = cur;
                        if (now - r.winAt >= RX_HEALTH_WINDOW_MS) {
                            const wLoss = lossPctBetween(r.win, cur) ?? 0;
                            const pli = Math.max(0, cur.pliCount - r.win.pliCount) + Math.max(0, cur.firCount - r.win.firCount);
                            // A healthy share still writes one line a minute, so silence means "not sampled", not "fine".
                            if (wLoss >= 1 || pli > 0 || (source === Track.Source.ScreenShare && quietHealthDue(now, r.quietAt))) {
                                r.quietAt = now;
                                const shareRef = watches.get(pub.trackSid)?.watch.shareRef ?? '';
                                logCallEvent('rx_video_health', {
                                    track: name, loss_pct: wLoss, pli,
                                    kf: Math.max(0, cur.keyFramesDecoded - r.win.keyFramesDecoded),
                                    nack: Math.max(0, cur.nackCount - r.win.nackCount),
                                    window_s: Math.round((now - r.winAt) / 1000),
                                    capped: !!r.fb?.capped,
                                    packets: Math.max(0, cur.packetsReceived - r.win.packetsReceived),
                                    share_ref: shareRef,
                                });
                            }
                            r.win = cur;
                            r.winAt = now;
                        }
                    }
                }
                for (const sid of [...decode.keys()]) if (!seen.has(sid)) decode.delete(sid);
                for (const [sid, w] of [...watches.entries()]) if (!seen.has(sid)) { w.recovery.stop(); watches.delete(sid); }
                for (const [sid, r] of [...rx.entries()]) {
                    if (seen.has(sid)) continue;
                    // Unsubscribed / paused / muted: never leave a fallback cap behind
                    // on a publication that may be watched again.
                    if (r.fb?.capped) setQualityCeiling(r.pub, null);
                    shareFallbackNotice.forget(sid);
                    rx.delete(sid);
                }
            } finally {
                busy = false;
            }
        };
        const iv = setInterval(() => { void sample().catch(() => {}); }, 2000);
        // One row per second per watched share for the freeze summaries (shareSecondRing.ts). Reads only; logs nothing.
        let ringBusy = false;
        const ringTick = async () => {
            if (ringBusy || watches.size === 0) return;
            ringBusy = true;
            try {
                const at = performance.now();
                for (const { watch, pub, recovery } of [...watches.values()]) {
                    const track = pub.track;
                    if (!(track instanceof RemoteVideoTrack)) continue;
                    const report = await track.getRTCStatsReport() as ShareStatsLike | undefined;
                    const info = shareTileInfo(track, at);
                    watch.observeSecond(at, report, info.playback, info.playbackKey);
                    if (recovery.flushing) recovery.decoded(readInboundVideo(report as StatsLike | undefined)?.framesDecoded);
                }
            } catch { /* a track that went away mid-read */ } finally {
                ringBusy = false;
            }
        };
        const ringIv = setInterval(() => { void ringTick(); }, 1000);
        return () => {
            clearInterval(iv);
            clearInterval(ringIv);
            offSnap();
            for (const w of watches.values()) w.recovery.stop();
            watches.clear();
            for (const r of rx.values()) if (r.fb?.capped) setQualityCeiling(r.pub, null);
            offKeep();
            shareFallbackNotice.reset();
            room.off(RoomEvent.ParticipantConnected, onCount);
            room.off(RoomEvent.ParticipantDisconnected, onCount);
            room.off(RoomEvent.Reconnecting, onReconnecting);
            room.off(RoomEvent.Reconnected, onReconnected);
            room.off(RoomEvent.EncryptionError, onDecryptError);
            logCallEvent('call_leave', { participants: count() });
            markCallEnd();
            resetAvSyncMonitor();
        };
    }, [room]);

    return null;
};

export default CallEventMonitor;
