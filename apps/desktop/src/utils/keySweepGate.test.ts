import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    KeySweepLedger, RecheckBackoff, recheckDelayMs,
    CONVERGED_RECHECK_MS, EPOCH_SWEEP_MIN_GAP_EVENT_MS, EPOCH_SWEEP_MIN_GAP_TICK_MS,
    RECHECK_BASE_MS, RECHECK_MAX_DELAY_MS, RECHECK_FAST_RUNS,
} from './keySweepGate';
import { PREFETCH_TICK_MS } from './channelKeyPrefetch';

const MIN = 60_000;
const T0 = 1_000_000; // evalAt/sweepAt 0 means 'never'; real clocks are never 0

describe('KeySweepLedger: background tick', () => {
    it('evaluates a never-seen server', () => {
        expect(new KeySweepLedger().shouldEvaluate('s', 'tick', 1000)).toBe(true);
    });

    it('skips a converged server until CONVERGED_RECHECK_MS has passed', () => {
        const l = new KeySweepLedger();
        l.noteEvaluated('s', T0, true);
        expect(l.shouldEvaluate('s', 'tick', T0 + PREFETCH_TICK_MS)).toBe(false);
        expect(l.shouldEvaluate('s', 'tick', T0 + CONVERGED_RECHECK_MS - 1)).toBe(false);
        expect(l.shouldEvaluate('s', 'tick', T0 + CONVERGED_RECHECK_MS)).toBe(true);
    });

    it('positive control: an UNconverged server stays on every tick', () => {
        const l = new KeySweepLedger();
        l.noteEvaluated('s', T0, false);
        expect(l.shouldEvaluate('s', 'tick', T0 + PREFETCH_TICK_MS)).toBe(true);
    });

    it('a server with an open history gap is not converged even when no channel is stale', () => {
        const l = new KeySweepLedger();
        l.noteEvaluated('s', T0, true);
        l.tryBeginSweep('s', 'event', T0);
        l.endSweep('s', { ok: true, gap: true });
        expect(l.isConverged('s')).toBe(false);
        expect(l.shouldEvaluate('s', 'tick', T0 + PREFETCH_TICK_MS)).toBe(true);
        l.endSweep('s', { ok: true, gap: false });
        expect(l.isConverged('s')).toBe(true);
    });

    it('event triggers always evaluate, converged or not', () => {
        const l = new KeySweepLedger();
        l.noteEvaluated('s', T0, true);
        expect(l.shouldEvaluate('s', 'event', T0 + 1)).toBe(true);
    });

    it('invalidate (a key was installed) makes the next tick evaluate at once', () => {
        const l = new KeySweepLedger();
        l.noteEvaluated('s', T0, true);
        l.invalidate('s');
        expect(l.shouldEvaluate('s', 'tick', T0 + 1)).toBe(true);
    });

    it('is per server', () => {
        const l = new KeySweepLedger();
        l.noteEvaluated('a', T0, true);
        expect(l.shouldEvaluate('a', 'tick', T0 + MIN)).toBe(false);
        expect(l.shouldEvaluate('b', 'tick', T0 + MIN)).toBe(true);
    });
});

describe('KeySweepLedger: key-epochs sweep gap', () => {
    it('first sweep runs; an overlapping one inside the event gap does not (coalesced)', () => {
        const l = new KeySweepLedger();
        expect(l.tryBeginSweep('s', 'event', 1000)).toBe(true);
        expect(l.tryBeginSweep('s', 'event', 1000 + 5_000)).toBe(false);
        expect(l.tryBeginSweep('s', 'event', 1000 + EPOCH_SWEEP_MIN_GAP_EVENT_MS)).toBe(true);
    });

    it('the tick uses the longer gap', () => {
        const l = new KeySweepLedger();
        expect(l.tryBeginSweep('s', 'tick', 1)).toBe(true);
        expect(l.tryBeginSweep('s', 'tick', 1 + EPOCH_SWEEP_MIN_GAP_TICK_MS - 1)).toBe(false);
        expect(l.tryBeginSweep('s', 'tick', 1 + EPOCH_SWEEP_MIN_GAP_TICK_MS)).toBe(true);
    });

    it('a failed sweep does not burn the gap', () => {
        const l = new KeySweepLedger();
        expect(l.tryBeginSweep('s', 'event', 1)).toBe(true);
        l.endSweep('s', { ok: false });
        expect(l.tryBeginSweep('s', 'event', 2)).toBe(true);
    });

    it('invalidate lets the very next sweep through (keys just installed)', () => {
        const l = new KeySweepLedger();
        l.tryBeginSweep('s', 'event', 1);
        l.invalidate('s');
        expect(l.tryBeginSweep('s', 'event', 2)).toBe(true);
    });
});

describe('RecheckBackoff: the 75 s still-gated re-check', () => {
    const TICK = RECHECK_BASE_MS;
    const noJitter = () => 0.5; // factor exactly 1.0

    it('the first RECHECK_FAST_RUNS runs for an unchanged set run at the timer cadence', () => {
        const b = new RecheckBackoff(noJitter);
        for (let i = 0; i < RECHECK_FAST_RUNS; i++) expect(b.allow('s', ['c1'], i * TICK)).toBe(true);
    });

    it('then backs off exponentially up to the cap', () => {
        const b = new RecheckBackoff(noJitter);
        let now = 0;
        const runAt: number[] = [];
        // Simulate 4 hours of 75 s ticks.
        for (; now < 4 * 60 * MIN; now += TICK) if (b.allow('s', ['c1'], now)) runAt.push(now);
        // Without the gate: 192 runs. With it: bounded by 3 fast + doubling + a 10-minute cap.
        expect(runAt.length).toBeLessThan(40);
        const gaps = runAt.slice(1).map((t, i) => t - runAt[i]);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(RECHECK_MAX_DELAY_MS + TICK);
        // monotone non-decreasing growth of the gaps (modulo tick quantisation)
        expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(gaps[3]);
    });

    it('positive control: a CHANGED affected set resets to the fast cadence at once', () => {
        const b = new RecheckBackoff(noJitter);
        for (let i = 0; i < 12; i++) b.allow('s', ['c1'], i * TICK);
        expect(b.allow('s', ['c1'], 12 * TICK + 1)).toBe(false); // backed off
        expect(b.allow('s', ['c1', 'c2'], 12 * TICK + 2)).toBe(true); // news
        expect(b.allow('s', ['c1', 'c2'], 13 * TICK)).toBe(true);
    });

    it('set order does not matter', () => {
        const b = new RecheckBackoff(noJitter);
        for (let i = 0; i < 10; i++) b.allow('s', ['a', 'b'], i * TICK);
        expect(b.allow('s', ['b', 'a'], 10 * TICK)).toBe(false);
    });

    it('servers are independent; prune forgets servers no longer affected', () => {
        const b = new RecheckBackoff(noJitter);
        for (let i = 0; i < 10; i++) b.allow('a', ['x'], i * TICK);
        expect(b.allow('b', ['y'], 10 * TICK)).toBe(true);
        b.prune(new Set(['b']));
        expect(b.allow('a', ['x'], 10 * TICK + 1)).toBe(true); // forgotten → fresh
    });

    it('delay is capped and jittered within ±15 %', () => {
        expect(recheckDelayMs(RECHECK_FAST_RUNS, () => 0.5)).toBe(0);
        expect(recheckDelayMs(100, () => 0.5)).toBe(RECHECK_MAX_DELAY_MS);
        expect(recheckDelayMs(100, () => 0)).toBe(Math.round(RECHECK_MAX_DELAY_MS * 0.85));
        expect(recheckDelayMs(100, () => 1)).toBe(Math.round(RECHECK_MAX_DELAY_MS * 1.15));
    });
});

describe('simulated idle device: GETs per hour (23 joined servers, nothing missing)', () => {
    // Counts the three reads per evaluated server: pull, channels, key-epochs.
    function simulate(gated: boolean): { before: number; after: number } {
        const SERVERS = 23;
        const HOUR = 60 * MIN;
        const ledger = new KeySweepLedger();
        const backoff = new RecheckBackoff(() => 0.5);
        let after = 0;
        let before = 0;
        const evalServer = (sid: string, mode: 'tick' | 'event', now: number) => {
            if (!ledger.shouldEvaluate(sid, mode, now)) return;
            after += 2; // pull + channels
            ledger.noteEvaluated(sid, now, !(gated && sid === 's0'));
            if (ledger.tryBeginSweep(sid, mode, now)) { after += 1; ledger.endSweep(sid, { ok: true, gap: false }); }
        };
        for (let s = 0; s < SERVERS; s++) evalServer(`s${s}`, 'event', T0); // boot sweep (not counted below)
        after = 0;
        for (let t = T0 + PREFETCH_TICK_MS; t <= T0 + HOUR; t += PREFETCH_TICK_MS) {
            for (let s = 0; s < SERVERS; s++) { before += 3; evalServer(`s${s}`, 'tick', t); }
        }
        if (gated) {
            // one permanently undecryptable channel on one server: the 75 s timer
            for (let t = T0 + 75_000; t <= T0 + HOUR; t += 75_000) {
                before += 3;
                if (backoff.allow('s0', ['c'], t)) { after += 2; if (ledger.tryBeginSweep('s0', 'event', t)) after += 1; }
            }
        }
        return { before, after };
    }

    it('a converged device drops from 828 to well under a third', () => {
        const r = simulate(false);
        expect(r.before).toBe(12 * 23 * 3);
        expect(r.after).toBeLessThanOrEqual(r.before / 3);
        expect(r.after).toBeGreaterThan(0); // positive control: the safety net still runs
    });

    it('one permanently gated channel no longer costs 3 GETs every 75 s', () => {
        const r = simulate(true);
        expect(r.after).toBeLessThan(r.before / 3);
    });
});

describe('Dashboard wiring', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
    const slice = (a: string, b: string) => {
        const i = src.indexOf(a); expect(i, a).toBeGreaterThan(-1);
        const j = src.indexOf(b, i); expect(j, b).toBeGreaterThan(i);
        return src.slice(i, j);
    };

    it('requestMissingChannelKeys gates the tick on the ledger and the key-epochs GET on the sweep claim', () => {
        const fn = slice('const requestMissingChannelKeys = useCallback', 'const refreshProtectedEpochs = useCallback');
        expect(fn).toContain("opts?.background ? 'tick' : 'event'");
        expect(fn).toContain('keySweepLedger.shouldEvaluate(serverId, sweepMode');
        expect(fn).toContain('keySweepLedger.tryBeginSweep(serverId, sweepMode');
        // the claim must come BEFORE the GET it guards
        expect(fn.indexOf('tryBeginSweep')).toBeLessThan(fn.indexOf('/key-epochs'));
        expect(fn).toContain('keySweepLedger.noteEvaluated(');
        expect(fn).toContain('keySweepLedger.endSweep(serverId, { ok: false })');
    });

    it('a key install re-arms the sweep', () => {
        const fn = slice('const pullChannelKeysOnce = useCallback', '// ── Channel key backfill protocol');
        expect(fn).toContain('keySweepLedger.invalidate(serverId)');
    });

    it('the 75 s timer asks the back-off before re-checking a server', () => {
        const fn = slice('// Backstop for the recovery driver pullChannelKeys already runs:', '}, [token, deviceId, requestMissingChannelKeys, attemptFallbackRotation]);');
        expect(fn).toContain('keyRecheckBackoff.allow(sid,');
        // control: the unconditional 1.0.x loop
        expect(fn).not.toContain('for (const sid of affectedServerIds) void requestMissingChannelKeys(sid);');
        // the fallback-rotation pacing below is NOT behind the back-off
        expect(fn.indexOf('planFallbackRotations(candidates')).toBeGreaterThan(fn.indexOf('keyRecheckBackoff.allow'));
    });
});
