import { describe, it, expect } from 'vitest';
import {
    PowerThrottleOptOut, ShareBoostController, cleanPowerResult,
    POWER_ERR_NOT_PRESENT, POWER_ERR_UNAVAILABLE, SHARE_TIMER_RESOLUTION_MS,
    type PowerNativeApi, type SharePowerReport, type PowerThrottleDeps, type PowerBlockerApi,
} from './share-boost';
import { CallPriorityBooster, type PriorityBoosterDeps } from './gaming-video-mode';

/** The native opt-out result the addon gives, as a plain object. */
const OK = (mask = 5) => ({ ok: true, error: 0, mask });
const FAIL = (error: number) => ({ ok: false, error, mask: 0 });

type Proc = { pid: number; type: string };
const MAIN_PID = 10;
const PROCS: Proc[] = [
    { pid: MAIN_PID, type: 'Browser' },
    { pid: 11, type: 'GPU' },
    { pid: 12, type: 'Tab' },
    { pid: 13, type: 'Utility' },
];

/** A fake addon that records every call, in order, and can refuse chosen pids. */
function fakeAddon(opts: { refuse?: Record<number, number>; timerBegins?: boolean } = {}) {
    const calls: Array<{ fn: 'throttle' | 'timer'; args: unknown[] }> = [];
    const api: PowerNativeApi = {
        setProcessPowerThrottling(pid: number, enabled: boolean) {
            calls.push({ fn: 'throttle', args: [pid, enabled] });
            const code = opts.refuse?.[pid];
            return code !== undefined && !enabled ? FAIL(code) : (enabled ? { ok: true, error: 0, mask: 0 } : OK());
        },
        setTimerResolution(ms: number, on: boolean) {
            calls.push({ fn: 'timer', args: [ms, on] });
            return opts.timerBegins === false && on ? false : true;
        },
    };
    return { api, calls };
}

function setup(over: Partial<PowerThrottleDeps> & { addon?: ReturnType<typeof fakeAddon>; procs?: Proc[] } = {}) {
    const addon = over.addon ?? fakeAddon();
    const state = { procs: [...(over.procs ?? PROCS)], native: addon.api as PowerNativeApi | null };
    const reports: SharePowerReport[] = [];
    const opt = new PowerThrottleOptOut({
        platform: over.platform ?? 'win32',
        native: () => state.native,
        listProcesses: () => state.procs.map(p => ({ ...p })),
        selfPid: MAIN_PID,
        report: r => reports.push(r),
    });
    return { opt, addon, state, reports };
}

const throttleCalls = (calls: ReturnType<typeof fakeAddon>['calls']) =>
    calls.filter(c => c.fn === 'throttle').map(c => c.args as [number, boolean]);
const timerCalls = (calls: ReturnType<typeof fakeAddon>['calls']) =>
    calls.filter(c => c.fn === 'timer').map(c => c.args as [number, boolean]);

describe('PowerThrottleOptOut: opt-out / restore lifecycle', () => {
    it('opts the main, GPU and renderer processes OUT (enabled=false) - and nothing else', () => {
        const { opt, addon } = setup();
        opt.setActive(true);
        expect(throttleCalls(addon.calls)).toEqual([[10, false], [11, false], [12, false]]);
        expect(opt.optedOutPids().sort()).toEqual([10, 11, 12]);
        // The utility process (audio service etc.) is left to the OS.
        expect(throttleCalls(addon.calls).some(([pid]) => pid === 13)).toBe(false);
    });

    it('hands every opted-out process back to the OS (enabled=true) on deactivate, and clears', () => {
        const { opt, addon } = setup();
        opt.setActive(true);
        addon.calls.length = 0;
        opt.setActive(false);
        expect(throttleCalls(addon.calls)).toEqual([[10, true], [11, true], [12, true]]);
        expect(opt.optedOutPids()).toEqual([]);
        expect(opt.active).toBe(false);
    });

    it('is idempotent: a second setActive(true)/(false) does nothing more', () => {
        const { opt, addon } = setup();
        opt.setActive(true);
        opt.setActive(true);
        expect(throttleCalls(addon.calls)).toHaveLength(3);
        opt.setActive(false);
        opt.setActive(false);
        expect(throttleCalls(addon.calls)).toHaveLength(6);
    });

    it('always includes the main process, even if the metrics list lost it', () => {
        const { opt, addon } = setup({ procs: [{ pid: 11, type: 'GPU' }] });
        opt.setActive(true);
        expect(throttleCalls(addon.calls).map(([pid]) => pid).sort()).toEqual([10, 11]);
    });

    it('a process the OS refused is not restored (nothing to undo) and not retried', () => {
        const { opt, addon, reports } = setup({ addon: fakeAddon({ refuse: { 12: 5 } }) });
        opt.setActive(true);
        expect(opt.optedOutPids().sort()).toEqual([10, 11]);
        expect(reports[0]).toMatchObject({ phase: 'apply', procs: 3, ok: 2, failed: 1, mainErr: 0, gpuErr: 0, rendererErr: 5 });
        addon.calls.length = 0;
        opt.tick();
        opt.tick();
        expect(throttleCalls(addon.calls)).toEqual([]);   // no retry spam
        opt.setActive(false);
        expect(throttleCalls(addon.calls).map(([pid]) => pid).sort()).toEqual([10, 11]);
    });
});

describe('PowerThrottleOptOut: pid changes', () => {
    it('opts out a process that appears after the share started (a restarted GPU process), once', () => {
        const { opt, addon, state, reports } = setup();
        opt.setActive(true);
        addon.calls.length = 0;
        // GPU process crashed and came back as pid 21.
        state.procs = state.procs.map(p => (p.type === 'GPU' ? { pid: 21, type: 'GPU' } : p));
        opt.tick();
        expect(throttleCalls(addon.calls)).toEqual([[21, false]]);
        expect(opt.optedOutPids().sort((a, b) => a - b)).toEqual([10, 12, 21]);
        expect(reports.at(-1)).toMatchObject({ phase: 'reapply', procs: 1, ok: 1, failed: 0, gpuErr: 0, mainErr: POWER_ERR_NOT_PRESENT });
        // Unchanged list: nothing more, and no report.
        const before = reports.length;
        addon.calls.length = 0;
        opt.tick();
        expect(addon.calls).toEqual([]);
        expect(reports).toHaveLength(before);
    });

    it('restores only the processes that are still there; a vanished pid is simply forgotten', () => {
        const { opt, addon, state } = setup();
        opt.setActive(true);
        state.procs = state.procs.filter(p => p.pid !== 12);   // the renderer exited
        opt.tick();
        addon.calls.length = 0;
        opt.setActive(false);
        expect(throttleCalls(addon.calls).map(([pid]) => pid).sort()).toEqual([10, 11]);
    });

    it('a recycled pid is treated as new (the forgotten entry does not suppress it)', () => {
        const { opt, addon, state } = setup();
        opt.setActive(true);
        state.procs = state.procs.filter(p => p.pid !== 12);
        opt.tick();                                            // 12 gone: forgotten
        addon.calls.length = 0;
        state.procs.push({ pid: 12, type: 'Tab' });            // same number, a different renderer
        opt.tick();
        expect(throttleCalls(addon.calls)).toEqual([[12, false]]);
    });

    it('tick() while inactive does nothing', () => {
        const { opt, addon, reports } = setup();
        opt.tick();
        expect(addon.calls).toEqual([]);
        expect(reports).toEqual([]);
    });
});

describe('PowerThrottleOptOut: timeBeginPeriod / timeEndPeriod pairing', () => {
    it('begins once on activate, never again on re-apply, ends exactly once on deactivate', () => {
        const { opt, addon, state } = setup();
        opt.setActive(true);
        state.procs.push({ pid: 30, type: 'Tab' });
        opt.tick();
        opt.tick();
        opt.setActive(false);
        expect(timerCalls(addon.calls)).toEqual([[SHARE_TIMER_RESOLUTION_MS, true], [SHARE_TIMER_RESOLUTION_MS, false]]);
        expect(SHARE_TIMER_RESOLUTION_MS).toBe(1);
        expect(opt.timerResolutionHeld).toBe(false);
    });

    it('begin comes before the first opt-out; end comes after the last restore', () => {
        const { opt, addon } = setup();
        opt.setActive(true);
        opt.setActive(false);
        const order = addon.calls.map(c => c.fn === 'timer' ? `timer:${(c.args as [number, boolean])[1]}` : `thr:${(c.args as [number, boolean])[1]}`);
        expect(order[0]).toBe('timer:true');
        expect(order.at(-1)).toBe('timer:false');
        expect(order.indexOf('thr:true')).toBeGreaterThan(order.indexOf('thr:false'));
    });

    it('a begin the OS refused is never "ended" (no unbalanced timeEndPeriod)', () => {
        const { opt, addon, reports } = setup({ addon: fakeAddon({ timerBegins: false }) });
        opt.setActive(true);
        expect(reports[0].timer).toBe(false);
        opt.setActive(false);
        expect(timerCalls(addon.calls)).toEqual([[1, true]]);
        expect(reports.at(-1)).toMatchObject({ phase: 'restore', timer: false });
    });

    it('a refused begin is retried on the next re-apply, and then paired', () => {
        let allow = false;
        const calls: boolean[] = [];
        const api: PowerNativeApi = {
            setProcessPowerThrottling: () => OK(),
            setTimerResolution: (_ms, on) => { calls.push(on); return on ? allow : true; },
        };
        const { opt, state } = setup({ addon: { api, calls: [] } });
        opt.setActive(true);
        allow = true;
        state.procs.push({ pid: 40, type: 'Tab' });
        opt.tick();
        expect(opt.timerResolutionHeld).toBe(true);
        opt.setActive(false);
        expect(calls).toEqual([true, true, false]);
    });

    it('re-activating begins again (one begin per activation)', () => {
        const { opt, addon } = setup();
        opt.setActive(true);
        opt.setActive(false);
        opt.setActive(true);
        opt.setActive(false);
        expect(timerCalls(addon.calls).map(c => c[1])).toEqual([true, false, true, false]);
    });

    it('deactivating something that was never activated ends nothing', () => {
        const { opt, addon } = setup();
        opt.setActive(false);
        expect(addon.calls).toEqual([]);
    });
});

describe('PowerThrottleOptOut: the report payloads', () => {
    it('apply reports counts, per-process error codes, the accepted mask and the timer', () => {
        const { opt, reports } = setup();
        opt.setActive(true);
        expect(reports).toEqual([{
            phase: 'apply', procs: 3, ok: 3, failed: 0,
            mainErr: 0, gpuErr: 0, rendererErr: 0, mask: 5, timer: true,
        }]);
    });

    it('a missing GPU process is -1 (not present), distinct from a refusal', () => {
        const { opt, reports } = setup({ procs: [{ pid: 10, type: 'Browser' }, { pid: 12, type: 'Tab' }] });
        opt.setActive(true);
        expect(reports[0]).toMatchObject({ gpuErr: POWER_ERR_NOT_PRESENT, mainErr: 0, rendererErr: 0, procs: 2 });
    });

    it('restore reports how many came back, mask 0, and the timer end', () => {
        const { opt, reports } = setup();
        opt.setActive(true);
        opt.setActive(false);
        expect(reports.at(-1)).toEqual({
            phase: 'restore', procs: 3, ok: 3, failed: 0,
            mainErr: 0, gpuErr: 0, rendererErr: 0, mask: 0, timer: true,
        });
    });

    it('the old-Windows subset mask (1) is passed through', () => {
        const api: PowerNativeApi = { setProcessPowerThrottling: (_p, enabled) => (enabled ? OK(0) : OK(1)), setTimerResolution: () => true };
        const { opt, reports } = setup({ addon: { api, calls: [] } });
        opt.setActive(true);
        expect(reports[0].mask).toBe(1);
    });

    it('several renderers: the first failure is the one reported', () => {
        const { opt, reports } = setup({
            procs: [{ pid: 10, type: 'Browser' }, { pid: 12, type: 'Tab' }, { pid: 14, type: 'Tab' }, { pid: 15, type: 'Tab' }],
            addon: fakeAddon({ refuse: { 14: 87 } }),
        });
        opt.setActive(true);
        expect(reports[0].rendererErr).toBe(87);
        expect(reports[0]).toMatchObject({ ok: 3, failed: 1 });
    });
});

describe('PowerThrottleOptOut: platform and addon availability', () => {
    it.each(['linux', 'darwin'])('does nothing at all on %s', (platform) => {
        const { opt, addon, reports } = setup({ platform });
        opt.setActive(true);
        opt.tick();
        opt.setActive(false);
        expect(addon.calls).toEqual([]);
        expect(reports).toEqual([]);
        expect(opt.active).toBe(false);
    });

    it('addon not loaded (or lacking the exports): reports -2 per process, never throws, ends no timer', () => {
        const { opt, state, reports } = setup();
        state.native = null;
        expect(() => opt.setActive(true)).not.toThrow();
        expect(reports[0]).toMatchObject({ ok: 0, failed: 3, mainErr: POWER_ERR_UNAVAILABLE, gpuErr: POWER_ERR_UNAVAILABLE, rendererErr: POWER_ERR_UNAVAILABLE, mask: 0, timer: false });
        expect(() => opt.setActive(false)).not.toThrow();
        const bare = setup();
        bare.state.native = {};
        bare.opt.setActive(true);
        expect(bare.reports[0].mainErr).toBe(POWER_ERR_UNAVAILABLE);
    });

    it('an addon that throws is contained', () => {
        const api: PowerNativeApi = { setProcessPowerThrottling: () => { throw new Error('boom'); }, setTimerResolution: () => { throw new Error('boom'); } };
        const { opt, reports } = setup({ addon: { api, calls: [] } });
        expect(() => opt.setActive(true)).not.toThrow();
        expect(reports[0]).toMatchObject({ failed: 3, mainErr: POWER_ERR_UNAVAILABLE, timer: false });
        expect(() => opt.setActive(false)).not.toThrow();
    });

    it('a process list that throws is contained (the main process is still handled)', () => {
        const addon = fakeAddon();
        const opt = new PowerThrottleOptOut({
            platform: 'win32', native: () => addon.api, listProcesses: () => { throw new Error('metrics'); }, selfPid: MAIN_PID,
        });
        expect(() => opt.setActive(true)).not.toThrow();
        expect(throttleCalls(addon.calls)).toEqual([[10, false]]);
    });
});

describe('cleanPowerResult (the native boundary)', () => {
    it('accepts the addon shape', () => {
        expect(cleanPowerResult({ ok: true, error: 0, mask: 5 })).toEqual({ ok: true, error: 0, mask: 5 });
        expect(cleanPowerResult({ ok: false, error: 5, mask: 0 })).toEqual({ ok: false, error: 5, mask: 0 });
    });
    it.each([[null], [undefined], ['x'], [1], [{}], [{ ok: 'yes' }], [{ ok: false }], [{ ok: false, error: 0 }], [{ ok: false, error: 1.5 }]])(
        'anything else is "unavailable": %j', (raw) => {
            expect(cleanPowerResult(raw)).toEqual({ ok: false, error: POWER_ERR_UNAVAILABLE, mask: 0 });
        });
    it('a non-integer mask on success is dropped to 0', () => {
        expect(cleanPowerResult({ ok: true, error: 0, mask: 'x' }).mask).toBe(0);
    });
});

describe('ShareBoostController drives the opt-out: (setting ON) AND (share live)', () => {
    function rig() {
        const addon = fakeAddon();
        const procs = PROCS.map(p => ({ ...p }));
        const prio = new Map<number, number>(procs.map(p => [p.pid, 0]));
        const deps: PriorityBoosterDeps = {
            platform: 'win32',
            listPids: () => procs.map(p => p.pid),
            listProcesses: () => procs.map(p => ({ ...p })),
            getPriority: pid => prio.get(pid) ?? 0,
            setPriority: (pid, v) => { prio.set(pid, v); },
        };
        const power: PowerBlockerApi = { start: () => 1, stop: () => {}, isStarted: () => true };
        const reports: SharePowerReport[] = [];
        const throttle = new PowerThrottleOptOut({
            platform: 'win32', native: () => addon.api, listProcesses: () => procs.map(p => ({ ...p })), selfPid: MAIN_PID,
            report: r => reports.push(r),
        });
        const ctl = new ShareBoostController(new CallPriorityBooster(deps), power, throttle);
        return { ctl, addon, reports, throttle };
    }

    it('nothing happens with only the setting, or only a share', () => {
        const { ctl, addon } = rig();
        ctl.setEnabled(true);
        expect(addon.calls).toEqual([]);
        ctl.setEnabled(false);
        ctl.setSharing(true);
        expect(addon.calls).toEqual([]);
        expect(ctl.throttleActive).toBe(false);
    });

    it('both on -> opted out; share ends -> restored', () => {
        const { ctl, addon } = rig();
        ctl.setEnabled(true);
        ctl.setSharing(true);
        expect(ctl.throttleActive).toBe(true);
        expect(throttleCalls(addon.calls).every(([, enabled]) => enabled === false)).toBe(true);
        ctl.setSharing(false);
        expect(ctl.throttleActive).toBe(false);
        expect(throttleCalls(addon.calls).filter(([, e]) => e === true).map(([pid]) => pid).sort()).toEqual([10, 11, 12]);
        expect(timerCalls(addon.calls).map(c => c[1])).toEqual([true, false]);
    });

    it('the setting turned OFF mid-share restores at once', () => {
        const { ctl, addon, reports } = rig();
        ctl.setEnabled(true);
        ctl.setSharing(true);
        ctl.setEnabled(false);
        expect(ctl.throttleActive).toBe(false);
        expect(reports.at(-1)?.phase).toBe('restore');
        expect(timerCalls(addon.calls).map(c => c[1])).toEqual([true, false]);
    });

    it('quit / crash path: setSharing(false) from any state restores exactly once', () => {
        const { ctl, addon } = rig();
        ctl.setEnabled(true);
        ctl.setSharing(true);
        ctl.setSharing(false);
        ctl.setSharing(false);
        expect(timerCalls(addon.calls).filter(c => !c[1])).toHaveLength(1);
    });

    it('tickThrottle re-applies through the controller', () => {
        const { ctl, addon, throttle } = rig();
        ctl.setEnabled(true);
        ctl.setSharing(true);
        addon.calls.length = 0;
        ctl.tickThrottle();
        expect(addon.calls).toEqual([]);                 // nothing new
        expect(throttle.active).toBe(true);
    });

    it('without a throttle (the pre-existing 2-argument form) behaves as before', () => {
        const power: PowerBlockerApi = { start: () => 1, stop: () => {}, isStarted: () => true };
        const deps: PriorityBoosterDeps = {
            platform: 'win32', listPids: () => [], getPriority: () => 0, setPriority: () => {},
        };
        const ctl = new ShareBoostController(new CallPriorityBooster(deps), power);
        ctl.setEnabled(true);
        ctl.setSharing(true);
        expect(ctl.active).toBe(true);
        expect(ctl.throttleActive).toBe(false);
        expect(() => ctl.tickThrottle()).not.toThrow();
    });
});
