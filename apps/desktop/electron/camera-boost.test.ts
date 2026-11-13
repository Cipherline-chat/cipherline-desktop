import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ShareBoostController, PowerThrottleOptOut, GpuSchedulingBoost, validateCameraActive,
    GPU_SCHED_REALTIME, GPU_SCHED_NORMAL,
    type PowerNativeApi, type GpuSchedNativeApi, type PowerBlockerApi,
} from './share-boost';
import { CallPriorityBooster, type PriorityBoosterDeps } from './gaming-video-mode';

/**
 * "while playing game my camera freezes" - the owner confirmed it also happens with
 * NO screen share running, so the webcam's Video Capture process must be protected
 * whenever our camera is published, not only during a share.
 */

const MAIN = 10;
const GPU = 11;
const TAB = 12;
const NET = 13;
const CAP = 14;
const PROCS = [
    { pid: MAIN, type: 'Browser' },
    { pid: GPU, type: 'GPU' },
    { pid: TAB, type: 'Tab' },
    { pid: NET, type: 'Utility', name: 'Network Service' },
    { pid: CAP, type: 'Utility', name: 'Video Capture', serviceName: 'video_capture.mojom.VideoCaptureService' },
];

function rig() {
    const throttleCalls: Array<[number, boolean]> = [];
    const timerCalls: boolean[] = [];
    const gpuSets: Array<[number, number]> = [];
    const levels = new Map<number, number>();
    const powerApi: PowerNativeApi = {
        setProcessPowerThrottling: (pid: number, enabled: boolean) => {
            throttleCalls.push([pid, enabled]);
            return { ok: true, error: 0, mask: enabled ? 0 : 5 };
        },
        setTimerResolution: (_ms: number, on: boolean) => { timerCalls.push(on); return true; },
    };
    const gpuApi: GpuSchedNativeApi = {
        setGpuSchedulingPriority: (pid: number, level: number) => { gpuSets.push([pid, level]); levels.set(pid, level); return { ok: true, status: 0, error: 0 }; },
        getGpuSchedulingPriority: (pid: number) => ({ ok: true, status: 0, error: 0, level: levels.get(pid) ?? GPU_SCHED_NORMAL }),
    };
    const list = () => PROCS.map(p => ({ ...p }));
    const prio = new Map<number, number>(PROCS.map(p => [p.pid, 0]));
    const deps: PriorityBoosterDeps = {
        platform: 'win32', listPids: () => PROCS.map(p => p.pid), listProcesses: list,
        getPriority: pid => prio.get(pid) ?? 0, setPriority: (pid, v) => { prio.set(pid, v); },
    };
    let blockers = 0;
    const power: PowerBlockerApi = { start: () => { blockers++; return 1; }, stop: () => { blockers--; }, isStarted: () => true };
    const throttle = new PowerThrottleOptOut({ platform: 'win32', native: () => powerApi, listProcesses: list, selfPid: MAIN });
    const gpu = new GpuSchedulingBoost({ platform: 'win32', native: () => gpuApi, listProcesses: list, selfPid: MAIN });
    const ctl = new ShareBoostController(new CallPriorityBooster(deps), power, throttle, gpu);
    ctl.setEnabled(true);
    return {
        ctl, throttle, gpu, throttleCalls, timerCalls, gpuSets, levels,
        blockers: () => blockers,
        optOuts: () => throttleCalls.filter(([, e]) => !e).map(([p]) => p),
        gives: () => throttleCalls.filter(([, e]) => e).map(([p]) => p),
        clear: () => { throttleCalls.length = 0; timerCalls.length = 0; gpuSets.length = 0; },
    };
}

describe('camera alone (no share) protects the webcam\'s Video Capture process', () => {
    it('camera on: ONLY the Video Capture process is opted out and GPU-raised; no timer, no power request', () => {
        const r = rig();
        r.ctl.setCameraLive(true);
        expect(r.optOuts()).toEqual([CAP]);
        expect(r.throttle.optedOutPids()).toEqual([CAP]);
        expect(r.gpu.heldPids()).toEqual([CAP]);
        expect(r.levels.get(CAP)).toBe(GPU_SCHED_REALTIME);
        expect(r.timerCalls).toEqual([]);          // the 1 ms timer is the SHARE's pacing
        expect(r.blockers()).toBe(0);              // no prevent-app-suspension for a camera
        expect(r.ctl.throttleActive).toBe(true);   // main keeps its re-apply timer running
    });

    it('camera off releases it (and only it)', () => {
        const r = rig();
        r.ctl.setCameraLive(true);
        r.clear();
        r.ctl.setCameraLive(false);
        expect(r.gives()).toEqual([CAP]);
        expect(r.gpuSets).toEqual([[CAP, GPU_SCHED_NORMAL]]);
        expect(r.throttle.optedOutPids()).toEqual([]);
        expect(r.gpu.heldPids()).toEqual([]);
        expect(r.ctl.throttleActive).toBe(false);
    });

    it('does nothing while the gaming setting is off, and turning the setting off releases a live camera', () => {
        const r = rig();
        r.ctl.setEnabled(false);
        r.ctl.setCameraLive(true);
        expect(r.throttleCalls).toEqual([]);
        r.ctl.setEnabled(true);
        expect(r.optOuts()).toEqual([CAP]);
        r.ctl.setEnabled(false);
        expect(r.throttle.optedOutPids()).toEqual([]);
        expect(r.gpu.heldPids()).toEqual([]);
    });

    it('is idempotent: repeating camera-on does not re-apply', () => {
        const r = rig();
        r.ctl.setCameraLive(true);
        r.clear();
        r.ctl.setCameraLive(true);
        r.ctl.tickThrottle();
        expect(r.throttleCalls).toEqual([]);
        expect(r.gpuSets).toEqual([]);
    });
});

describe('camera + share together', () => {
    it('share starting under a live camera adds the share processes and does NOT re-apply the webcam\'s', () => {
        const r = rig();
        r.ctl.setCameraLive(true);
        r.clear();
        r.ctl.setSharing(true);
        expect(r.optOuts().sort()).toEqual([MAIN, GPU, TAB]);   // CAP not touched again
        expect(r.gpuSets.some(([p]) => p === CAP)).toBe(false);
        expect(r.timerCalls).toEqual([true]);
        expect(r.blockers()).toBe(1);
    });

    it('camera + share, then the SHARE stops: the camera keeps the boost, the share\'s extras are released', () => {
        const r = rig();
        r.ctl.setCameraLive(true);
        r.ctl.setSharing(true);
        r.clear();
        r.ctl.setSharing(false);
        // The share's processes and its timer are handed back ...
        expect(r.gives().sort()).toEqual([MAIN, GPU, TAB]);
        expect(r.timerCalls).toEqual([false]);
        expect(r.blockers()).toBe(0);
        // ... the webcam's process is NOT released and stays raised.
        expect(r.gives()).not.toContain(CAP);
        expect(r.throttle.optedOutPids()).toEqual([CAP]);
        expect(r.gpu.heldPids()).toEqual([CAP]);
        expect(r.levels.get(CAP)).toBe(GPU_SCHED_REALTIME);
        expect(r.ctl.throttleActive).toBe(true);
    });

    it('share first, camera joins, camera leaves: the share is untouched; then the share ends: all released once', () => {
        const r = rig();
        r.ctl.setSharing(true);
        r.clear();
        r.ctl.setCameraLive(true);
        r.ctl.setCameraLive(false);
        expect(r.throttleCalls).toEqual([]);       // share scope already covers the webcam's process
        expect(r.gpuSets).toEqual([]);
        r.ctl.setSharing(false);
        expect(r.gives().sort()).toEqual([MAIN, GPU, TAB, CAP]);
        expect(r.throttle.optedOutPids()).toEqual([]);
        expect(r.gpu.heldPids()).toEqual([]);
        expect(r.timerCalls).toEqual([false]);
    });

    it('camera and share both end (call over): everything released exactly once', () => {
        const r = rig();
        r.ctl.setCameraLive(true);
        r.ctl.setSharing(true);
        r.clear();
        r.ctl.setSharing(false);
        r.ctl.setCameraLive(false);
        r.ctl.setCameraLive(false);
        expect(r.gives().sort()).toEqual([MAIN, GPU, TAB, CAP]);
        expect(r.throttle.optedOutPids()).toEqual([]);
        expect(r.gpu.heldPids()).toEqual([]);
        expect(r.ctl.throttleActive).toBe(false);
    });
});

describe('validateCameraActive (the renderer -> main trust boundary)', () => {
    it('accepts only a real boolean', () => {
        expect(validateCameraActive(true)).toBe(true);
        expect(validateCameraActive(false)).toBe(false);
        for (const v of [1, 0, 'true', null, undefined, {}, []]) expect(() => validateCameraActive(v)).toThrow();
    });
});

describe('wiring: renderer -> preload -> main', () => {
    const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
    const MAINSRC = read('electron', 'main.ts');
    it('main exposes a guarded camera:set-active that validates before acting, and every reset path clears it', () => {
        expect(MAINSRC).toContain("ipcMain.handle('camera:set-active'");
        expect(MAINSRC).toContain('validateCameraActive(active)');
        expect(MAINSRC.indexOf("ipcMain.handle('camera:set-active'")).toBeGreaterThan(MAINSRC.indexOf('installIpcSenderGuard();'));
        // did-navigate, render-process-gone and quit all drop the camera boost with the share's.
        expect(MAINSRC.match(/syncCallPriority\(\{ inCall: false, sharing: false, cameraLive: false \}\)/g)?.length).toBe(3);
    });
    it('preload bridges one boolean; contextIsolation / sandbox untouched', () => {
        const pre = read('electron', 'preload.ts');
        expect(pre).toContain("setCameraActive: (active: boolean): Promise<void> =>\n        ipcRenderer.invoke('camera:set-active', active),");
        expect(MAINSRC).toMatch(/contextIsolation:\s*true/);
        expect(MAINSRC).toMatch(/sandbox:\s*true/);
    });
    it('ShareBoostGuard pushes camera state (published AND un-muted), on change only, and clears it on unmount', () => {
        const g = read('src', 'components', 'call', 'ShareBoostGuard.tsx');
        expect(g).toContain('localCameraLive(room)');
        expect(g).toContain('if (cam !== lastCam)');
        expect(g).toContain('api.setCameraActive?.(cam)');
        expect(g).toContain('if (lastCam) api.setCameraActive?.(false)');
        expect(g).toContain('RoomEvent.TrackMuted');
    });
});
