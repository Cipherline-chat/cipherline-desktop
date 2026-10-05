import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerCoordinator, RESUME_NOTIFY_DELAY_MS, WAKE_EPISODE_MS, type PowerResumedPayload } from './power-events';

afterEach(() => { vi.useRealTimers(); });

function setup() {
    vi.useFakeTimers();
    const sent: PowerResumedPayload[] = [];
    const phases: string[] = [];
    const pc = new PowerCoordinator(p => sent.push(p), () => Date.now());
    pc.onPhase(p => phases.push(p));
    return { pc, sent, phases };
}

describe('PowerCoordinator — one renderer event per wake', () => {
    it('suspend → resume → unlock (the Windows wake sequence) is ONE power:resumed, after a short beat', () => {
        const { pc, sent, phases } = setup();
        pc.handle('lock-screen');
        pc.handle('suspend');
        vi.advanceTimersByTime(8 * 60 * 60_000);         // slept 8 h
        pc.handle('resume');
        expect(sent).toHaveLength(0);                    // not in the OS's own resume burst
        vi.advanceTimersByTime(500);
        pc.handle('unlock-screen');                       // signed back in quickly
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS);
        expect(sent).toHaveLength(1);
        expect(sent[0].reason).toBe('resume+unlock');
        expect(sent[0].asleepMs).toBe(8 * 60 * 60_000);
        expect(sent[0].lockedMs).toBe(8 * 60 * 60_000 + 500);
        expect(phases).toEqual(['suspend', 'resume']);
    });

    it('an unlock well after the reported wake (user was at the lock screen) is still the same episode', () => {
        const { pc, sent } = setup();
        pc.handle('suspend');
        vi.advanceTimersByTime(60_000);
        pc.handle('resume');
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS + 20_000);
        pc.handle('unlock-screen');
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS);
        expect(sent.map(s => s.reason)).toEqual(['resume']);
    });

    it('a lock/unlock with no sleep is its own episode; a later one is another', () => {
        const { pc, sent, phases } = setup();
        pc.handle('lock-screen');
        vi.advanceTimersByTime(5 * 60_000);
        pc.handle('unlock-screen');
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS);
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ reason: 'unlock', asleepMs: null, lockedMs: 5 * 60_000 });
        expect(phases).toEqual([]);                        // no suspend/resume phase for a lock
        vi.advanceTimersByTime(WAKE_EPISODE_MS);
        pc.handle('lock-screen');
        pc.handle('unlock-screen');
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS);
        expect(sent).toHaveLength(2);
    });

    it('duplicate suspend signals do not restart the sleep clock', () => {
        const { pc, sent, phases } = setup();
        pc.handle('suspend');
        vi.advanceTimersByTime(1000);
        pc.handle('suspend');
        vi.advanceTimersByTime(1000);
        pc.handle('resume');
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS);
        expect(sent[0].asleepMs).toBe(2000);
        expect(phases).toEqual(['suspend', 'resume']);
    });

    it('a clock jump with no suspend event (Modern Standby) is reported as a wake, once', () => {
        const { pc, sent, phases } = setup();
        pc.noteClockJump(45 * 60_000);
        pc.noteClockJump(45 * 60_000);
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS);
        expect(sent.map(s => s.reason)).toEqual(['clock-jump']);
        expect(phases).toEqual(['resume']);
        // ...and a jump right after a real, reported resume is ignored.
        pc.handle('suspend'); pc.handle('resume');
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS);
        pc.noteClockJump(40_000);
        vi.advanceTimersByTime(RESUME_NOTIFY_DELAY_MS);
        expect(sent.map(s => s.reason)).toEqual(['clock-jump', 'resume']);
    });

    it('tracks battery state', () => {
        const { pc } = setup();
        pc.handle('on-battery');
        expect(pc.onBattery).toBe(true);
        pc.handle('on-ac');
        expect(pc.onBattery).toBe(false);
    });

    it('a throwing phase listener does not stop the others', () => {
        const { pc, phases } = setup();
        pc.onPhase(() => { throw new Error('x'); });
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        pc.handle('suspend');
        expect(phases).toEqual(['suspend']);
        err.mockRestore();
    });
});
