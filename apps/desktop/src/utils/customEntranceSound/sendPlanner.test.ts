import { describe, expect, it } from 'vitest';
import { EntranceSendPlanner, MAX_BURSTS, MIN_GAP_MS, RESEND_FLOOR_MS } from './sendPlanner';

const ID = 'a'.repeat(32);
const ID2 = 'b'.repeat(32);

describe('EntranceSendPlanner', () => {
    it('sends to everyone present on join, then only to newcomers (dedupe)', () => {
        let t = 0;
        const p = new EntranceSendPlanner(() => t);
        expect(p.plan(['bob', 'cat'], ID)).toEqual({ to: ['bob', 'cat'] });
        p.markSent(['bob', 'cat'], ID);
        t += 5_000;
        expect(p.plan(['bob', 'cat'], ID)).toBeNull();
        expect(p.plan(['bob', 'cat', 'dan'], ID)).toEqual({ to: ['dan'] });
    });

    it('nothing to send without a sound (or with no peers)', () => {
        const p = new EntranceSendPlanner(() => 0);
        expect(p.plan(['bob'], null)).toBeNull();
        expect(p.plan([], ID)).toBeNull();
    });

    it('bursts are at least MIN_GAP_MS apart', () => {
        let t = 0;
        const p = new EntranceSendPlanner(() => t);
        p.markSent(['bob'], ID);
        t += 200;
        expect(p.plan(['bob', 'cat'], ID)).toEqual({ retryInMs: MIN_GAP_MS - 200 });
        t += MIN_GAP_MS;
        expect(p.plan(['bob', 'cat'], ID)).toEqual({ to: ['cat'] });
    });

    it('a new sound mid-call makes everyone due again', () => {
        let t = 0;
        const p = new EntranceSendPlanner(() => t);
        p.markSent(['bob', 'cat'], ID);
        t += MIN_GAP_MS;
        expect(p.plan(['bob', 'cat'], ID2)).toEqual({ to: ['bob', 'cat'] });
    });

    it('someone bouncing in and out is not re-sent within the floor, but is after it', () => {
        let t = 0;
        const p = new EntranceSendPlanner(() => t);
        p.markSent(['bob'], ID);
        t += 2_000;
        p.left('bob');
        expect(p.plan(['bob'], ID)).toBeNull();
        p.left('bob');
        t += RESEND_FLOOR_MS;
        expect(p.plan(['bob'], ID)).toEqual({ to: ['bob'] });
    });

    it('caps the bursts per call', () => {
        let t = 0;
        const p = new EntranceSendPlanner(() => t);
        for (let i = 0; i < MAX_BURSTS; i++) { p.markSent([`peer-${i}`], ID); t += MIN_GAP_MS; }
        expect(p.plan(['someone-new'], ID)).toBeNull();
    });
});
