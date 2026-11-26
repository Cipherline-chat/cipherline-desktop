import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    applySessionPowerSignal, isSessionAway, isSessionSilent, noteSessionInteraction, subscribeSessionAway,
    resetSessionLock, nextIdleVerdict, effectiveIdleSeconds, POST_WAKE_QUIET_MS,
} from './sessionLock';
import { decideIdleAction } from './idleStatusDecision';
import { gateOnOtherDeviceAttention, resolveNotification } from './notificationDecision';
import { computeIsAttentive, isSessionInUse, reduceSessionPowerState, SESSION_AVAILABLE } from './attentionState';

const T = 1_000_000;
const verdict = (o: Partial<Parameters<typeof nextIdleVerdict>[0]>) =>
    nextIdleVerdict({ wasIdle: false, idleSeconds: 0, thresholdSeconds: 300, returnSeconds: 30, away: false, ...o });

beforeEach(() => resetSessionLock());

describe('lock / unlock / suspend / resume as one shared fact', () => {
    it('lock makes the session away at once; unlock restores it', () => {
        expect(isSessionAway()).toBe(false);
        applySessionPowerSignal('lock-screen', T);
        expect(isSessionAway()).toBe(true);
        applySessionPowerSignal('unlock-screen', T + 5000);
        expect(isSessionAway()).toBe(false);
    });

    it('suspend alone is away; the lid reopening on a still-locked screen is NOT in use again (lock, suspend, resume)', () => {
        applySessionPowerSignal('lock-screen', T);
        applySessionPowerSignal('suspend', T + 1);
        applySessionPowerSignal('resume', T + 60_000);
        expect(isSessionAway()).toBe(true);
        applySessionPowerSignal('unlock-screen', T + 61_000);
        expect(isSessionAway()).toBe(false);
    });

    it('listeners fire only on an in-use/away FLIP, in both directions, not on repeats', () => {
        const fn = vi.fn();
        subscribeSessionAway(fn);
        applySessionPowerSignal('lock-screen', T);
        applySessionPowerSignal('lock-screen', T + 1);   // duplicate (two Linux sources)
        applySessionPowerSignal('suspend', T + 2);       // already away
        expect(fn).toHaveBeenCalledTimes(1);
        applySessionPowerSignal('resume', T + 3);        // still locked
        expect(fn).toHaveBeenCalledTimes(1);
        applySessionPowerSignal('unlock-screen', T + 4);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('a throwing listener does not stop the others', () => {
        const ok = vi.fn();
        subscribeSessionAway(() => { throw new Error('boom'); });
        subscribeSessionAway(ok);
        applySessionPowerSignal('lock-screen', T);
        expect(ok).toHaveBeenCalledTimes(1);
    });

    it('unknown signals change nothing', () => {
        applySessionPowerSignal('on-battery', T);
        expect(isSessionAway()).toBe(false);
    });

    it('real input in this window proves the session is in use (missed unlock edge), and says so once', () => {
        const fn = vi.fn();
        subscribeSessionAway(fn);
        applySessionPowerSignal('lock-screen', T);
        expect(noteSessionInteraction()).toBe(true);
        expect(isSessionAway()).toBe(false);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(noteSessionInteraction()).toBe(false); // nothing to fix: no-op
        expect(fn).toHaveBeenCalledTimes(2);
    });
});

describe('status goes idle on lock and is restored on unlock', () => {
    it('locked: idle even though the OS idle clock says the user just typed (password entry)', () => {
        expect(verdict({ away: true, idleSeconds: 0 })).toBe(true);
        // positive control: the same reading while NOT locked is not idle
        expect(verdict({ away: false, idleSeconds: 0 })).toBe(false);
    });

    it('unlocked: the verdict returns to the clock, with hysteresis (30 s back, 300 s in)', () => {
        expect(verdict({ wasIdle: true, idleSeconds: 29 })).toBe(false);
        expect(verdict({ wasIdle: true, idleSeconds: 31 })).toBe(true);
        expect(verdict({ wasIdle: false, idleSeconds: 299 })).toBe(false);
        expect(verdict({ wasIdle: false, idleSeconds: 300 })).toBe(true);
    });

    it('unlocking counts as input even if the OS clock did not see the password typed', () => {
        applySessionPowerSignal('lock-screen', T);
        applySessionPowerSignal('unlock-screen', T + 3_600_000);
        // OS says 1 h idle (the credential entry was on the lock screen); we say "just unlocked"
        expect(effectiveIdleSeconds(3600, T + 3_600_000 + 2000)).toBeCloseTo(2, 1);
        expect(verdict({ wasIdle: true, idleSeconds: effectiveIdleSeconds(3600, T + 3_600_000 + 2000) })).toBe(false);
        // ...but it is not a permanent override: long after, the clock rules again
        // (past the 10 s unlock window the OS clock decides again, so a late or
        // repeated signal cannot hold idle near 0 for a whole timeout)
        expect(effectiveIdleSeconds(3600, T + 3_600_000 + 400_000)).toBe(3600);
        expect(effectiveIdleSeconds(3600, T + 3_600_000 + 11_000)).toBe(3600);
        expect(verdict({ wasIdle: false, idleSeconds: 400 })).toBe(true);
        // unknown / negative readings stay unknown (never promoted to "recent input")
        expect(effectiveIdleSeconds(Number.NaN, T)).toBeNaN();
        expect(effectiveIdleSeconds(-1, T)).toBe(-1);
    });

    it('a repeated or spurious unlock-screen (no lock before it) does not refresh the "just used" cap', () => {
        applySessionPowerSignal('unlock-screen', T); // never locked: spurious
        expect(effectiveIdleSeconds(3600, T + 2000)).toBe(3600);
        applySessionPowerSignal('lock-screen', T + 5000);
        applySessionPowerSignal('unlock-screen', T + 6000); // real
        expect(effectiveIdleSeconds(3600, T + 8000)).toBeCloseTo(2, 1);
        applySessionPowerSignal('unlock-screen', T + 60_000); // repeated, no lock between
        expect(effectiveIdleSeconds(3600, T + 62_000)).toBe(3600);
    });

    describe('what the verdict does to the user\'s chosen status', () => {
        const base = { serverAutoAway: true, wasIdle: false, idle: true, current: 'online' as const, autoAway: false };

        it('new server: lock reports idle (the server decides across devices)', () => {
            expect(decideIdleAction(base)).toEqual({ kind: 'report-idle', idle: true });
            expect(decideIdleAction({ ...base, wasIdle: true, idle: false })).toEqual({ kind: 'report-idle', idle: false });
            expect(decideIdleAction({ ...base, wasIdle: true, idle: true })).toEqual({ kind: 'none' }); // no repeat
        });

        it('legacy server: Online goes to away on lock and back on unlock, but only an AUTOMATIC away is restored', () => {
            const legacy = { ...base, serverAutoAway: false };
            expect(decideIdleAction(legacy)).toEqual({ kind: 'auto-away' });
            expect(decideIdleAction({ ...legacy, idle: false, current: 'away', autoAway: true })).toEqual({ kind: 'auto-return' });
            expect(decideIdleAction({ ...legacy, idle: false, current: 'away', autoAway: false })).toEqual({ kind: 'none' }); // user chose Idle
        });

        it('legacy server: Do Not Disturb and Invisible are never touched by a lock or an unlock', () => {
            for (const current of ['dnd', 'offline'] as const) {
                expect(decideIdleAction({ ...base, serverAutoAway: false, current, idle: true })).toEqual({ kind: 'none' });
                expect(decideIdleAction({ ...base, serverAutoAway: false, current, idle: false, autoAway: true })).toEqual({ kind: 'none' });
            }
        });
    });
});

describe('attention is cleared at once on lock and returns on unlock (R4)', () => {
    it('a locked session is never attentive, however recent the input', () => {
        let s = reduceSessionPowerState(SESSION_AVAILABLE, 'lock-screen');
        expect(computeIsAttentive(isSessionInUse(s), 0, 300)).toBe(false);
        s = reduceSessionPowerState(s, 'unlock-screen');
        expect(computeIsAttentive(isSessionInUse(s), 2, 300)).toBe(true);
    });
});

describe('the desktop stays silent while locked (no double notification)', () => {
    const loud = resolveNotification({
        text: 'hi', directMention: false, keywords: [], mode: 'all', windowFocused: false,
        isActiveConversation: false, suppressWhenActiveConv: false, dndActive: false, dndLetMentionsThrough: false,
    });

    it('control: unlocked, nothing silences a normal message', () => {
        expect(loud.playsSound && loud.showsToast).toBe(true);
        const d = gateOnOtherDeviceAttention(loud, { category: 'message', mobileAttentive: false, sessionSilent: isSessionSilent(T) });
        expect(d).toEqual(loud);
    });

    it('locked: no sound, no toast; badges (countsUnread / countsMention) are untouched', () => {
        applySessionPowerSignal('lock-screen', T);
        const d = gateOnOtherDeviceAttention(loud, { category: 'message', mobileAttentive: false, sessionSilent: isSessionSilent(T) });
        expect(d.playsSound).toBe(false);
        expect(d.showsToast).toBe(false);
        expect(d.countsUnread).toBe(loud.countsUnread);
        expect(d.countsMention).toBe(loud.countsMention);
    });

    it('a ringing call is NOT silenced (same rule as the phone-attentive gate)', () => {
        applySessionPowerSignal('lock-screen', T);
        expect(gateOnOtherDeviceAttention(loud, { category: 'call', mobileAttentive: false, sessionSilent: true })).toEqual(loud);
    });

    it('after unlock alerts are live again (no quiet window for a plain unlock)', () => {
        applySessionPowerSignal('lock-screen', T);
        applySessionPowerSignal('unlock-screen', T + 1000);
        expect(isSessionSilent(T + 1001)).toBe(false);
    });

    it('after a wake the catch-up burst stays quiet for POST_WAKE_QUIET_MS, then alerts return', () => {
        applySessionPowerSignal('suspend', T);
        applySessionPowerSignal('resume', T + 600_000);
        expect(isSessionSilent(T + 600_000 + 1)).toBe(true);
        expect(isSessionSilent(T + 600_000 + POST_WAKE_QUIET_MS - 1)).toBe(true);
        expect(isSessionSilent(T + 600_000 + POST_WAKE_QUIET_MS)).toBe(false);
    });
});

describe('wiring (hooks import Electron-bound code, so the source is pinned)', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

    it('useRealtime feeds the shared state from every power signal and from real input', () => {
        const src = read('../hooks/useRealtime.ts');
        expect(src).toContain('applySessionPowerSignal(signal)');
        expect(src).toContain("document.addEventListener('pointerdown', onInteraction, true)");
        expect(src).toContain('transform: effectiveIdleSeconds');
    });

    it('useUserStatus: a session flip re-evaluates idle at once, and a locked session skips the idle clock', () => {
        const src = read('../hooks/useUserStatus.ts');
        expect(src).toContain('subscribeSessionAway(() => { void evaluate(); })');
        expect(src).toContain('const away = isSessionAway()');
        expect(src).toContain('decideIdleAction(');
    });

    it('the notification dispatcher passes the session verdict to the gate', () => {
        expect(read('../hooks/useNotificationDispatch.ts')).toContain('sessionSilent: isSessionSilent()');
    });
});
