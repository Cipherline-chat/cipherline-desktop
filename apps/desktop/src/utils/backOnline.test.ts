import { describe, it, expect } from 'vitest';
import {
    BACK_ONLINE_MIN_GAP_MS, BACK_ONLINE_MIN_OFFLINE_MS, createBackOnlineTracker, formatOutage,
} from './backOnline';

const MIN = 60_000;

describe('createBackOnlineTracker', () => {
    it('says nothing while online and never having been offline', () => {
        const t = createBackOnlineTracker();
        expect(t.update(true, 0).show).toBe(false);
        expect(t.update(true, 10 * MIN).show).toBe(false);
    });

    it('shows once when the connection returns after 2 minutes or more', () => {
        const t = createBackOnlineTracker();
        t.update(true, 0);
        t.update(false, 1000);
        const r = t.update(true, 1000 + BACK_ONLINE_MIN_OFFLINE_MS);
        expect(r.show).toBe(true);
        expect(r.offlineMs).toBe(BACK_ONLINE_MIN_OFFLINE_MS);
        // a second report of the same state does not repeat it
        expect(t.update(true, 1000 + BACK_ONLINE_MIN_OFFLINE_MS + 5).show).toBe(false);
    });

    it('stays quiet for a drop just under 2 minutes', () => {
        const t = createBackOnlineTracker();
        t.update(false, 0);
        expect(t.update(true, BACK_ONLINE_MIN_OFFLINE_MS - 1).show).toBe(false);
    });

    it('counts from the first offline report, not the latest (repeats are harmless)', () => {
        const t = createBackOnlineTracker();
        t.update(false, 0);
        t.update(false, 60 * 1000);
        t.update(false, 119 * 1000);
        expect(t.update(true, 130 * 1000).show).toBe(true);
    });

    it('rate-limits: a second long outage soon after the first says nothing', () => {
        const t = createBackOnlineTracker();
        t.update(false, 0);
        expect(t.update(true, 3 * MIN).show).toBe(true);
        t.update(false, 4 * MIN);
        expect(t.update(true, 7 * MIN).show).toBe(false);     // 3 min offline, but 4 min after the last note
        t.update(false, 8 * MIN);
        expect(t.update(true, 3 * MIN + BACK_ONLINE_MIN_GAP_MS + 8 * MIN).show).toBe(true);   // long after
    });

    it('a rate-limited return still ends the outage (the next one is measured afresh)', () => {
        const t = createBackOnlineTracker();
        t.update(false, 0);
        t.update(true, 3 * MIN);                    // shown
        t.update(false, 4 * MIN);
        t.update(true, 8 * MIN);                    // suppressed by the gap
        expect(t.offline).toBe(false);
    });

    it('a flapping link that never stays down 2 minutes never shows', () => {
        const t = createBackOnlineTracker();
        let now = 0;
        for (let i = 0; i < 20; i++) {
            t.update(false, now); now += 90_000;
            expect(t.update(true, now).show).toBe(false); now += 5_000;
        }
    });

    it('reports how long it was gone', () => {
        const t = createBackOnlineTracker();
        t.update(false, 5_000);
        expect(t.update(true, 5_000 + 37 * MIN).offlineMs).toBe(37 * MIN);
    });

    it('survives a clock that goes backwards', () => {
        const t = createBackOnlineTracker();
        t.update(false, 10 * MIN);
        const r = t.update(true, 5 * MIN);
        expect(r.show).toBe(false);
        expect(r.offlineMs).toBe(0);
    });
});

describe('formatOutage', () => {
    it('rounds to minutes, then hours, then days; never seconds', () => {
        expect(formatOutage(2 * MIN)).toBe('2 minutes');
        expect(formatOutage(59 * 1000)).toBe('1 minute');
        expect(formatOutage(47 * MIN + 20_000)).toBe('47 minutes');
        expect(formatOutage(89 * MIN)).toBe('89 minutes');
        expect(formatOutage(90 * MIN)).toBe('2 hours');
        expect(formatOutage(3 * 60 * MIN)).toBe('3 hours');
        expect(formatOutage(60 * 60 * MIN)).toBe('3 days');
    });
});
