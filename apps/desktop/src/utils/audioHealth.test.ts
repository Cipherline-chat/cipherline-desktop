import { describe, it, expect, beforeEach } from 'vitest';
import {
    resetForCall,
    recordNsStats,
    recordNsAutoBypass,
    recordNsUnavailable,
    recordAgcStats,
    getSnapshot,
    subscribe,
    summarize,
} from './audioHealth';

beforeEach(() => {
    resetForCall();
});

describe('audioHealth — reset', () => {
    it('starts every call with a clean snapshot', () => {
        const s = getSnapshot();
        expect(s.nsUnderruns).toBe(0);
        expect(s.nsAutoBypassCount).toBe(0);
        expect(s.nsAutoBypassActive).toBe(false);
        expect(s.nsUnavailable).toBe(false);
        expect(s.agcGainDb).toBeNull();
        expect(s.nsState).toBe('unknown');
    });

    it('clears counters accumulated by a previous call', () => {
        recordNsStats({ underruns: 5, state: 'active' });
        recordNsAutoBypass(true);
        expect(getSnapshot().nsUnderruns).toBe(5);

        resetForCall();
        expect(getSnapshot().nsUnderruns).toBe(0);
        expect(getSnapshot().nsAutoBypassCount).toBe(0);
    });
});

describe('audioHealth — NS stats accumulation', () => {
    it('accumulates underrun counts across multiple stats reports', () => {
        recordNsStats({ underruns: 2, state: 'active' });
        recordNsStats({ underruns: 3, state: 'active' });
        recordNsStats({ underruns: 0, state: 'active' });
        expect(getSnapshot().nsUnderruns).toBe(5);
    });

    it('reflects bypass state from the worklet stats message', () => {
        recordNsStats({ underruns: 1, state: 'bypass' });
        expect(getSnapshot().nsState).toBe('bypassed');
        recordNsStats({ underruns: 0, state: 'active' });
        expect(getSnapshot().nsState).toBe('active');
    });
});

describe('audioHealth — auto-bypass tracking', () => {
    it('counts each trip and tracks current active state independently', () => {
        recordNsAutoBypass(true);
        expect(getSnapshot().nsAutoBypassCount).toBe(1);
        expect(getSnapshot().nsAutoBypassActive).toBe(true);

        recordNsAutoBypass(false);
        expect(getSnapshot().nsAutoBypassCount).toBe(1); // recovery doesn't add a trip
        expect(getSnapshot().nsAutoBypassActive).toBe(false);

        recordNsAutoBypass(true);
        expect(getSnapshot().nsAutoBypassCount).toBe(2);
    });
});

describe('audioHealth — unavailable + AGC stats', () => {
    it('marks nsUnavailable and sets state accordingly', () => {
        recordNsUnavailable();
        expect(getSnapshot().nsUnavailable).toBe(true);
        expect(getSnapshot().nsState).toBe('unavailable');
    });

    it('records the latest AGC gain and voice-active flag', () => {
        recordAgcStats({ gainDb: 6.5, voiceActive: true });
        expect(getSnapshot().agcGainDb).toBe(6.5);
        expect(getSnapshot().agcVoiceActive).toBe(true);

        recordAgcStats({ gainDb: -2.1, voiceActive: false });
        expect(getSnapshot().agcGainDb).toBe(-2.1);
        expect(getSnapshot().agcVoiceActive).toBe(false);
    });
});

describe('audioHealth — subscription', () => {
    it('notifies subscribers on every update and supports unsubscribe', () => {
        let calls = 0;
        const unsubscribe = subscribe(() => { calls++; });

        recordNsStats({ underruns: 1, state: 'active' });
        expect(calls).toBe(1);

        recordAgcStats({ gainDb: 0, voiceActive: false });
        expect(calls).toBe(2);

        unsubscribe();
        recordNsAutoBypass(true);
        expect(calls).toBe(2); // no further notifications after unsubscribe
    });
});

describe('audioHealth — summarize', () => {
    it('produces a readable one-line summary reflecting current state', () => {
        recordNsStats({ underruns: 4, state: 'active' });
        recordAgcStats({ gainDb: 3.25, voiceActive: true });
        const line = summarize();
        expect(line).toContain('underruns=4');
        expect(line).toContain('agcGainDb=3.3'); // toFixed(1) rounding
        expect(line).toContain('ns=active');
    });

    it('reports n/a for AGC gain before any AGC stats have arrived', () => {
        expect(summarize()).toContain('agcGainDb=n/a');
    });
});
