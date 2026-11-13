import { describe, it, expect } from 'vitest';
import { newRxPollTally, tallyRxPoll, rxNoSpeechReason, rxPollFields } from './rxLevelLog';

const NOW = 10_000;

describe('rx_level poll tally - says why a window has no received-voice level', () => {
    it('a receiver that returns no sources at all (the E2EE-transform failure shape) is "no_source"', () => {
        const t = newRxPollTally();
        for (let i = 0; i < 20; i++) expect(tallyRxPoll(t, [], NOW)).toBeUndefined();
        expect(rxNoSpeechReason(t)).toBe('no_source');
        expect(rxPollFields(t)).toEqual({ src_pct: 0, fresh_pct: 0 });
    });

    it('sources without an audioLevel are still "no_source"', () => {
        const t = newRxPollTally();
        tallyRxPoll(t, [{ timestamp: NOW }], NOW);
        expect(rxNoSpeechReason(t)).toBe('no_source');
    });

    it('a level that is older than the stale limit is "stale"', () => {
        const t = newRxPollTally();
        tallyRxPoll(t, [{ timestamp: NOW - 5_000, audioLevel: 0.1 }], NOW);
        expect(rxNoSpeechReason(t)).toBe('stale');
        expect(rxPollFields(t)).toEqual({ src_pct: 100, fresh_pct: 0 });
    });

    it('fresh readings are "quiet" (the leveler just did not call them speech) and are returned', () => {
        const t = newRxPollTally();
        expect(tallyRxPoll(t, [{ timestamp: NOW - 20, audioLevel: 0.002 }], NOW)).toBe(0.002);
        expect(rxNoSpeechReason(t)).toBe('quiet');
        expect(rxPollFields(t)).toEqual({ src_pct: 100, fresh_pct: 100 });
    });

    it('reports shares of the polls, and nothing polled is null', () => {
        const t = newRxPollTally();
        expect(rxNoSpeechReason(t)).toBeNull();
        tallyRxPoll(t, [{ timestamp: NOW, audioLevel: 0.1 }], NOW);
        tallyRxPoll(t, [], NOW);
        tallyRxPoll(t, [], NOW);
        tallyRxPoll(t, [{ timestamp: NOW, audioLevel: 0.1 }], NOW);
        expect(rxPollFields(t)).toEqual({ src_pct: 50, fresh_pct: 50 });
    });
});
