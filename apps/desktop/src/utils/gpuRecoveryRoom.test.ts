import { describe, it, expect, beforeEach } from 'vitest';
import { buildRoomRecoveryDeps, type RemotePubLike, type RoomLike, type LocalPubLike } from './gpuRecoveryRoom';
import {
    HEVC_ATTR, HevcPolicy, __resetHevcForTests, effectiveHevcCaps, hasHevcGpuLost, markHevcFailed, markHevcGpuLost,
    parseDecodeCaps, roomHevcState, HEVC_UP_MS,
} from './hevcNegotiation';

class FakeEl { srcObject: unknown = { stream: 'old' }; }

function remoteVideo(sid: string, over: Partial<Omit<RemotePubLike, 'track'>> = {}, frames = 100) {
    const track = {
        attachedElements: [new FakeEl() as unknown as HTMLMediaElement],
        attachCalls: 0,
        frames,
        attach(el: HTMLMediaElement) { this.attachCalls++; (el as unknown as FakeEl).srcObject = { stream: 'new' }; return el; },
        async getRTCStatsReport() {
            const f = this.frames;
            return { forEach: (cb: (s: Record<string, unknown>) => void) => { cb({ type: 'inbound-rtp', kind: 'video', framesDecoded: f }); cb({ type: 'codec' }); } };
        },
    };
    const pub = {
        trackSid: sid, source: 'camera', kind: 'video', mimeType: 'video/H264',
        isSubscribed: true, isEnabled: true, isMuted: false, track,
        log: [] as string[],
        setEnabled(e: boolean) { this.log.push(`enabled:${e}`); this.isEnabled = e; },
        setSubscribed(s: boolean) { this.log.push(`subscribed:${s}`); this.isSubscribed = s; },
        ...over,
    };
    return pub;
}

function fakeRoom(remotes: ReturnType<typeof remoteVideo>[], local: { camera?: LocalPubLike; share?: LocalPubLike } = {}) {
    const attrs: Record<string, string>[] = [];
    const room = {
        remoteParticipants: new Map([['p1', { trackPublications: new Map(remotes.map(r => [r.trackSid, r as unknown as RemotePubLike])) }]]),
        localParticipant: {
            attributes: {} as Record<string, string>,
            getTrackPublication(source: string) { return source === 'camera' ? local.camera : source === 'screen_share' ? local.share : undefined; },
            async setAttributes(a: Record<string, string>) { attrs.push(a); Object.assign(this.attributes, a); },
        },
    };
    return { room: room as unknown as RoomLike, attrs, lp: room.localParticipant };
}

const opts = (over = {}) => ({ cancelled: () => false, sleep: async () => {}, keyframeGapMs: 0, resubscribeGapMs: 0, probeTimeoutMs: 50, ...over });

beforeEach(() => __resetHevcForTests());

describe('room deps — what each recovery step does to LiveKit objects', () => {
    it('restartCamera: restartTrack() on an unmuted camera; none when muted / absent; failed on throw', async () => {
        let restarted = 0;
        const cam = { isMuted: false, track: { restartTrack: async () => { restarted++; } } };
        expect(await buildRoomRecoveryDeps(fakeRoom([], { camera: cam }).room, opts()).restartCamera()).toBe('restarted');
        expect(restarted).toBe(1);
        expect(await buildRoomRecoveryDeps(fakeRoom([], { camera: { ...cam, isMuted: true } }).room, opts()).restartCamera()).toBe('none');
        expect(await buildRoomRecoveryDeps(fakeRoom([]).room, opts()).restartCamera()).toBe('none');
        const bad = { isMuted: false, track: { restartTrack: async () => { throw new Error('NotReadableError'); } } };
        expect(await buildRoomRecoveryDeps(fakeRoom([], { camera: bad }).room, opts()).restartCamera()).toBe('failed');
    });

    it('reattach: every remote video element gets a fresh srcObject', () => {
        const a = remoteVideo('a');
        const b = remoteVideo('b', { isEnabled: false }); // paused offscreen: not shown, not touched
        const n = buildRoomRecoveryDeps(fakeRoom([a, b]).room, opts()).reattachRemoteVideo();
        expect(n).toBe(1);
        expect((a.track.attachedElements[0] as unknown as FakeEl).srcObject).toEqual({ stream: 'new' });
        expect((b.track.attachedElements[0] as unknown as FakeEl).srcObject).toEqual({ stream: 'old' });
    });

    it('sampleRemoteVideo: only subscribed + enabled + unmuted video, with framesDecoded', async () => {
        const pubs = [
            remoteVideo('cam', {}, 42),
            remoteVideo('share', { source: 'screen_share' }, 7),
            remoteVideo('muted', { isMuted: true }),
            remoteVideo('unsub', { isSubscribed: false }),
            remoteVideo('audio', { kind: 'audio', source: 'microphone' }),
        ];
        const s = await buildRoomRecoveryDeps(fakeRoom(pubs).room, opts()).sampleRemoteVideo();
        expect(s).toEqual([{ key: 'cam', frames: 42, camera: true }, { key: 'share', frames: 7, camera: false }]);
    });

    it('requestKeyframes: pause + resume at the SFU; resubscribe: cameras only, unsubscribe + subscribe', async () => {
        const cam = remoteVideo('cam');
        const share = remoteVideo('share', { source: 'screen_share' });
        const deps = buildRoomRecoveryDeps(fakeRoom([cam, share]).room, opts());
        expect(await deps.requestKeyframes(['cam', 'share', 'gone'])).toBe(2);
        expect(cam.log).toEqual(['enabled:false', 'enabled:true']);
        expect(share.log).toEqual(['enabled:false', 'enabled:true']);
        expect(await deps.resubscribe(['cam', 'share'])).toBe(1);
        expect(cam.log.slice(2)).toEqual(['subscribed:false', 'subscribed:true']);
        expect(share.log).toHaveLength(2); // never unsubscribed
    });

    it('shareState: live / ended / none', () => {
        const live = { isMuted: false, track: { mediaStreamTrack: { readyState: 'live' } } };
        const ended = { isMuted: false, track: { mediaStreamTrack: { readyState: 'ended' } } };
        expect(buildRoomRecoveryDeps(fakeRoom([], { share: live }).room, opts()).shareState()).toBe('live');
        expect(buildRoomRecoveryDeps(fakeRoom([], { share: ended }).room, opts()).shareState()).toBe('ended');
        expect(buildRoomRecoveryDeps(fakeRoom([]).room, opts()).shareState()).toBe('none');
    });
});

describe('H.265 re-evaluation after a GPU restart', () => {
    it('advertises "no H.265 decode" even when the probes still say yes (the prod case)', async () => {
        const { room, attrs } = fakeRoom([remoteVideo('r', { mimeType: 'video/H265' })], {
            camera: { isMuted: false, track: { codec: 'h265' } },
        });
        const r = await buildRoomRecoveryDeps(room, opts({ probeDecode: async () => true, probeEncode: async () => true })).reevaluateHevc();
        expect(r).toEqual({ was: true, decode: true, encode: true });
        expect(hasHevcGpuLost()).toBe(true);
        expect(attrs).toEqual([{ [HEVC_ATTR]: '1:' }]);
        expect(parseDecodeCaps(attrs[0][HEVC_ATTR])).toEqual({ h265: false });
    });

    it('a probe that hangs while the GPU process restarts does not stall recovery', async () => {
        const { room, attrs } = fakeRoom([]);
        const r = await buildRoomRecoveryDeps(room, opts({ probeDecode: () => new Promise<boolean>(() => {}), probeEncode: async () => false })).reevaluateHevc();
        expect(r).toEqual({ was: false, decode: false, encode: false });
        expect(attrs).toHaveLength(1);
    });

    it('effectiveHevcCaps: nothing after a GPU restart; otherwise the probes (encode also off once H.265 failed)', () => {
        expect(effectiveHevcCaps({ decode: true, encode: true }, { gpuLost: false, failed: false })).toEqual({ decode: true, encode: true });
        expect(effectiveHevcCaps({ decode: true, encode: true }, { gpuLost: false, failed: true })).toEqual({ decode: true, encode: false });
        expect(effectiveHevcCaps({ decode: true, encode: true }, { gpuLost: true, failed: false })).toEqual({ decode: false, encode: false });
        // Module state (default arg) follows markHevcGpuLost.
        expect(effectiveHevcCaps({ decode: true, encode: true })).toEqual({ decode: true, encode: true });
        markHevcGpuLost();
        expect(effectiveHevcCaps({ decode: true, encode: true })).toEqual({ decode: false, encode: false });
        __resetHevcForTests();
        markHevcFailed();
        expect(hasHevcGpuLost()).toBe(false); // the two flags are independent
    });

    it('fallback through the existing all-capable negotiation — OUR publisher drops to base at once', () => {
        // We were publishing H.265 (everyone capable, we HW-encode).
        const p = new HevcPolicy('h265');
        const everyone = [{ attr: '1:h265', joinedMsAgo: 60_000 }, { attr: '1:h265', joinedMsAgo: 60_000 }];
        expect(p.observe(roomHevcState(everyone), true, 0)).toBeNull();
        // GPU restart: SidebarConference's `allowed` now includes !hasHevcGpuLost().
        markHevcGpuLost();
        const allowed = effectiveHevcCaps({ decode: true, encode: true }).encode;
        expect(p.observe(roomHevcState(everyone), allowed, 1000)).toBe('base');
    });

    it('fallback — a PEER publishing H.265 to us drops to base once it sees our "1:" (and never comes back up)', () => {
        const peer = new HevcPolicy('h265');
        const us = { attr: '1:', joinedMsAgo: 60_000 };
        expect(roomHevcState([us])).toBe('incapable');
        expect(peer.observe(roomHevcState([us]), true, 0)).toBe('base');
        peer.applied('base', 0);
        for (let t = 1000; t <= HEVC_UP_MS * 3; t += 1000) expect(peer.observe(roomHevcState([us]), true, t)).toBeNull();
    });

    it('negative control: without a GPU restart the same room stays on H.265', () => {
        const p = new HevcPolicy('h265');
        const allowed = effectiveHevcCaps({ decode: true, encode: true }).encode;
        expect(p.observe(roomHevcState([{ attr: '1:h265', joinedMsAgo: 60_000 }]), allowed, 0)).toBeNull();
    });
});
