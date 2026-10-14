/**
 * The LiveKit side of utils/gpuRecovery.ts — runGpuVideoRecovery's deps,
 * built from a Room. Structurally typed (just the members used), so the
 * steps are unit-testable with fakes (gpuRecoveryRoom.test.ts); the real
 * livekit-client objects satisfy these shapes.
 */
import {
    HEVC_ATTR, effectiveHevcCaps, formatDecodeCaps, markHevcGpuLost, probeHevcDecode, probeHevcEncode,
} from './hevcNegotiation';
import type { CameraRestartResult, GpuRecoveryDeps, RemoteVideoSample } from './gpuRecovery';

// LiveKit's Track.Source values (strings), kept literal so this file does not
// need livekit-client at runtime.
const CAMERA = 'camera';
const SCREEN = 'screen_share';

interface StatsReportLike { forEach(cb: (s: Record<string, unknown>) => void): void }

export interface RemoteVideoTrackLike {
    attachedElements: HTMLMediaElement[];
    attach(el: HTMLMediaElement): HTMLMediaElement;
    getRTCStatsReport(): Promise<StatsReportLike | undefined>;
}

export interface RemotePubLike {
    trackSid: string;
    source: string;
    kind: string;
    mimeType?: string;
    isSubscribed: boolean;
    isEnabled: boolean;
    isMuted: boolean;
    track?: RemoteVideoTrackLike | unknown;
    setEnabled(enabled: boolean): void;
    setSubscribed(subscribed: boolean): void;
}

export interface RemoteParticipantLike {
    trackPublications: Map<string, RemotePubLike>;
}

export interface LocalVideoTrackLike {
    codec?: string;
    publishOptions?: { videoCodec?: string };
    mediaStreamTrack?: { readyState: string };
    restartTrack?: () => Promise<unknown>;
}

export interface LocalPubLike { isMuted: boolean; track?: LocalVideoTrackLike }

export interface RoomLike {
    remoteParticipants: Map<string, RemoteParticipantLike>;
    localParticipant: {
        getTrackPublication(source: never): LocalPubLike | undefined;
        setAttributes(a: Record<string, string>): Promise<unknown>;
    };
}

export interface RoomRecoveryOptions {
    cancelled(): boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Probes (tests inject; default = the real hevcNegotiation probes). */
    probeDecode?: () => Promise<boolean>;
    probeEncode?: () => Promise<boolean>;
    keyframeGapMs?: number;
    resubscribeGapMs?: number;
    probeTimeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** A probe that hangs while the new GPU process comes up must not stall recovery. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>(resolve => {
        const t = setTimeout(() => resolve(fallback), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
    });
}

function isVideoTrack(t: unknown): t is RemoteVideoTrackLike {
    const v = t as Partial<RemoteVideoTrackLike> | undefined;
    return !!v && Array.isArray(v.attachedElements) && typeof v.attach === 'function' && typeof v.getRTCStatsReport === 'function';
}

/** Remote video publications we are actually receiving. */
function shownRemoteVideo(room: RoomLike): RemotePubLike[] {
    const out: RemotePubLike[] = [];
    for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
            if (pub.kind !== 'video' || (pub.source !== CAMERA && pub.source !== SCREEN)) continue;
            if (!pub.isSubscribed || !pub.isEnabled || pub.isMuted || !isVideoTrack(pub.track)) continue;
            out.push(pub);
        }
    }
    return out;
}

function findRemote(room: RoomLike, key: string): RemotePubLike | undefined {
    for (const p of room.remoteParticipants.values()) {
        const pub = p.trackPublications.get(key) ?? [...p.trackPublications.values()].find(x => x.trackSid === key);
        if (pub) return pub;
    }
    return undefined;
}

export function buildRoomRecoveryDeps(room: RoomLike, o: RoomRecoveryOptions): GpuRecoveryDeps {
    const sleep = o.sleep ?? realSleep;
    const lp = room.localParticipant;
    const localPub = (source: string) => lp.getTrackPublication(source as never);
    const probeTimeout = o.probeTimeoutMs ?? 3000;

    return {
        sleep,
        now: o.now ?? (() => performance.now()),
        cancelled: o.cancelled,

        async restartCamera(): Promise<CameraRestartResult> {
            const pub = localPub(CAMERA);
            const track = pub?.track;
            if (!pub || pub.isMuted || !track || typeof track.restartTrack !== 'function') return 'none';
            try {
                // No arguments: the same device + constraints as before.
                await track.restartTrack();
                return 'restarted';
            } catch (e) {
                console.warn('[GPU] camera restart failed:', e);
                return 'failed';
            }
        },

        async reevaluateHevc() {
            markHevcGpuLost();
            const localCodec = (p: LocalPubLike | undefined) => p?.track?.codec ?? p?.track?.publishOptions?.videoCodec;
            const was = localCodec(localPub(CAMERA)) === 'h265' || localCodec(localPub(SCREEN)) === 'h265'
                || shownRemoteVideo(room).some(p => /h265/i.test(p.mimeType ?? ''));
            const [decode, encode] = await Promise.all([
                withTimeout((o.probeDecode ?? probeHevcDecode)(), probeTimeout, false),
                withTimeout((o.probeEncode ?? probeHevcEncode)(), probeTimeout, false),
            ]);
            // Always "no H.265" after a GPU restart (effectiveHevcCaps) — peers
            // drop to H.264/VP8 on their next policy tick.
            const eff = effectiveHevcCaps({ decode, encode });
            await lp.setAttributes({ [HEVC_ATTR]: formatDecodeCaps({ h265: eff.decode }) }).catch(() => {});
            return { was, decode, encode };
        },

        reattachRemoteVideo(): number {
            let n = 0;
            for (const pub of shownRemoteVideo(room)) {
                const track = pub.track as RemoteVideoTrackLike;
                for (const el of [...track.attachedElements]) {
                    try {
                        // A fresh MediaStream → a new media player and frame sink.
                        el.srcObject = null;
                        track.attach(el);
                        n++;
                    } catch { /* element gone */ }
                }
            }
            return n;
        },

        shareState() {
            const pub = localPub(SCREEN);
            const mst = pub?.track?.mediaStreamTrack;
            if (!pub || !mst) return 'none';
            return mst.readyState === 'live' ? 'live' : 'ended';
        },

        async sampleRemoteVideo(): Promise<RemoteVideoSample[]> {
            const out: RemoteVideoSample[] = [];
            for (const pub of shownRemoteVideo(room)) {
                let frames = 0;
                try {
                    (await (pub.track as RemoteVideoTrackLike).getRTCStatsReport())?.forEach(s => {
                        if (s.type === 'inbound-rtp' && s.kind === 'video' && typeof s.framesDecoded === 'number') frames = s.framesDecoded;
                    });
                } catch { /* closing */ }
                out.push({ key: pub.trackSid, frames, camera: pub.source === CAMERA });
            }
            return out;
        },

        async requestKeyframes(keys) {
            const pubs = keys.map(k => findRemote(room, k)).filter((p): p is RemotePubLike => !!p && p.isSubscribed && p.isEnabled);
            for (const p of pubs) p.setEnabled(false);
            if (pubs.length) await sleep(o.keyframeGapMs ?? 400);
            // Resume only what we paused — a tile that let go meanwhile is
            // remoteVideoDemand's to pause again.
            for (const p of pubs) p.setEnabled(true);
            return pubs.length;
        },

        async resubscribe(keys) {
            const pubs = keys.map(k => findRemote(room, k)).filter((p): p is RemotePubLike => !!p && p.isSubscribed && p.source === CAMERA);
            for (const p of pubs) p.setSubscribed(false);
            if (pubs.length) await sleep(o.resubscribeGapMs ?? 600);
            for (const p of pubs) p.setSubscribed(true);
            return pubs.length;
        },
    };
}
