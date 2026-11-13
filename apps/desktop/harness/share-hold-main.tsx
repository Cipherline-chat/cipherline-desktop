/* eslint-disable -- harness, not shipped */
// One page per client. REAL here: the SFU, livekit-client, the E2EE worker, shareHold's tracker
// and room wiring, shareRepublishSignal, VideoTile, FocusedStreamBanner, FullscreenOverlay,
// ScreenShareGate, CallProvider, TrackCueController, scheduleWatchPrune. Written for the harness:
// the publisher's capture (a canvas, not getDisplayMedia) and the few lines of SidebarConference
// that keep the watch set and re-subscribe, which are copied from it as they stand.
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
    ExternalE2EEKeyProvider, LocalVideoTrack, RemoteVideoTrack, Room, RoomEvent, Track, VideoPreset,
    type RemoteParticipant, type RemoteTrackPublication,
} from 'livekit-client';
import { RoomContext, useLocalParticipant, useParticipants } from '@livekit/components-react';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import { loadWebFonts } from '../src/utils/webFonts';
import e2eeWorkerUrl from '../src/workers/e2eeWorker?worker&url';
import { stableE2EEOptions } from '../src/utils/e2eeRoomOptions';
import { installE2EEKey } from '../src/utils/e2eeActivation';
import { CallProvider, useCallContext } from '../src/contexts/CallContext';
import { VideoTile } from '../src/components/call/VideoTile';
import { ScreenShareGate } from '../src/components/call/ScreenShareGate';
import { FocusedStreamBanner } from '../src/components/call/FocusedStreamBanner';
import { FullscreenOverlay } from '../src/components/call/FullscreenOverlay';
import { useShareHoldIds } from '../src/hooks/useShareHold';
import { shareHold, attachShareHoldToRoom, sharePublications, type ShareHoldRoom } from '../src/utils/shareHold';
import { ShareRepublishSignal } from '../src/utils/shareRepublishSignal';
import { swapShareCodec, type ShareParticipantLike } from '../src/utils/shareRepublish';
import { TrackCueController, type CuePublication, type CueParticipant } from '../src/utils/callTrackCues';
import { scheduleWatchPrune } from '../src/utils/shareWatchPrune';
import { ROSTER_ONLY } from '../src/utils/callRosterEvents';
import { getCallEvents } from '../src/utils/callEventLog';
import { HEVC_ATTR, HevcPolicy, __resetHevcForTests, formatDecodeCaps, roomHevcState } from '../src/utils/hevcNegotiation';
import { RxDecoderLostWatch, withdrawH265Decode } from '../src/utils/rxDecoderLost';
import { readShareRxSnapshot } from '../src/utils/shareRxStats';

loadWebFonts();
const SS = Track.Source.ScreenShare;
const w = window as unknown as { H: Record<string, unknown> };
const t0 = performance.now();
const stamp = () => Math.round(performance.now() - t0);

async function joinRoom(url: string, token: string, keyB64: string | null): Promise<Room> {
    const keyProvider = keyB64 ? new ExternalE2EEKeyProvider() : null;
    const worker = keyB64 ? new Worker(e2eeWorkerUrl, { type: 'module' }) : null;
    const room = new Room({
        adaptiveStream: false, dynacast: true,
        ...(keyProvider && worker ? { encryption: stableE2EEOptions(keyProvider, worker) } : {}),
    });
    if (keyProvider && keyB64) await installE2EEKey(keyProvider, keyB64);
    await room.connect(url, token, { autoSubscribe: false, rtcConfig: { iceServers: [] } });
    if (keyB64) await room.setE2EEEnabled(true);
    return room;
}

// ── Publisher ───────────────────────────────────────────────────────────────

const SCENES: Array<[string, string]> = [['#143b5c', '#25e0c8'], ['#4a1d3a', '#ff8a5c']];
/** A capture or hardware encoder slow to give its first frame: the SFU has no media to publish until then. */
let firstMediaLagMs = 0;
function canvasCapture(width: number, height: number, label: string, tint: number) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const g = canvas.getContext('2d')!;
    const [bg, fg] = SCENES[tint % SCENES.length];
    let n = 0;
    const mediaFrom = performance.now() + firstMediaLagMs;
    const timer = setInterval(() => {
        if (performance.now() < mediaFrom) return;
        n++;
        g.fillStyle = bg; g.fillRect(0, 0, width, height);
        g.strokeStyle = 'rgba(255,255,255,.08)';
        for (let x = 0; x < width; x += width / 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke(); }
        for (let y = 0; y < height; y += height / 9) { g.beginPath(); g.moveTo(0, y); g.lineTo(width, y); g.stroke(); }
        g.fillStyle = 'rgba(0,0,0,.28)';
        g.fillRect(width * .08, height * .12, width * .5, height * .62);
        g.fillStyle = 'rgba(255,255,255,.12)';
        for (let i = 0; i < 7; i++) g.fillRect(width * .1, height * (.17 + i * .07), width * (.18 + ((i * 37) % 23) / 100), height * .025);
        g.fillStyle = fg;
        const r = height * .1;
        g.beginPath(); g.arc(width * .72 + Math.sin(n / 18) * width * .12, height * .42 + Math.cos(n / 22) * height * .18, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff';
        g.font = `600 ${Math.round(height * .045)}px sans-serif`;
        g.fillText(`${label}  ${width}x${height}`, width * .1, height * .88);
    }, 33);
    const track = canvas.captureStream(30).getVideoTracks()[0];
    return { track, stop: () => { clearInterval(timer); track.stop(); } };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pubLog: Array<Record<string, unknown>> = [];
const publisherSignal = new ShareRepublishSignal({ log: d => pubLog.push({ t: stamp(), ...d }) });

function publisherApi(room: Room) {
    const lp = room.localParticipant;
    let capture: { stop(): void } | null = null;
    let n = 0;
    const publish = async (width: number, height: number) => {
        const c = canvasCapture(width, height, `Source ${++n}`, n);
        capture = c;
        c.track.contentHint = 'motion';
        await lp.publishTrack(new LocalVideoTrack(c.track, undefined, true), {
            source: SS, simulcast: false,
            screenShareEncoding: new VideoPreset(width, height, 3_000_000, 30).encoding,
            videoCodec: 'vp8',
        });
    };
    const unpublish = async () => {
        const pub = lp.getTrackPublication(SS);
        if (pub?.track) await lp.unpublishTrack(pub.track, true);
        capture?.stop(); capture = null;
    };
    /** startScreenShareFrom's order: flag, marker, teardown, settle, capture + first-frame wait, publish, clear. */
    const announceAndTearDown = async () => {
        const announced = await publisherSignal.begin(lp);
        const payload = new TextEncoder().encode(JSON.stringify(announced.acked ? { type: 'ss-adjust', hold: 1 } : { type: 'ss-adjust' }));
        await lp.publishData(payload, { reliable: true, topic: 'ss-adjust' }).catch(() => {});
        await unpublish();
        await sleep(50);
        return announced;
    };
    return {
        identity: lp.identity,
        startShare: (width: number, height: number) => publish(width, height),
        /** A real stop (toggleScreenshare's order). */
        stopShare: async () => { publisherSignal.cancel(lp); await unpublish(); },
        /** A real republish, gapMs standing in for capture + first-frame wait + codec probe. */
        republish: async (width: number, height: number, gapMs: number, mediaLagMs = 0) => {
            const a = await announceAndTearDown();
            await sleep(gapMs);
            firstMediaLagMs = mediaLagMs;
            await publish(width, height);
            firstMediaLagMs = 0;
            publisherSignal.end(lp, a.seq, 'published');
            return a;
        },
        /** The hevcNegotiation loop's make-before-break codec swap. No signal: it is not meant to have a gap. */
        swapCodec: (codec: 'vp8' | 'vp9' | 'h264') => swapShareCodec(lp as unknown as ShareParticipantLike, codec as never, { resolution: 'source', frameRate: 30 } as never, {
            makeTrack: t => new LocalVideoTrack(t, undefined, true),
            lowerLayer: false,
            reason: 'harness',
            announce: async () => { const { seq } = await publisherSignal.begin(lp); return () => publisherSignal.end(lp, seq, 'swap'); },
        }),
        /**
         * The race from real reports: the flag's clear overtakes the new track on its way to the viewer.
         * `why` 'published' is the real path; anything else clears at once, which is the old behaviour
         * and the positive control that this reproduces the bug.
         */
        republishClearRace: async (width: number, height: number, gapMs: number, why: string) => {
            const a = await announceAndTearDown();
            await sleep(gapMs);
            publisherSignal.end(lp, a.seq, why);
            await sleep(200);
            await publish(width, height);
            return a;
        },
        /** The publisher hangs mid-republish: the flag stays up and nothing is ever published. */
        hang: () => announceAndTearDown(),
        /** The new capture fails: the finally in handleScreenShareSelect clears the flag. */
        failRepublish: async (gapMs: number) => {
            const a = await announceAndTearDown();
            await sleep(gapMs);
            publisherSignal.end(lp, a.seq, 'failed');
            return a;
        },
        leave: () => room.disconnect(),
        log: () => pubLog,
        /**
         * SidebarConference's 1 s hevcNegotiation tick, as far as a share goes: the real roomHevcState +
         * HevcPolicy over the real participant attributes, and on 'base' the real make-before-break swap.
         * (vp9 stands in for H.264; the harness encoder has no H.265.) The share starts "as H.265".
         */
        reactToDecoders: (on: boolean) => {
            if (decodeTick) { clearInterval(decodeTick); decodeTick = null; }
            if (!on) return;
            const policy = new HevcPolicy('h265');
            decodeSwaps.length = 0;
            decodeTick = setInterval(() => {
                const remotes = [...room.remoteParticipants.values()].map(p => ({ attr: p.attributes?.[HEVC_ATTR], joinedMsAgo: 60_000 }));
                const want = policy.observe(roomHevcState(remotes), true, performance.now());
                if (want === 'base') {
                    policy.applied(want, performance.now());
                    decodeSwaps.push({ t: stamp(), attr: remotes.map(r => r.attr ?? '').join(',') });
                    void publisherApiSwap();
                }
            }, 250);
        },
        decodeSwaps: () => decodeSwaps.slice(),
    };
    async function publisherApiSwap() {
        await swapShareCodec(lp as unknown as ShareParticipantLike, 'vp9' as never, { resolution: 'source', frameRate: 30 } as never, {
            makeTrack: t => new LocalVideoTrack(t, undefined, true),
            lowerLayer: false,
            reason: 'someone cannot decode H.265',
            announce: async () => { const { seq } = await publisherSignal.begin(lp); return () => publisherSignal.end(lp, seq, 'swap'); },
        });
    }
}
let decodeTick: ReturnType<typeof setInterval> | null = null;
const decodeSwaps: Array<Record<string, unknown>> = [];

// ── Viewer ──────────────────────────────────────────────────────────────────

const EMPTY = new Set<string>();
const cuesPlayed: Array<{ t: number; cue: string }> = [];
const rawEvents: Array<{ t: number; ev: string; detail?: string }> = [];

function ViewerSurface({ room }: { room: Room }) {
    const ctx = useCallContext();
    const participants = useParticipants(ROSTER_ONLY);
    const { localParticipant } = useLocalParticipant();
    const held = useShareHoldIds();
    const [watched, setWatched] = React.useState<Set<string>>(new Set());
    const remote = participants.filter(p => p.identity !== localParticipant?.identity) as RemoteParticipant[];
    // SidebarConference: screenShareParticipants + activeScreenShareIds + prune + auto-resubscribe.
    const sharers = remote.filter(p => p.getTrackPublication(SS) || held.has(p.identity));
    const activeIds = sharers.map(s => s.identity).sort().join(',');
    React.useEffect(() => scheduleWatchPrune(activeIds, setWatched as never), [activeIds]);
    React.useEffect(() => {
        sharers.forEach(p => {
            if (!watched.has(p.identity)) return;
            for (const pub of sharePublications(p as unknown as { trackPublications: Map<string, RemoteTrackPublication> })) {
                if (!pub.isSubscribed) pub.setSubscribed(true);
            }
        });
    });
    React.useEffect(() => { ctx.setWatchedScreenShareIds(watched); }, [watched]);

    // CallAudioEffects: cue listeners first, then the tracker.
    React.useEffect(() => {
        const cues = new TrackCueController({
            isReady: () => true,
            isAdjusting: id => shareHold.isGapExpected(id),
            play: cue => cuesPlayed.push({ t: stamp(), cue }),
            now: () => Date.now(),
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
            sources: { camera: Track.Source.Camera, screenShare: SS },
        });
        const onPub = (pub: CuePublication, part: CueParticipant) => cues.trackPublished(pub, part);
        const onUnpub = (pub: CuePublication, part: CueParticipant) => cues.trackUnpublished(pub, part);
        const onAttr = (changed: Record<string, string>) => { rawEvents.push({ t: stamp(), ev: 'attr', detail: JSON.stringify(changed) }); };
        const onRawUnpub = (pub: { source: unknown }) => { if (pub.source === SS) rawEvents.push({ t: stamp(), ev: 'unpublished' }); };
        const onRawPub = (pub: { source: unknown }) => { if (pub.source === SS) rawEvents.push({ t: stamp(), ev: 'published' }); };
        room.on(RoomEvent.ParticipantAttributesChanged, onAttr as never);
        room.on(RoomEvent.TrackUnpublished, onRawUnpub as never);
        room.on(RoomEvent.TrackPublished, onRawPub as never);
        room.on(RoomEvent.TrackPublished, onPub as never);
        room.on(RoomEvent.TrackUnpublished, onUnpub as never);
        const detach = attachShareHoldToRoom(room as unknown as ShareHoldRoom);
        const off = shareHold.onEnded((_id, end) => { if (end === 'timeout' || end === 'cancelled') cues.shareHoldClosed(); });
        return () => { off(); detach(); cues.dispose(); };
    }, [room]);

    w.H.watch = async (identity: string) => {
        const p = room.remoteParticipants.get(identity)!;
        await (p.getTrackPublication(SS) as RemoteTrackPublication).setSubscribed(true);
        setWatched(prev => new Set([...prev, identity]));
    };
    w.H.focus = (identity: string | null) => ctx.setFocusedStream(identity ? { identity, source: SS } : null);
    w.H.fullscreen = (on: boolean) => ctx.setIsFullscreen(on);
    w.H.ctx = () => ({ focused: ctx.focusedStream?.identity ?? null, fullscreen: ctx.isFullscreen, watched: [...watched] });

    const common = {
        localParticipant, token: 't', isLocalDeafened: false, isLocalMuted: false, onToggleLocalMute: () => {},
    };
    return (
        <>
            <div id="side" style={{ width: 320, position: 'fixed', right: 0, top: 0 }}>
                {sharers.filter(p => ctx.focusedStream?.identity !== p.identity).map(p => (
                    watched.has(p.identity)
                        ? <VideoTile key={`ss-${p.identity}`} p={p} source={SS as never} {...common} />
                        : <ScreenShareGate key={`gate-${p.identity}`} p={p} {...common} onSubscribed={id => setWatched(prev => new Set([...prev, id]))} />
                ))}
            </div>
            <FocusedStreamBanner
                token="t" isLocalDeafened={false} localMutedParticipantIds={EMPTY} onToggleLocalMute={() => {}}
                hiddenVideoIds={EMPTY} hiddenScreenShareIds={EMPTY} onHideVideoChange={() => {}} onHideScreenShareChange={() => {}}
            />
            {React.createElement(FullscreenOverlay as unknown as React.FC<Record<string, unknown>>, {
                token: 't', isLocalDeafened: false, localMutedParticipantIds: EMPTY, onToggleLocalMute: () => {},
                hiddenVideoIds: EMPTY, hiddenScreenShareIds: EMPTY, onHideVideoChange: () => {}, onHideScreenShareChange: () => {},
                subscribedScreenshares: watched, onSubscribeScreenshare: (id: string) => setWatched(prev => new Set([...prev, id])),
                onStopWatchingScreenshare: () => {},
            })}
        </>
    );
}

/** What the viewer can see right now, for the timeline. */
function snapshot(identity: string) {
    const ctx = (w.H.ctx as (() => { focused: string | null; fullscreen: boolean; watched: string[] }) | undefined)?.();
    const canvas = document.querySelector('[data-share-hold-frame] canvas') as HTMLCanvasElement | null;
    const videos = [...document.querySelectorAll('video')] as HTMLVideoElement[];
    const best = videos.reduce((m, v) => Math.max(m, v.videoWidth), 0);
    // The picture's box and the tile's clip: a jump in either is a visible jump.
    const hostClip = document.querySelector('[data-share-hold-frame]') as HTMLElement | null;
    const banner = document.querySelector('#call-focus-root > div') as HTMLElement | null;
    return {
        bannerH: banner ? Math.round(banner.getBoundingClientRect().height) : 0,
        holdClip: hostClip?.style.clipPath ?? '',
        focused: ctx?.focused === identity,
        fullscreen: !!ctx?.fullscreen,
        watching: !!ctx?.watched.includes(identity),
        phase: shareHold.phase(identity),
        frame: !!canvas && canvas.width > 0,
        note: !!document.querySelector('[data-share-hold-note]'),
        videoW: best,
        tiles: videos.length,
    };
}

/** The decoder string from the owner's reports (utils/rxDecoderLost.ts). */
const DEAD_DECODER = 'NullVideoDecoder (fallback from: ExternalDecoder (D3D11VideoDeco';
const largestVideo = (): HTMLVideoElement | null => {
    let best: HTMLVideoElement | null = null; let area = -1;
    for (const v of document.querySelectorAll('video')) {
        const a = v.clientWidth * v.clientHeight;
        if (a > area) { best = v; area = a; }
    }
    return best;
};
/** Mean brightness 0-255 of what the largest <video> is showing right now; null = nothing to read. */
function pictureBrightness(): number | null {
    const v = largestVideo();
    if (!v || v.videoWidth < 8) return null;
    const c = document.createElement('canvas'); c.width = 16; c.height = 16;
    const g = c.getContext('2d')!;
    g.drawImage(v, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return Math.round(sum / 256);
}

function viewerApi(room: Room) {
    const timeline: Array<Record<string, unknown>> = [];
    // The decode-loss path, wired as CallEventMonitor wires it (its block copied, not imported: it is a hook-less
    // 12 lines inside a 300-line effect). `killDecoder` is the stand-in for the D3D11 failure: libwebrtc's stats
    // start saying NullVideoDecoder and the picture stops (a remote track switched off renders black).
    let deadTrack: unknown = null;
    let recovery = true;
    const lostWatch = new RxDecoderLostWatch();
    const lostLog: Array<Record<string, unknown>> = [];
    let monitor: ReturnType<typeof setInterval> | null = null;
    let monitorBusy = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let observer: MutationObserver | null = null;
    return {
        identity: room.localParticipant.identity,
        snap: snapshot,
        /** Record every change, sampled every 15 ms. Holds no pixels. */
        record: (identity: string) => {
            timeline.length = 0;
            let last = '';
            if (timer) clearInterval(timer);
            const sample = () => {
                const s = snapshot(identity);
                const key = JSON.stringify(s);
                if (key !== last) { last = key; timeline.push({ t: stamp(), ...s }); }
            };
            timer = setInterval(sample, 15);
            // Headless on a software GL starves the timer (a handful of samples in seconds),
            // so also sample on every DOM change: a blink of one render must not fall between ticks.
            observer?.disconnect();
            observer = new MutationObserver(sample);
            observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        },
        stopRecord: () => { if (timer) clearInterval(timer); timer = null; observer?.disconnect(); observer = null; return timeline.slice(); },
        raw: () => rawEvents.slice(),
        rawClear: () => { rawEvents.length = 0; cuesPlayed.length = 0; },
        cues: () => cuesPlayed.slice(),
        events: () => getCallEvents().filter(e => e.kind === 'share_hold').map(e => e.detail),
        canvasPixels: () => {
            const c = document.querySelector('[data-share-hold-frame] canvas') as HTMLCanvasElement | null;
            if (!c || !c.width) return null;
            const d = c.getContext('2d')!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
            return [d[0], d[1], d[2]];
        },
        e2eeEnabled: () => room.isE2EEEnabled,
        brightness: pictureBrightness,
        /** Advertise what the viewer can decode, as SidebarConference does at join. */
        advertise: (h265: boolean) => room.localParticipant.setAttributes({ [HEVC_ATTR]: formatDecodeCaps({ h265 }) }),
        resetHevc: () => __resetHevcForTests(),
        /** recovery=false is the positive control: the monitor still sees the death, and does nothing about it. */
        startDecoderMonitor: (identity: string, withRecovery: boolean) => {
            recovery = withRecovery;
            deadTrack = null;
            lostLog.length = 0;
            if (monitor) clearInterval(monitor);
            monitor = setInterval(async () => {
                if (monitorBusy) return;
                monitorBusy = true;
                try {
                    const pub = room.remoteParticipants.get(identity)?.getTrackPublication(SS) as RemoteTrackPublication | undefined;
                    const track = pub?.track;
                    if (!(track instanceof RemoteVideoTrack)) return;
                    const report = await track.getRTCStatsReport();
                    const snap = readShareRxSnapshot(report as never, performance.now());
                    if (snap && deadTrack === track) { snap.decoder = DEAD_DECODER; snap.codec = 'h265'; }
                    const el = largestVideo();
                    const lost = lostWatch.observe(performance.now(), snap, { tile: el ? Math.min(el.clientWidth, el.clientHeight) : undefined, playbackKey: el });
                    if (lost) {
                        lostLog.push({ t: stamp(), ...lost });
                        if (recovery) withdrawH265Decode(room, lost);
                    }
                } finally { monitorBusy = false; }
            }, 250);
        },
        stopDecoderMonitor: () => { if (monitor) clearInterval(monitor); monitor = null; deadTrack = null; },
        killDecoder: () => {
            for (const p of room.remoteParticipants.values()) {
                const t = p.getTrackPublication(SS)?.track;
                if (t) { deadTrack = t; t.mediaStreamTrack.enabled = false; }
            }
        },
        decoderLost: () => lostLog.slice(),
        viewerAttr: () => room.localParticipant.attributes[HEVC_ATTR] ?? null,
    };
}

// ── Boot ────────────────────────────────────────────────────────────────────

w.H = {
    joinPublisher: async (o: { url: string; token: string; keyB64: string | null }) => {
        const room = await joinRoom(o.url, o.token, o.keyB64);
        Object.assign(w.H, publisherApi(room));
        return room.localParticipant.identity;
    },
    joinViewer: async (o: { url: string; token: string; keyB64: string | null }) => {
        const room = await joinRoom(o.url, o.token, o.keyB64);
        Object.assign(w.H, viewerApi(room));
        createRoot(document.getElementById('root')!).render(
            <CallProvider>
                <RoomContext.Provider value={room}>
                    <ViewerSurface room={room} />
                </RoomContext.Provider>
            </CallProvider>,
        );
        return room.localParticipant.identity;
    },
};
