import { describe, it, expect, afterEach } from 'vitest';
import {
    startShareSnapshot, setShareSnapProvider, MAX_EVENTS, MAX_EVENTS_PER_TARGET, MAX_TARGETS, SNAPSHOT_MS, SNAPSHOT_INTERVAL_MS,
    type ShareSnapTarget,
} from './shareSnapshot';
import { validateCallEvent } from './callEventLog';

afterEach(() => setShareSnapProvider(null));

const SECRETS = ['203.0.113.77', '192.168.1.20', 'CAND_LOCAL_1', 'ufragSECRET', 'TR_RealSid123', 'alice', 'PA_ident'];

/** A viewer whose counters advance by `fps` per tick. */
function viewerTarget(fps: number, over: Partial<ShareSnapTarget> = {}): { target: ShareSnapTarget; tick: () => void } {
    let n = 0;
    const tick = () => { n++; };
    return {
        tick,
        target: {
            role: 'viewer', ref: 'a1b2c3d4', track: 'remote-video-3',
            getReport: async () => ({
                forEach: (cb: (s: Record<string, unknown>) => void) => cb({
                    type: 'inbound-rtp', kind: 'video', timestamp: n * 1000, framesReceived: n * fps, framesDecoded: n * fps - 1, framesDropped: n,
                    jitterBufferDelay: n * fps * 0.02, jitterBufferEmittedCount: n * fps, frameWidth: 2560, frameHeight: 1440,
                    // things that must never reach an event
                    trackIdentifier: 'TR_RealSid123', ssrc: 1234, remoteId: 'alice',
                }),
            }),
            viewer: { layer: () => 2, tile: () => 540, playback: () => ({ at: n * 1000, total: n * 70, dropped: 0 }), focus: () => true },
            ...over,
        },
    };
}

function senderTarget(): { target: ShareSnapTarget; tick: () => void } {
    let n = 0;
    return {
        tick: () => { n++; },
        target: {
            role: 'sharer', ref: Promise.resolve('0badf00d'),
            getReport: async () => ({
                forEach: (cb: (s: Record<string, unknown>) => void) => {
                    cb({ type: 'outbound-rtp', kind: 'video', ssrc: 1, active: true, frameWidth: 2560, frameHeight: 1440, timestamp: n * 1000, bytesSent: n * 1_500_000,
                         framesEncoded: n * 90, totalEncodeTime: n * 0.4, framesPerSecond: 88, qualityLimitationReason: 'none', encoderImplementation: 'NvEncoder', powerEfficientEncoder: true });
                    cb({ type: 'media-source', kind: 'video', framesPerSecond: 90 });
                    cb({ type: 'remote-inbound-rtp', kind: 'video', ssrc: 1, fractionLost: 0.02, roundTripTime: 0.031 });
                    cb({ type: 'transport', selectedCandidatePairId: 'CP' });
                    cb({ type: 'candidate-pair', id: 'CP', availableOutgoingBitrate: 40_000_000, localCandidateId: 'CAND_LOCAL_1' });
                    cb({ type: 'local-candidate', id: 'CAND_LOCAL_1', address: '192.168.1.20', usernameFragment: 'ufragSECRET', relatedAddress: '203.0.113.77' });
                },
            }),
            sharer: { capKbps: () => 16_000 },
        },
    };
}

/** Runs a collection on a virtual clock: each sleep advances every fake target by one tick. */
async function collect(targets: Array<{ target: ShareSnapTarget; tick: () => void }>, durationMs = SNAPSHOT_MS) {
    let epoch = 1_791_000_000_000;
    let perf = 0;
    const handle = startShareSnapshot({
        provider: () => targets.map(t => t.target),
        durationMs, intervalMs: SNAPSHOT_INTERVAL_MS,
        perfNow: () => perf, epochNow: () => epoch,
        sleep: async (ms) => { epoch += ms; perf += ms; targets.forEach(t => t.tick()); },
    })!;
    await handle.done;
    return handle;
}

describe('startShareSnapshot', () => {
    it('is null when nothing is shared or watched (no provider, or an empty / throwing one)', () => {
        expect(startShareSnapshot({ provider: null })).toBeNull();
        expect(startShareSnapshot({ provider: () => [] })).toBeNull();
        expect(startShareSnapshot({ provider: () => { throw new Error('x'); } })).toBeNull();
        setShareSnapProvider(() => []);
        expect(startShareSnapshot()).toBeNull();
    });

    it('takes ~10 one-second viewer samples with the same numbers as the periodic event', async () => {
        const h = await collect([viewerTarget(70)]);
        const ev = h.events();
        expect(ev).toHaveLength(10);
        expect(ev.every(e => e.kind === 'share_rx_snap')).toBe(true);
        expect(ev[0].detail).toEqual({
            share_ref: 'a1b2c3d4', track: 'remote-video-3', rx_fps: 70, dec_fps: 70, drop_fps: 1, disp_fps: 70, jb_ms: 20,
            res: '2560x1440', layer: 2, focus: true, tile: 540,
        });
        // one second apart, epoch ms, newest reported
        expect(ev[1].t - ev[0].t).toBe(1000);
        expect(h.latestAt()).toBe(ev[ev.length - 1].t);
    });

    it('a tile that presented nothing while 70 fps were decoded logs NO disp_fps (unknown), not 0 (report 7d1f7abe)', async () => {
        let n0 = 0;
        const v = viewerTarget(70, { viewer: { layer: () => 2, tile: () => 453, playback: () => ({ at: n0 * 1000, total: n0 * 70, dropped: n0 * 70 }), focus: () => true } });
        const h = await collect([{ target: v.target, tick: () => { n0++; v.tick(); } }]);
        const ev = h.events();
        expect(ev).toHaveLength(10);
        for (const e of ev) {
            expect('disp_fps' in e.detail!).toBe(false);
            expect(e.detail!.dec_fps).toBe(70);
        }
    });

    it('takes ~10 sharer samples: network numbers + the encoder\'s rates', async () => {
        const h = await collect([senderTarget()]);
        const ev = h.events();
        expect(ev).toHaveLength(10);
        expect(ev[0].kind).toBe('share_tx_snap');
        expect(ev[0].detail).toEqual({
            share_ref: '0badf00d', kbps: 12_000, cap_kbps: 16_000, avail_kbps: 40_000, rtt_ms: 31, loss_pct: 2, enc_ms: 4.4,
            enc_fps: 90, sent_fps: 88, src_fps: 90, limit: 'none',
        });
    });

    it('is bounded: at most MAX_TARGETS tracks and MAX_EVENTS_PER_TARGET events each, even if asked for longer', async () => {
        const many = Array.from({ length: 6 }, () => viewerTarget(60));
        const h = await collect(many, 60_000);
        expect(h.events().length).toBeLessThanOrEqual(MAX_EVENTS);
        expect(MAX_EVENTS).toBe(MAX_TARGETS * MAX_EVENTS_PER_TARGET);
        expect(h.events().length).toBe(MAX_EVENTS);
        expect(JSON.stringify(h.events()).length).toBeLessThan(12_000);
    });

    it('a counter reset mid-collection skips that second instead of reporting a negative rate', async () => {
        let call = 0;
        const t: ShareSnapTarget = {
            role: 'viewer', ref: 'a1b2c3d4', track: 'remote-video-1',
            getReport: async () => { const c = call++; return { forEach: (cb: (s: Record<string, unknown>) => void) => cb({ type: 'inbound-rtp', kind: 'video', timestamp: c * 1000, framesReceived: c === 4 ? 3 : c * 60, framesDecoded: c === 4 ? 3 : c * 60, framesDropped: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0 }) }; },
        };
        const h = await collect([{ target: t, tick: () => {} }]);
        const rates = h.events().map(e => e.detail!.rx_fps);
        expect(rates.every(r => typeof r === 'number' && (r as number) >= 0)).toBe(true);
        expect(h.events().length).toBe(9); // 10 windows, the reset one skipped
    });

    it('a failing target does not stop the others or throw', async () => {
        const bad = viewerTarget(60, { getReport: async () => { throw new Error('gone'); } });
        const h = await collect([bad, viewerTarget(60)]);
        expect(h.events().length).toBe(10);
    });

    it('cancel stops further sampling', async () => {
        const t = viewerTarget(60);
        let sleeps = 0;
        const h = startShareSnapshot({ provider: () => [t.target], perfNow: () => sleeps * 1000, epochNow: () => sleeps, sleep: async () => { sleeps++; t.tick(); if (sleeps === 3) h.cancel(); } })!;
        await h.done;
        expect(sleeps).toBe(3);
    });

    it('PRIVACY: every event is a valid call event, numbers/enums only, and carries no address, candidate, SID, user or ssrc', async () => {
        const h = await collect([viewerTarget(70), senderTarget()]);
        const ev = h.events();
        expect(ev.length).toBe(20);
        const text = JSON.stringify(ev);
        for (const s of SECRETS) expect(text, s).not.toContain(s);
        expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
        expect(text).not.toMatch(/ssrc|candidate|address|ufrag|username|identity/i);
        for (const e of ev) {
            expect(validateCallEvent({ t: e.t, kind: e.kind, detail: e.detail })).toEqual([]);
            for (const v of Object.values(e.detail!)) {
                if (typeof v === 'string') expect(v).toMatch(/^(?:[0-9a-f]{8}|remote-video-\d+|\d+x\d+|none|cpu|bandwidth|other)$/);
            }
        }
    });
});
