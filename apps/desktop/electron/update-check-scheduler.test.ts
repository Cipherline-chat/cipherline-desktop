import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UpdateCheckScheduler, UPDATE_SCHEDULE as S, type CheckReason, type SchedulerDeps } from './update-check-scheduler';

const MIN = 60_000;

interface Rig {
    sched: UpdateCheckScheduler;
    runs: CheckReason[];
    logs: string[];
    records: string[];
    setOnline(v: boolean): void;
    setSkip(v: string | null): void;
    failNext(n?: number): void;
    holdNext(): () => void;
}

function rig(overrides: Partial<SchedulerDeps> = {}): Rig {
    const runs: CheckReason[] = [];
    const logs: string[] = [];
    const records: string[] = [];
    let online = true;
    let skip: string | null = null;
    let fails = 0;
    let gate: Promise<void> | null = null;
    const deps: SchedulerDeps = {
        now: () => Date.now(),
        isOnline: () => online,
        canCheck: () => skip,
        run: async (reason) => {
            runs.push(reason);
            if (gate) await gate;
            if (fails > 0) { fails--; throw Object.assign(new Error('offline'), { code: 'ERR_NET' }); }
            return 'not-available';
        },
        describeError: (e) => `error code=${(e as { code?: string }).code}`,
        log: (l) => logs.push(l),
        record: (r, res) => records.push(`${r}:${res}`),
        ...overrides,
    };
    return {
        sched: new UpdateCheckScheduler(deps), runs, logs, records,
        setOnline: (v) => { online = v; },
        setSkip: (v) => { skip = v; },
        failNext: (n = 1) => { fails = n; },
        holdNext: () => { let release!: () => void; gate = new Promise<void>((r) => { release = () => { gate = null; r(); }; }); return release; },
    };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T09:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('check scheduling', () => {
    it('checks about 5 s after start, and logs reason + result', async () => {
        const r = rig();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(S.STARTUP_DELAY_MS - 1);
        expect(r.runs).toEqual([]);
        await vi.advanceTimersByTimeAsync(2);
        expect(r.runs).toEqual(['startup']);
        expect(r.logs).toContain('check reason=startup result=not-available');
        expect(r.records).toContain('startup:not-available');
        r.sched.dispose();
    });

    it('checks at once when told a download is cached (startupDelayMs 0)', async () => {
        const r = rig();
        r.sched.start({ startupDelayMs: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(r.runs).toEqual(['startup']);
        r.sched.dispose();
    });

    it('then checks every 60 minutes — and not before', async () => {
        const r = rig();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(6_000);
        await vi.advanceTimersByTimeAsync(59 * MIN);
        expect(r.runs).toEqual(['startup']);
        await vi.advanceTimersByTimeAsync(2 * MIN);
        expect(r.runs).toEqual(['startup', 'interval']);
        await vi.advanceTimersByTimeAsync(61 * MIN);
        expect(r.runs).toEqual(['startup', 'interval', 'interval']);
        r.sched.dispose();
    });

    it('a machine that slept through the interval checks right after waking (wall clock, not timer time)', async () => {
        const r = rig();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(6_000);
        // Sleep: wall clock jumps 5 h, the timers did not run in between.
        vi.setSystemTime(Date.now() + 5 * 60 * MIN);
        await vi.advanceTimersByTimeAsync(S.TICK_MS);       // first tick after waking: overdue, but inside the settle window
        expect(r.runs).toEqual(['startup']);
        await vi.advanceTimersByTimeAsync(S.RESUME_SETTLE_MS + 1_000);
        expect(r.runs).toEqual(['startup', 'resume']);
        r.sched.dispose();
    });

    it('a power resume checks after the settle delay, once, however many signals arrive', async () => {
        const r = rig();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(6_000);
        await vi.advanceTimersByTimeAsync(20 * MIN);        // past the debounce gap
        r.sched.noteResume(); r.sched.noteResume(); r.sched.noteResume();
        await vi.advanceTimersByTimeAsync(S.RESUME_SETTLE_MS - 1_000);
        expect(r.runs).toEqual(['startup']);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(r.runs).toEqual(['startup', 'resume']);
        r.sched.dispose();
    });

    it('network-online checks when the network comes back', async () => {
        const r = rig();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(6_000);
        await vi.advanceTimersByTimeAsync(20 * MIN);
        r.setOnline(false);
        await vi.advanceTimersByTimeAsync(S.TICK_MS);
        expect(r.runs).toEqual(['startup']);
        r.setOnline(true);
        await vi.advanceTimersByTimeAsync(S.TICK_MS);
        expect(r.runs).toEqual(['startup', 'online']);
        r.sched.dispose();
    });

    it('debounces: at most one automatic check per 10 minutes', async () => {
        const r = rig();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(6_000);            // startup check at t=5s
        r.sched.noteResume();
        await vi.advanceTimersByTimeAsync(S.RESUME_SETTLE_MS + 1_000);
        expect(r.runs).toEqual(['startup']);                 // resume 46 s later: debounced
        expect(r.logs).toContain('check reason=resume result=skipped-debounced');
        r.setOnline(false); await vi.advanceTimersByTimeAsync(S.TICK_MS);
        r.setOnline(true); await vi.advanceTimersByTimeAsync(S.TICK_MS);
        expect(r.runs).toEqual(['startup']);                 // online edge 2 min in: debounced too
        // The held-off network edge is not lost: it runs once the gap has passed — as ONE check.
        await vi.advanceTimersByTimeAsync(10 * MIN);
        expect(r.runs).toEqual(['startup', 'online']);
        await vi.advanceTimersByTimeAsync(11 * MIN);
        r.sched.noteResume();
        await vi.advanceTimersByTimeAsync(S.RESUME_SETTLE_MS + 1_000);
        expect(r.runs).toEqual(['startup', 'online', 'resume']);       // outside the gap: allowed
        r.sched.dispose();
    });

    it('a FAILED check does not hold off the retry that follows the network returning', async () => {
        const r = rig();
        r.setOnline(false);
        r.failNext();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(6_000);            // startup check fails (offline)
        expect(r.records).toContain('startup:error code=ERR_NET');
        r.setOnline(true);
        await vi.advanceTimersByTimeAsync(S.TICK_MS + S.ERROR_MIN_GAP_MS);
        expect(r.runs).toEqual(['startup', 'online']);
        r.sched.dispose();
    });

    it('never stacks: automatic requests during a running check are skipped, a manual one joins it', async () => {
        const r = rig();
        const release = r.holdNext();
        r.sched.start({ startupDelayMs: 0 });
        await vi.advanceTimersByTimeAsync(1);
        expect(r.runs).toEqual(['startup']);                 // running, held
        const auto = await r.sched.check('online');
        expect(auto.result).toBe('skipped-in-flight');
        const manual = r.sched.check('manual');
        release();
        expect((await manual).result).toBe('not-available');
        expect(r.runs).toEqual(['startup']);                 // the manual click did not start a second run
        r.sched.dispose();
    });

    it('a manual check is never debounced and reports the original error', async () => {
        const r = rig();
        r.sched.start({ startupDelayMs: 0 });
        await vi.advanceTimersByTimeAsync(1);
        r.failNext();
        const out = await r.sched.check('manual');
        expect(r.runs).toEqual(['startup', 'manual']);
        expect(out.error).toBeInstanceOf(Error);
        r.sched.dispose();
    });

    it('skips (and says why) while an update is already in flight or downloaded — interval stays silent', async () => {
        const r = rig();
        r.setSkip('update-ready');
        r.sched.start();
        await vi.advanceTimersByTimeAsync(6_000);
        expect(r.runs).toEqual([]);
        expect(r.logs).toContain('check reason=startup result=skipped-update-ready');
        const before = r.logs.length;
        await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
        expect(r.runs).toEqual([]);
        expect(r.logs.length).toBe(before);                  // no log line every 30 s
        r.setSkip(null);
        await vi.advanceTimersByTimeAsync(S.TICK_MS);
        expect(r.runs).toEqual(['interval']);
        r.sched.dispose();
    });

    it('dispose stops everything', async () => {
        const r = rig();
        r.sched.start();
        r.sched.dispose();
        await vi.advanceTimersByTimeAsync(5 * 60 * MIN);
        expect(r.runs).toEqual([]);
    });
});

/**
 * NEGATIVE CONTROL. The scheduling main.ts used before this change, rebuilt
 * as the same kind of scenario runner. The scenarios above must FAIL against
 * it — if they did not, they would not be testing the new behaviour.
 */
describe('negative control: the old 30 s + 4 h schedule', () => {
    function legacy() {
        const runs: string[] = [];
        let online = true;
        const check = () => { if (!online) return; runs.push('check'); };
        setTimeout(check, 30_000);
        setInterval(check, 4 * 60 * MIN);
        return { runs, setOnline: (v: boolean) => { online = v; } };
    }

    it('checks only once in the first 3 hours (the new schedule checks ~every hour)', async () => {
        const l = legacy();
        await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
        expect(l.runs).toHaveLength(1);
        const r = rig();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
        expect(r.runs.length).toBeGreaterThanOrEqual(3);
        r.sched.dispose();
    });

    it('a startup check made before the network is up is lost for 4 hours; the new one recovers when it returns', async () => {
        const l = legacy();
        l.setOnline(false);
        await vi.advanceTimersByTimeAsync(40_000);
        l.setOnline(true);
        await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
        expect(l.runs).toHaveLength(0);

        const r = rig();
        r.setOnline(false); r.failNext();
        r.sched.start();
        await vi.advanceTimersByTimeAsync(40_000);
        r.setOnline(true);
        await vi.advanceTimersByTimeAsync(2 * MIN);
        expect(r.runs).toEqual(['startup', 'online']);
        r.sched.dispose();
    });
});
