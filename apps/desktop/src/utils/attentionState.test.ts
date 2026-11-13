import { describe, it, expect } from 'vitest';
import {
    computeIsAttentive, heartbeatPayload, IDLE_THRESHOLD_SECONDS,
    reduceSessionPowerState, isSessionInUse, SESSION_AVAILABLE, OS_POWER_SIGNALS,
    nextIdlePollDelayMs, type SessionPowerState,
} from './attentionState';

/**
 * The attention state machine's one decision. Owner's rules R1-R4: the PC is
 * "in use" when input idle time is under the idle timeout and the session is
 * available, REGARDLESS of which window has focus (a person working in another
 * app on the same PC does not need a phone buzz); a locked or suspended
 * session is never in use; idle at or past the timeout is not in use; unknown
 * readings fail conservative.
 */
describe('computeIsAttentive', () => {
    it('session available with recent input → true (window focus is not an input)', () => {
        expect(computeIsAttentive(true, 0)).toBe(true);
        expect(computeIsAttentive(true, 5)).toBe(true);
    });

    it('UNFOCUSED but actively using the PC (idle ~0) → attentive: working in another app counts', () => {
        // The function takes no focus argument at all: that is the contract.
        // Cipherline minimised/behind a browser is indistinguishable here from
        // Cipherline in front, and both must read attentive while input is fresh.
        expect(computeIsAttentive(true, 1)).toBe(true);
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS - 1)).toBe(true);
    });

    it('locked / suspended session → false, regardless of how recent the input was', () => {
        expect(computeIsAttentive(false, 0)).toBe(false);
        expect(computeIsAttentive(false, 0, 999_999)).toBe(false);
    });

    it('idle at or past the threshold → false', () => {
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS)).toBe(false);
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS + 1)).toBe(false);
    });

    it('boundary: one second under the threshold is attentive, exactly the threshold is not', () => {
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS - 1)).toBe(true);
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS)).toBe(false);
        // fractional readings straddle the edge too
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS - 0.001)).toBe(true);
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS + 0.001)).toBe(false);
    });

    it('uses the real default threshold (300s) when none is passed', () => {
        expect(IDLE_THRESHOLD_SECONDS).toBe(300);
        expect(computeIsAttentive(true, 299)).toBe(true);
        expect(computeIsAttentive(true, 300)).toBe(false);
    });

    it('an unknown/invalid idle reading fails conservative (not attentive), never true', () => {
        expect(computeIsAttentive(true, NaN)).toBe(false);
        expect(computeIsAttentive(true, -1)).toBe(false);
        expect(computeIsAttentive(true, Infinity)).toBe(false);
        expect(computeIsAttentive(true, Number.POSITIVE_INFINITY)).toBe(false);
        expect(computeIsAttentive(true, -Infinity)).toBe(false);
    });

    it('the user\'s threshold is honoured, in both directions', () => {
        // 1-minute timeout: 61 s idle is idle, though the default would say active.
        expect(computeIsAttentive(true, 61, 60)).toBe(false);
        expect(computeIsAttentive(true, 59, 60)).toBe(true);
        // 30-minute timeout: 10 minutes idle is still in use.
        expect(computeIsAttentive(true, 600, 1800)).toBe(true);
        expect(computeIsAttentive(true, 1800, 1800)).toBe(false);
    });

    it('a nonsensical threshold never makes anyone attentive', () => {
        expect(computeIsAttentive(true, 0, NaN)).toBe(false);
        expect(computeIsAttentive(true, 0, 0)).toBe(false);
        expect(computeIsAttentive(true, 0, -5)).toBe(false);
    });
});

/**
 * Lock / suspend / quit must still report not-attentive IMMEDIATELY and stay
 * that way until the matching unlock/resume. Lock and suspend are independent
 * facts: a laptop locked then closed emits lock → suspend → resume, and after
 * that resume the screen is still locked.
 */
describe('session power state', () => {
    const run = (signals: string[], from: SessionPowerState = SESSION_AVAILABLE) =>
        signals.reduce(reduceSessionPowerState, from);

    it('starts available', () => {
        expect(isSessionInUse(SESSION_AVAILABLE)).toBe(true);
    });

    it('lock-screen → not in use; unlock-screen → in use again', () => {
        expect(isSessionInUse(run(['lock-screen']))).toBe(false);
        expect(isSessionInUse(run(['lock-screen', 'unlock-screen']))).toBe(true);
    });

    it('suspend → not in use; resume → in use again', () => {
        expect(isSessionInUse(run(['suspend']))).toBe(false);
        expect(isSessionInUse(run(['suspend', 'resume']))).toBe(true);
    });

    it('lock → suspend → resume is STILL not in use (the lock screen is still up)', () => {
        const s = run(['lock-screen', 'suspend', 'resume']);
        expect(s).toEqual({ locked: true, suspended: false });
        expect(isSessionInUse(s)).toBe(false);
        // only the unlock ends it
        expect(isSessionInUse(reduceSessionPowerState(s, 'unlock-screen'))).toBe(true);
    });

    it('the pair arrives in either order: unlock before resume leaves it suspended', () => {
        const s = run(['lock-screen', 'suspend', 'unlock-screen']);
        expect(isSessionInUse(s)).toBe(false);
        expect(isSessionInUse(reduceSessionPowerState(s, 'resume'))).toBe(true);
    });

    it('repeated signals are idempotent', () => {
        expect(run(['lock-screen', 'lock-screen'])).toEqual({ locked: true, suspended: false });
        expect(run(['unlock-screen', 'unlock-screen'])).toEqual(SESSION_AVAILABLE);
        expect(run(['suspend', 'suspend', 'resume'])).toEqual(SESSION_AVAILABLE);
    });

    it('an unknown signal changes nothing (never unlocks, never locks)', () => {
        const locked = run(['lock-screen']);
        expect(reduceSessionPowerState(locked, 'shutdown')).toBe(locked);
        expect(reduceSessionPowerState(locked, '')).toBe(locked);
        expect(reduceSessionPowerState(SESSION_AVAILABLE, 'bogus')).toBe(SESSION_AVAILABLE);
    });

    it('the reducer does not mutate the state it is given', () => {
        const before = { locked: false, suspended: false };
        reduceSessionPowerState(before, 'lock-screen');
        expect(before).toEqual({ locked: false, suspended: false });
    });

    it('feeds the decision: a locked PC with idle 0 is not attentive, unlocked it is', () => {
        const locked = run(['lock-screen']);
        expect(computeIsAttentive(isSessionInUse(locked), 0)).toBe(false);
        expect(computeIsAttentive(isSessionInUse(reduceSessionPowerState(locked, 'unlock-screen')), 0)).toBe(true);
    });

    it('exports exactly the four signals main forwards', () => {
        expect([...OS_POWER_SIGNALS].sort()).toEqual(['lock-screen', 'resume', 'suspend', 'unlock-screen']);
    });
});

describe('nextIdlePollDelayMs', () => {
    it('attentive: sleeps until just after the threshold, so the idle edge is precise', () => {
        // 290 s idle of a 300 s timeout → ~10.25 s, not a full 30 s slot.
        expect(nextIdlePollDelayMs(290, 300)).toBe(10_250);
    });

    it('attentive and far from the threshold: capped at the slow cadence', () => {
        expect(nextIdlePollDelayMs(0, 300)).toBe(30_000);
        expect(nextIdlePollDelayMs(0, 1800)).toBe(30_000);
    });

    it('about to elapse: never below the floor (no hot loop)', () => {
        expect(nextIdlePollDelayMs(299.9, 300)).toBe(1_000);
    });

    it('already idle: polls fast so a return to the keyboard is noticed in seconds', () => {
        expect(nextIdlePollDelayMs(300, 300)).toBe(10_000);
        expect(nextIdlePollDelayMs(900, 300)).toBe(10_000);
    });

    it('unknown reading or bad threshold: the fast idle cadence, never a long sleep', () => {
        expect(nextIdlePollDelayMs(NaN, 300)).toBe(10_000);
        expect(nextIdlePollDelayMs(Infinity, 300)).toBe(10_000);
        expect(nextIdlePollDelayMs(-1, 300)).toBe(10_000);
        expect(nextIdlePollDelayMs(5, NaN)).toBe(10_000);
        expect(nextIdlePollDelayMs(5, 0)).toBe(10_000);
    });
});

describe('the heartbeat on the wire', () => {
    it('is exactly { event: "presence:heartbeat", data: { active } }', () => {
        expect(JSON.parse(heartbeatPayload(true))).toEqual({ event: 'presence:heartbeat', data: { active: true } });
        expect(JSON.parse(heartbeatPayload(false))).toEqual({ event: 'presence:heartbeat', data: { active: false } });
    });

    it('useRealtime sends every heartbeat through it, from the idle/lock inputs, with no focus gate', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(__dirname, '..', 'hooks', 'useRealtime.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        // No hand-built heartbeat left, and no cached verdict sent as-is.
        expect(src).not.toMatch(/event:\s*'presence:heartbeat'/);
        expect(src).not.toContain('active: attentiveRef.current');
        // Connect + periodic heartbeats read the live inputs; loss events send false.
        expect(src.match(/ws\.send\(heartbeatPayload\(currentAttention\(\)\)\)/g)?.length).toBe(2);
        expect(src).toContain('heartbeatPayload(active)');
        // The verdict is idle + session state against the USER's threshold.
        expect(src).toContain('computeIsAttentive(isSessionInUse(powerStateRef.current), idleSecondsRef.current, getIdleThresholdSeconds())');
        // Focus / blur / minimise / hide no longer clear attention.
        expect(src).not.toContain('onWindowBlur');
        expect(src).not.toContain('onWindowMinimize');
        expect(src).not.toContain('onWindowHide');
        expect(src).not.toContain('focusedRef');
        expect(src).not.toContain('isWindowAttendable');
        expect(src).not.toContain("document.visibilityState === 'hidden'");
        // Lock / suspend / quit still report at once.
        expect(src).toContain('onOsPowerSignal');
        expect(src).toContain('onBeforeQuit');
        // A threshold change must reach the poller: it reads the live getter, not a constant.
        expect(src).not.toMatch(/\bIDLE_THRESHOLD_SECONDS\b/);
    });
});
