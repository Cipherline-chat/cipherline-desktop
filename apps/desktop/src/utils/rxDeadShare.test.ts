import { describe, it, expect } from 'vitest';
import { RxDeadShareWatch, RX_DEAD_MS, rxSince } from './rxDeadShare';

describe('RxDeadShareWatch', () => {
    // The viewer side of report 83da3af8: the friend's republished share had no
    // codec and no frames for its whole life - and no event said so.
    it('a share that never receives a packet: one start event after RX_DEAD_MS, "no_packets"', () => {
        const w = new RxDeadShareWatch();
        expect(w.observe(0, 0, 0)).toBeNull();
        expect(w.observe(RX_DEAD_MS - 1, 0, 0)).toBeNull();
        expect(w.observe(RX_DEAD_MS, 0, 0)).toEqual({ phase: 'start', rx: 'no_packets', packets: 0 });
        expect(w.observe(RX_DEAD_MS + 2000, 0, 0)).toBeNull(); // once
    });

    it('packets arriving but nothing decoding is told apart ("packets")', () => {
        const w = new RxDeadShareWatch();
        w.observe(0, 0, 0);
        expect(w.observe(RX_DEAD_MS, 0, 812)).toEqual({ phase: 'start', rx: 'packets', packets: 812 });
    });

    it('when it finally decodes: an end event with how long it was dead; a healthy start logs nothing', () => {
        const w = new RxDeadShareWatch();
        w.observe(1000, 0, 0);
        w.observe(1000 + RX_DEAD_MS, 0, 0);
        expect(w.observe(1000 + RX_DEAD_MS + 4000, 3, 500)).toEqual({ phase: 'end', rx: 'packets', packets: 500, ms: RX_DEAD_MS + 4000 });
        expect(w.observe(99_999, 3, 500)).toBeNull();

        const ok = new RxDeadShareWatch();
        expect(ok.observe(0, 0, 0)).toBeNull();
        expect(ok.observe(2000, 40, 300)).toBeNull();
        expect(ok.observe(2000 + RX_DEAD_MS * 3, 40, 300)).toBeNull(); // a freeze later is the freeze detector's
    });
});

describe('rxSince', () => {
    it('packets between two samples, or not', () => {
        expect(rxSince(100, 140)).toBe('packets');
        expect(rxSince(100, 100)).toBe('no_packets');
        expect(rxSince(undefined, 100)).toBe('no_packets');
    });
});
