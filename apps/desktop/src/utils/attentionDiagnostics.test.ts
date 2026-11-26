import { describe, it, expect, beforeEach } from 'vitest';
import { formatAttentionDiagnostics, getAttentionDiagnostics } from './attentionDiagnostics';
import { publishOsIdleReading, resetInputRecency } from './inputRecency';
import { applySessionPowerSignal, resetSessionLock } from './sessionLock';
import { PUSH_PRESENCE_MAX_SECONDS, getPushPresenceThresholdSeconds, setIdleTimeoutMinutes, DEFAULT_IDLE_TIMEOUT_MINUTES } from './idleThreshold';
import { computeIsAttentive } from './attentionState';

const T = 5_000_000;
beforeEach(() => { resetInputRecency(); resetSessionLock(); setIdleTimeoutMinutes(DEFAULT_IDLE_TIMEOUT_MINUTES); });

describe('push presence threshold cap', () => {
    it('is min(setting, 5 min): 1 and 2 min apply as chosen, 10/15/30 are capped', () => {
        const got = [1, 2, 5, 10, 15, 30].map(m => { setIdleTimeoutMinutes(m); return getPushPresenceThresholdSeconds(); });
        expect(got).toEqual([60, 120, 300, 300, 300, 300]);
        expect(PUSH_PRESENCE_MAX_SECONDS).toBe(300);
    });
    it('with a 30 min setting, 6 min of idle is NOT attentive for push (it would be under the raw setting)', () => {
        setIdleTimeoutMinutes(30);
        expect(computeIsAttentive(true, 360, getPushPresenceThresholdSeconds())).toBe(false);
        expect(computeIsAttentive(true, 360, 30 * 60)).toBe(true); // the old behaviour
    });
});

describe('diagnostics line', () => {
    it('formats idle seconds, away setting and held/sent', () => {
        publishOsIdleReading(12, T);
        expect(formatAttentionDiagnostics(getAttentionDiagnostics(T))).toBe('Idle for 12s · away after 5 min · phone notifications: held');
        publishOsIdleReading(400, T);
        expect(formatAttentionDiagnostics(getAttentionDiagnostics(T))).toBe('Idle for 6m 40s · away after 5 min · phone notifications: sent');
    });
    it('shows the push cap when the away setting is longer', () => {
        setIdleTimeoutMinutes(30);
        publishOsIdleReading(61, T);
        expect(formatAttentionDiagnostics(getAttentionDiagnostics(T))).toBe('Idle for 1m 01s · away after 30 min (phone after 5) · phone notifications: held');
    });
    it('unknown (never read or stale) is "unknown" and sent, not held', () => {
        expect(formatAttentionDiagnostics(getAttentionDiagnostics(T))).toBe('Idle for unknown · away after 5 min · phone notifications: sent');
        publishOsIdleReading(1, T);
        expect(getAttentionDiagnostics(T + 120_000).held).toBe(false);
    });
    it('a locked session is sent regardless of the clock', () => {
        publishOsIdleReading(1, T);
        applySessionPowerSignal('lock-screen', T);
        expect(formatAttentionDiagnostics(getAttentionDiagnostics(T))).toBe('Locked or asleep · away after 5 min · phone notifications: sent');
    });
});
