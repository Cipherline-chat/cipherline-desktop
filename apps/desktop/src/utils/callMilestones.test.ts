import { describe, it, expect } from 'vitest';
import { LONG_CALL_MS, createMilestone } from './callMilestones';

const ONE_HOUR_MS = 60 * 60 * 1000;

const H = 60 * 60 * 1000;

describe('the numbers', () => {
    it('are three hours, one hour and one minute', () => {
        expect(LONG_CALL_MS).toBe(3 * H);
    });
});

describe('createMilestone (once: true, a call)', () => {
    const mk = () => createMilestone({ afterMs: LONG_CALL_MS, once: true });

    it('fires on the first check at or after three continuous hours, and only then', () => {
        const m = mk();
        expect(m.update(true, 0)).toBe(false);
        expect(m.update(true, LONG_CALL_MS - 1)).toBe(false);
        expect(m.update(true, LONG_CALL_MS)).toBe(true);
        expect(m.update(true, LONG_CALL_MS + 60_000)).toBe(false);
    });

    it('fires late rather than never when the renderer was asleep or throttled', () => {
        const m = mk();
        m.update(true, 0);
        expect(m.update(true, 7 * H)).toBe(true);
    });

    it('does not fire before the clock has run: the first report starts it', () => {
        const m = mk();
        expect(m.update(true, 50 * H)).toBe(false);
        expect(m.update(true, 50 * H + LONG_CALL_MS)).toBe(true);
    });

    it('leaving resets the clock, so two short stints never add up', () => {
        const m = mk();
        m.update(true, 0);
        m.update(false, 2 * H);
        m.update(true, 2 * H + 1000);
        expect(m.update(true, 4 * H)).toBe(false);          // only ~2h since rejoining
        expect(m.update(true, 2 * H + 1000 + LONG_CALL_MS)).toBe(true);
    });

    it('never repeats for the life of the watcher, even after leaving and a second 3 hours', () => {
        const m = mk();
        m.update(true, 0);
        expect(m.update(true, LONG_CALL_MS)).toBe(true);
        m.update(false, LONG_CALL_MS + 1);
        m.update(true, LONG_CALL_MS + 2);
        expect(m.update(true, 2 * LONG_CALL_MS + 5)).toBe(false);
    });

    it('a clock that steps backwards restarts the run instead of firing', () => {
        const m = mk();
        m.update(true, 10 * H);
        expect(m.update(true, 1 * H)).toBe(false);
        expect(m.runningSince).toBe(1 * H);
    });
});

describe('createMilestone (once: false, a share session)', () => {
    const mk = () => createMilestone({ afterMs: ONE_HOUR_MS, once: false });

    it('fires after an hour of continuous sharing', () => {
        const m = mk();
        m.update(true, 0);
        expect(m.update(true, H - 1)).toBe(false);
        expect(m.update(true, H)).toBe(true);
        expect(m.update(true, H + 30_000)).toBe(false);
    });

    it('once per session: stopping and starting again is a new session that can fire again', () => {
        const m = mk();
        m.update(true, 0);
        expect(m.update(true, H)).toBe(true);
        m.update(false, H + 1000);
        m.update(true, H + 2000);
        expect(m.update(true, H + 2000 + H - 1)).toBe(false);
        expect(m.update(true, H + 2000 + H)).toBe(true);
    });

    it('a share that stops before the hour never fires', () => {
        const m = mk();
        m.update(true, 0);
        m.update(true, 50 * 60_000);
        m.update(false, 55 * 60_000);
        m.update(true, 56 * 60_000);
        expect(m.update(true, 100 * 60_000)).toBe(false);
    });
});
