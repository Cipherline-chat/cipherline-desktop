import { describe, expect, it } from 'vitest';
import { GLOBAL_GAP_MS, REJOIN_WINDOW_MS, createEntranceGate } from './entranceSoundGate';

const ON = { enabled: true, muted: [] as string[] };

describe('entrance sound gate', () => {
    it('plays the first join', () => {
        expect(createEntranceGate().decide('a', 1000, ON)).toBe('play');
    });

    it('never plays when the listener switch is off', () => {
        expect(createEntranceGate().decide('a', 1000, { enabled: false, muted: [] })).toBe('disabled');
    });

    it('never plays for a person you muted (array or set), and others still play', () => {
        const g = createEntranceGate();
        expect(g.decide('a', 1000, { enabled: true, muted: ['a'] })).toBe('muted');
        expect(g.decide('a', 5000, { enabled: true, muted: new Set(['a']) })).toBe('muted');
        expect(g.decide('b', 9000, { enabled: true, muted: ['a'] })).toBe('play');
    });

    it('suppresses the same person rejoining within 30 s, allows it after', () => {
        const g = createEntranceGate();
        expect(g.decide('a', 0, ON)).toBe('play');
        expect(g.decide('a', 10_000, ON)).toBe('rejoin');
        expect(g.decide('a', REJOIN_WINDOW_MS + 9_999, ON)).toBe('rejoin'); // window slides from the last join SEEN
        expect(g.decide('a', REJOIN_WINDOW_MS + 9_999 + REJOIN_WINDOW_MS, ON)).toBe('play');
    });

    it('rejoin spam every 20 s never plays', () => {
        const g = createEntranceGate();
        expect(g.decide('a', 0, ON)).toBe('play');
        for (let t = 20_000; t <= 200_000; t += 20_000) expect(g.decide('a', t, ON)).toBe('rejoin');
    });

    it('plays at most one sound per 2 s overall: a burst of joiners makes one sound, no backlog', () => {
        const g = createEntranceGate();
        expect(g.decide('a', 10_000, ON)).toBe('play');
        expect(g.decide('b', 10_000 + 500, ON)).toBe('busy');
        expect(g.decide('c', 10_000 + GLOBAL_GAP_MS - 1, ON)).toBe('busy');
        expect(g.decide('d', 10_000 + GLOBAL_GAP_MS, ON)).toBe('play');
    });

    it('a dropped (busy) joiner is not replayed later, and still counts as having joined', () => {
        const g = createEntranceGate();
        g.decide('a', 0, ON);
        expect(g.decide('b', 100, ON)).toBe('busy');
        expect(g.decide('b', 5_000, ON)).toBe('rejoin');
    });

    it('disabled / muted joins do not use up the global slot', () => {
        const g = createEntranceGate();
        expect(g.decide('a', 0, { enabled: true, muted: ['a'] })).toBe('muted');
        expect(g.decide('b', 10, ON)).toBe('play');
    });

    it('reset forgets everything (a new call)', () => {
        const g = createEntranceGate();
        g.decide('a', 0, ON);
        g.reset();
        expect(g.decide('a', 1, ON)).toBe('play');
    });
});
