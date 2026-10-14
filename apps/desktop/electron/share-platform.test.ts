import { describe, it, expect } from 'vitest';
import { shareBoostSupport } from './share-platform';
import {
    CallPriorityBooster, gamingVideoStartupSwitches, GAMING_VIDEO_SWITCHES, GAMING_VIDEO_DISABLED_FEATURE,
    type PriorityBoosterDeps,
} from './gaming-video-mode';
import {
    ShareBoostController, PowerThrottleOptOut, GpuSchedulingBoost, launchThrottleSwitches, SHARE_BOOST_DISABLED_FEATURES_WIN,
    type PowerBlockerApi, type SharePowerReport,
} from './share-boost';
import { foregroundAnswerWithoutAddon } from './share-foreground';

/**
 * The cross-platform parity table (share-platform.ts) and what each platform
 * actually does with it: "Prioritize calls and screen share while gaming" is
 * shown everywhere and does what the OS allows - nothing more, nothing less.
 */

describe('shareBoostSupport - the table', () => {
    it('Windows has every part, including the D3DKMT GPU scheduling priority', () => {
        expect(shareBoostSupport('win32')).toEqual({
            priorityBoost: true, powerThrottleOptOut: true, powerBlocker: true, backgroundSwitches: true,
            occlusionFeatureOff: true, gpuPriority: true, foreground: 'native', fullscreenHint: true,
        });
    });

    it.each(['linux', 'darwin'])('%s: the Chromium switches and the power request only', (platform) => {
        expect(shareBoostSupport(platform)).toEqual({
            priorityBoost: false, powerThrottleOptOut: false, powerBlocker: true, backgroundSwitches: true,
            occlusionFeatureOff: false, gpuPriority: false, foreground: 'unavailable', fullscreenHint: false,
        });
    });

    it('an unknown platform is treated like the non-Windows ones (nothing privileged is attempted)', () => {
        expect(shareBoostSupport('freebsd')).toEqual(shareBoostSupport('linux'));
    });

    it('the GPU scheduling priority (D3DKMT) is Windows-only', () => {
        expect(shareBoostSupport('win32').gpuPriority).toBe(true);
        for (const p of ['linux', 'darwin', 'freebsd']) expect(shareBoostSupport(p).gpuPriority).toBe(false);
    });

    it('the hint exists exactly where the foreground answer does', () => {
        for (const p of ['win32', 'linux', 'darwin']) {
            const s = shareBoostSupport(p);
            expect(s.fullscreenHint).toBe(s.foreground === 'native');
        }
    });
});

describe('launch switches per platform (setting ON)', () => {
    it.each(['win32', 'linux', 'darwin'])('%s gets the three Chromium backgrounding switches', (platform) => {
        expect(gamingVideoStartupSwitches(true, platform).switches).toEqual([...GAMING_VIDEO_SWITCHES]);
        expect(launchThrottleSwitches(true, platform).switches).toEqual([...GAMING_VIDEO_SWITCHES]);
    });

    it('the Windows-only features are disabled on Windows and ONLY there', () => {
        expect(launchThrottleSwitches(true, 'win32').disableFeatures)
            .toEqual([GAMING_VIDEO_DISABLED_FEATURE, ...SHARE_BOOST_DISABLED_FEATURES_WIN]);
        for (const p of ['linux', 'darwin']) {
            expect(gamingVideoStartupSwitches(true, p).disableFeatures).toEqual([]);
            expect(launchThrottleSwitches(true, p).disableFeatures).toEqual([]);
        }
    });

    it.each(['win32', 'linux', 'darwin'])('%s: setting OFF adds nothing', (platform) => {
        expect(launchThrottleSwitches(false, platform)).toEqual({ switches: [], disableFeatures: [] });
    });
});

function fakeOs(platform: string) {
    const calls: string[] = [];
    const deps: PriorityBoosterDeps = {
        platform,
        listPids: () => [10, 11, 12],
        listProcesses: () => [{ pid: 10, type: 'Browser' }, { pid: 11, type: 'GPU' }, { pid: 12, type: 'Tab' }],
        getPriority: (pid) => { calls.push(`get:${pid}`); return 0; },
        setPriority: (pid, p) => { calls.push(`set:${pid}:${p}`); },
    };
    return { deps, calls };
}

function fakePower() {
    const log: string[] = [];
    let next = 1;
    const held = new Set<number>();
    const api: PowerBlockerApi = {
        start: (type) => { log.push(`start:${type}`); const id = next++; held.add(id); return id; },
        stop: (id) => { log.push(`stop:${id}`); held.delete(id); },
        isStarted: (id) => held.has(id),
    };
    return { api, log, held };
}

describe.each(['linux', 'darwin'])('a share on %s', (platform) => {
    function build() {
        const os = fakeOs(platform);
        const power = fakePower();
        const nativeCalls: string[] = [];
        const reports: SharePowerReport[] = [];
        const throttle = new PowerThrottleOptOut({
            platform,
            native: () => ({
                setProcessPowerThrottling: (pid: number) => { nativeCalls.push(`throttle:${pid}`); return { ok: true, error: 0, mask: 5 }; },
                setTimerResolution: () => { nativeCalls.push('timer'); return true; },
            }),
            listProcesses: () => [{ pid: 10, type: 'Browser' }, { pid: 11, type: 'GPU' }, { pid: 12, type: 'Tab' }],
            selfPid: 10,
            report: (r) => reports.push(r),
        });
        const gpuReports: unknown[] = [];
        const gpuSched = new GpuSchedulingBoost({
            platform,
            native: () => ({
                setGpuSchedulingPriority: (pid: number) => { nativeCalls.push(`gpusched:${pid}`); return { ok: true, error: 0, level: 5 }; },
                getGpuSchedulingPriority: (pid: number) => { nativeCalls.push(`gpusched-get:${pid}`); return { ok: true, error: 0, level: 5 }; },
            }),
            listProcesses: () => [{ pid: 10, type: 'Browser' }, { pid: 11, type: 'GPU' }],
            selfPid: 10,
            report: (r) => gpuReports.push(r),
        });
        const booster = new CallPriorityBooster(os.deps);
        const controller = new ShareBoostController(booster, power.api, throttle, gpuSched);
        return { os, power, nativeCalls, reports, gpuReports, gpuSched, controller, booster };
    }

    it('holds prevent-app-suspension exactly while (setting on) AND (a share is live)', () => {
        const { power, controller } = build();
        controller.setEnabled(true);
        expect(power.held.size).toBe(0);
        controller.setSharing(true);
        expect(power.log).toEqual(['start:prevent-app-suspension']);
        expect(controller.blockerHeld).toBe(true);
        controller.setSharing(false);
        expect(power.log).toEqual(['start:prevent-app-suspension', 'stop:1']);
        expect(power.held.size).toBe(0);
    });

    it('releases the request when the setting goes off mid-share', () => {
        const { power, controller } = build();
        controller.setEnabled(true);
        controller.setSharing(true);
        controller.setEnabled(false);
        expect(power.held.size).toBe(0);
    });

    it('never reads or writes any process priority - not up (needs CAP_SYS_NICE) and not down', () => {
        const { os, controller, booster } = build();
        controller.setEnabled(true);
        booster.setInCall(true);
        controller.setSharing(true);
        controller.tickThrottle();
        booster.tick();
        controller.setSharing(false);
        booster.setInCall(false);
        expect(booster.active).toBe(false);
        expect(booster.raisedPids()).toEqual([]);
        expect(os.calls).toEqual([]);
    });

    it('never calls the Windows power-throttling or D3DKMT GPU-scheduling addon and never reports either', () => {
        const { nativeCalls, reports, gpuReports, gpuSched, controller } = build();
        controller.setEnabled(true);
        controller.setSharing(true);
        controller.tickThrottle();
        controller.setSharing(false);
        expect(controller.throttleActive).toBe(false);
        expect(gpuSched.active).toBe(false);
        expect(gpuSched.heldPids()).toEqual([]);
        expect(nativeCalls).toEqual([]);
        expect(reports).toEqual([]);
        expect(gpuReports).toEqual([]);
    });
});

describe('Windows still does all of it (the parity work changed nothing there)', () => {
    it('raises priority, holds the request and opts out of power throttling for a share', () => {
        const os = fakeOs('win32');
        const power = fakePower();
        const nativeCalls: string[] = [];
        const throttle = new PowerThrottleOptOut({
            platform: 'win32',
            native: () => ({
                setProcessPowerThrottling: (pid: number) => { nativeCalls.push(`throttle:${pid}`); return { ok: true, error: 0, mask: 5 }; },
                setTimerResolution: () => { nativeCalls.push('timer'); return true; },
            }),
            listProcesses: () => [{ pid: 10, type: 'Browser' }, { pid: 11, type: 'GPU' }, { pid: 12, type: 'Tab' }],
            selfPid: 10,
        });
        const c = new ShareBoostController(new CallPriorityBooster(os.deps), power.api, throttle);
        c.setEnabled(true);
        c.setSharing(true);
        expect(os.calls.some(x => x.startsWith('set:'))).toBe(true);
        expect(power.held.size).toBe(1);
        expect(c.throttleActive).toBe(true);
        expect(nativeCalls).toContain('timer');
        expect(nativeCalls.filter(x => x.startsWith('throttle:'))).toHaveLength(3);
    });
});

describe('the foreground answer off Windows', () => {
    it('Linux and macOS answer an explicit "unavailable", never null and never a guess', () => {
        for (const p of ['linux', 'darwin']) expect(foregroundAnswerWithoutAddon(p)).toEqual({ unavailable: true });
    });

    it('Windows (the addon decides) and unknown platforms give nothing here', () => {
        expect(foregroundAnswerWithoutAddon('win32')).toBeNull();
        expect(foregroundAnswerWithoutAddon('freebsd')).toBeNull();
    });
});
