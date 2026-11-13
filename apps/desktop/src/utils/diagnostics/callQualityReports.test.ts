/**
 * Low-rating "Send a call quality report?" — what is sent, that the ended
 * call's data is still there to send, and the 3/min throttle (429) path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    CALL_QUALITY_CATEGORIES, LOW_RATING_MAX, MAX_RETRIES, RATE_LIMIT_WAIT_MS, buildCallQualityBodies,
    describeRating, isLowRating, sendCallQualityReports,
} from './callQualityReports';
import { prepareReportInputs } from './collect';
import { webrtcRing } from './webrtcRing';
import { clearCallEvents, logCallEvent, markCallEnd, markCallStart } from '../callEventLog';
import type { DiagnosticReportBody } from './reportTypes';
import type { SendResult } from './sendPolicy';

const ok = (): SendResult => ({ ok: true, id: null, reference: null });
const fail = (reason: 'rate_limited' | 'offline' | 'server' | 'rejected' | 'too_large'): SendResult => ({ ok: false, reason, message: reason });

const bodies = (): DiagnosticReportBody[] => CALL_QUALITY_CATEGORIES.map(category => ({ category } as unknown as DiagnosticReportBody));

describe('low rating threshold', () => {
    it('1 and 2 of 5 are low; 3, 4, 5 and junk are not', () => {
        expect(LOW_RATING_MAX).toBe(2);
        expect([1, 2].every(isLowRating)).toBe(true);
        expect([0, 3, 4, 5, 6, NaN].some(isLowRating)).toBe(false);
    });
    it('the note carries only the rating and the tag enums', () => {
        expect(describeRating(2, ['echo', 'lag'])).toBe('Rated 2 out of 5 right after the call ended. Reported problems: echo, lag.');
        expect(describeRating(1, [])).toBe('Rated 1 out of 5 right after the call ended.');
    });
});

describe('the ended call is still in the collectors when the card shows', () => {
    beforeEach(() => { clearCallEvents(); });

    const feed = () => {
        webrtcRing.beginCall();
        markCallStart();
        const ref = {};
        webrtcRing.record(1_000, [{
            ref, direction: 'inbound', kind: 'audio',
            report: [{ id: 'IN', type: 'inbound-rtp', kind: 'audio', packetsLost: 4, packetsReceived: 400, jitter: 0.02 }],
        }]);
        logCallEvent('camera_codec', { codec: 'vp8' });
        webrtcRing.endCall(Date.now());
        markCallEnd(); // what CallPane unmount does
    };

    it('the report built AFTER call end still carries the stats samples and call events (all three categories)', async () => {
        feed();
        const prepared = await prepareReportInputs({ user: null, entitlement: null, notificationPrefs: null });
        expect(prepared.webrtc.call_active).toBe(false);
        expect(prepared.webrtc.samples.length).toBe(1);
        expect(prepared.callEvents.some(e => e.kind === 'camera_codec')).toBe(true);
        const out = buildCallQualityBodies(prepared, 2, ['echo']);
        expect(out.map(b => b.category)).toEqual(['call_audio', 'screen_share', 'video_camera']);
        for (const b of out) expect((b.payload as { trigger?: string }).trigger).toBe('in_call');
        expect(out[0].description).toContain('Rated 2 out of 5');
        expect(out[0].payload.webrtc?.samples.length).toBe(1);
        expect(out[0].payload.call_events?.some(e => e.event === 'camera_codec')).toBe(true);
    });

    it('why the card snapshots at call end: the NEXT call drops the ring, a prepared snapshot is unaffected', async () => {
        feed();
        const prepared = await prepareReportInputs({ user: null, entitlement: null, notificationPrefs: null });
        webrtcRing.beginCall(); // user starts another call before pressing Send
        expect(webrtcRing.summary(Date.now()).samples.length).toBe(0);
        const out = buildCallQualityBodies(prepared, 1, []);
        expect(out[0].payload.webrtc?.samples.length).toBe(1);
        webrtcRing.endCall(Date.now());
    });
});

describe('sendCallQualityReports', () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    beforeEach(() => { sleeps.length = 0; });

    it('sends all three, in order, with no waiting when nothing is limited', async () => {
        const seen: string[] = [];
        const r = await sendCallQualityReports(bodies(), { send: async b => { seen.push(b.category); return ok(); }, sleep });
        expect(seen).toEqual(['call_audio', 'screen_share', 'video_camera']);
        expect(r).toEqual({ sent: 3, total: 3 });
        expect(sleeps).toEqual([]);
    });

    it('a 429 on the third report waits past the 60 s window, then sends it - nothing lost', async () => {
        let calls = 0;
        const progress: boolean[] = [];
        const r = await sendCallQualityReports(bodies(), {
            send: async () => (++calls === 3 ? fail('rate_limited') : ok()),
            sleep,
            onProgress: p => progress.push(p.waiting),
        });
        expect(r).toEqual({ sent: 3, total: 3 });
        expect(calls).toBe(4);
        expect(sleeps).toEqual([RATE_LIMIT_WAIT_MS]);
        expect(RATE_LIMIT_WAIT_MS).toBeGreaterThan(60_000);
        expect(progress).toContain(true);
    });

    it('a persistent 429 gives up after MAX_RETRIES waits and reports the shortfall (no hammering)', async () => {
        let calls = 0;
        const r = await sendCallQualityReports(bodies().slice(0, 1), { send: async () => { calls++; return fail('rate_limited'); }, sleep });
        expect(r).toEqual({ sent: 0, total: 1 });
        expect(calls).toBe(1 + MAX_RETRIES);
        expect(sleeps).toHaveLength(MAX_RETRIES);
    });

    it('a permanent refusal is not retried, and the rest still go', async () => {
        let calls = 0;
        const r = await sendCallQualityReports(bodies(), { send: async () => (++calls === 1 ? fail('rejected') : ok()), sleep });
        expect(r).toEqual({ sent: 2, total: 3 });
        expect(calls).toBe(3);
        expect(sleeps).toEqual([]);
    });
});
