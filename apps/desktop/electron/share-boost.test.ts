import { describe, it, expect } from 'vitest';
import {
    launchThrottleSwitches, validateShareActive, applyGamingSetting, ShareBoostController, SHARE_BOOST_DISABLED_FEATURES_WIN,
    type PowerBlockerApi,
} from './share-boost';
import {
    CallPriorityBooster, PRIORITY_NORMAL, PRIORITY_ABOVE_NORMAL, PRIORITY_HIGH, GAMING_VIDEO_SWITCHES,
    type PriorityBoosterDeps,
} from './gaming-video-mode';

describe('launchThrottleSwitches (driven by the ONE setting)', () => {
    it('adds nothing when the setting is off', () => {
        expect(launchThrottleSwitches(false, 'win32')).toEqual({ switches: [], disableFeatures: [] });
        expect(launchThrottleSwitches(false, 'linux')).toEqual({ switches: [], disableFeatures: [] });
    });

    it('on, Windows: the three switches, native occlusion AND EcoQoS disabled', () => {
        const r = launchThrottleSwitches(true, 'win32');
        expect(r.switches).toEqual([...GAMING_VIDEO_SWITCHES]);
        expect(r.switches).toEqual([
            'disable-renderer-backgrounding',
            'disable-backgrounding-occluded-windows',
            'disable-background-timer-throttling',
        ]);
        expect(r.disableFeatures).toEqual(['CalculateNativeWinOcclusion', 'UseEcoQoSForBackgroundProcess']);
    });

    it('on, other platforms: the switches only (both features are Windows-only)', () => {
        for (const platform of ['linux', 'darwin']) {
            const r = launchThrottleSwitches(true, platform);
            expect(r.switches).toHaveLength(3);
            expect(r.disableFeatures).toEqual([]);
        }
    });

    it('its disable-features merge into an existing list instead of replacing it', () => {
        // Mirrors main.ts: media.disableFeatures.push(...throttle.disableFeatures); then ONE appendSwitch.
        const media = { disableFeatures: ['DirectXCapturer', 'SomethingElse'] };
        media.disableFeatures.push(...launchThrottleSwitches(true, 'win32').disableFeatures);
        expect(media.disableFeatures.join(',')).toBe(
            'DirectXCapturer,SomethingElse,CalculateNativeWinOcclusion,UseEcoQoSForBackgroundProcess');
        expect([...SHARE_BOOST_DISABLED_FEATURES_WIN]).toEqual(['UseEcoQoSForBackgroundProcess']);
    });
});

describe('validateShareActive', () => {
    it('accepts a real boolean', () => {
        expect(validateShareActive(true)).toBe(true);
        expect(validateShareActive(false)).toBe(false);
    });
    it.each([[1], [0], ['true'], [null], [undefined], [{}], [[]]])('rejects %j (never coerced)', (v) => {
        expect(() => validateShareActive(v)).toThrow();
    });
});

type Proc = { pid: number; type: string };
function fakeOs(procs: Proc[], initial: Record<number, number>, platform = 'win32') {
    const prio = new Map<number, number>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
    const list = [...procs];
    const calls: Array<[number, number]> = [];
    const deps: PriorityBoosterDeps = {
        platform,
        listPids: () => list.map(p => p.pid),
        listProcesses: () => list.map(p => ({ ...p })),
        getPriority: (pid) => {
            const p = prio.get(pid);
            if (p === undefined) throw new Error('ESRCH');
            return p;
        },
        setPriority: (pid, p) => {
            if (!prio.has(pid)) throw new Error('ESRCH');
            calls.push([pid, p]);
            prio.set(pid, p);
        },
    };
    return { deps, prio, calls, list };
}

const PROCS: Proc[] = [
    { pid: 10, type: 'Browser' },
    { pid: 11, type: 'GPU' },
    { pid: 12, type: 'Tab' },
    { pid: 13, type: 'Utility' },
];
const NORMALS = { 10: PRIORITY_NORMAL, 11: PRIORITY_NORMAL, 12: PRIORITY_NORMAL, 13: PRIORITY_NORMAL };

describe('screen-share priority boost (CallPriorityBooster, share mode)', () => {
    it('raises the GPU and main (browser) processes to HIGH and every other process to ABOVE_NORMAL while a share is live', () => {
        const os = fakeOs(PROCS, NORMALS);
        const b = new CallPriorityBooster(os.deps);
        b.setShareEnabled(true);
        expect(os.calls).toEqual([]); // setting alone does nothing
        b.setSharing(true);
        expect(b.shareActive).toBe(true);
        expect(os.prio.get(11)).toBe(PRIORITY_HIGH);
        expect(os.prio.get(10)).toBe(PRIORITY_HIGH);
        expect(os.prio.get(12)).toBe(PRIORITY_ABOVE_NORMAL);
        expect(os.prio.get(13)).toBe(PRIORITY_ABOVE_NORMAL);
    });

    it('the main (browser) process is HIGH only for a share - a call alone keeps it at ABOVE_NORMAL (negative control)', () => {
        const os = fakeOs(PROCS, NORMALS);
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        b.setInCall(true);
        expect(os.prio.get(10)).toBe(PRIORITY_ABOVE_NORMAL);
        b.setShareEnabled(true);
        b.setSharing(true);
        expect(os.prio.get(10)).toBe(PRIORITY_HIGH);
        b.setSharing(false);
        expect(os.prio.get(10)).toBe(PRIORITY_ABOVE_NORMAL);   // the call boost stays
        b.setInCall(false);
        expect(os.prio.get(10)).toBe(PRIORITY_NORMAL);
    });

    it('restores every process to its OWN previous priority when the share stops', () => {
        const os = fakeOs(PROCS, { ...NORMALS, 12: 10 /* BELOW_NORMAL */ });
        const b = new CallPriorityBooster(os.deps);
        b.setShareEnabled(true);
        b.setSharing(true);
        b.setSharing(false);
        expect(os.prio.get(10)).toBe(PRIORITY_NORMAL);
        expect(os.prio.get(11)).toBe(PRIORITY_NORMAL);
        expect(os.prio.get(12)).toBe(10);
        expect(os.prio.get(13)).toBe(PRIORITY_NORMAL);
        expect(b.raisedPids()).toEqual([]);
    });

    it('restores when the setting is turned off mid-share', () => {
        const os = fakeOs(PROCS, NORMALS);
        const b = new CallPriorityBooster(os.deps);
        b.setSharing(true);
        b.setShareEnabled(true);
        expect(os.prio.get(11)).toBe(PRIORITY_HIGH);
        b.setShareEnabled(false);
        for (const pid of [10, 11, 12, 13]) expect(os.prio.get(pid)).toBe(PRIORITY_NORMAL);
    });

    it('with the call-video mode also on, the share ending lowers the GPU to ABOVE_NORMAL (not back to NORMAL) until the call ends', () => {
        const os = fakeOs(PROCS, NORMALS);
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        b.setInCall(true);
        expect(os.prio.get(11)).toBe(PRIORITY_ABOVE_NORMAL);
        b.setShareEnabled(true);
        b.setSharing(true);
        expect(os.prio.get(11)).toBe(PRIORITY_HIGH);
        b.setSharing(false);
        expect(os.prio.get(11)).toBe(PRIORITY_ABOVE_NORMAL);
        b.setInCall(false);
        expect(os.prio.get(11)).toBe(PRIORITY_NORMAL);
    });

    it('never lowers a process that is already higher than its target', () => {
        const os = fakeOs(PROCS, { ...NORMALS, 11: -15, 10: PRIORITY_HIGH });
        const b = new CallPriorityBooster(os.deps);
        b.setShareEnabled(true);
        b.setSharing(true);
        expect(os.prio.get(11)).toBe(-15);
        expect(os.prio.get(10)).toBe(PRIORITY_HIGH);
        b.setSharing(false);
        expect(os.prio.get(11)).toBe(-15);
    });

    it('does not "restore" over a priority something else has set since', () => {
        const os = fakeOs(PROCS, NORMALS);
        const b = new CallPriorityBooster(os.deps);
        b.setShareEnabled(true);
        b.setSharing(true);
        os.prio.set(12, 19); // Chromium backgrounded the renderer
        b.setSharing(false);
        expect(os.prio.get(12)).toBe(19);
        expect(os.prio.get(11)).toBe(PRIORITY_NORMAL);
    });

    it('a restarted GPU process is picked up by tick() at HIGH', () => {
        const os = fakeOs(PROCS, NORMALS);
        const b = new CallPriorityBooster(os.deps);
        b.setShareEnabled(true);
        b.setSharing(true);
        os.list.splice(1, 1, { pid: 21, type: 'GPU' }); // GPU died, new one started
        os.prio.set(21, PRIORITY_NORMAL);
        b.tick();
        expect(os.prio.get(21)).toBe(PRIORITY_HIGH);
    });

    it.each(['linux', 'darwin'])('is a no-op on %s (raising priority needs privilege there)', (platform) => {
        const os = fakeOs(PROCS, NORMALS, platform);
        const b = new CallPriorityBooster(os.deps);
        b.setShareEnabled(true);
        b.setSharing(true);
        b.tick();
        expect(b.active).toBe(false);
        expect(os.calls).toEqual([]);
    });

    it('survives a failing process list', () => {
        const os = fakeOs(PROCS, NORMALS);
        const b = new CallPriorityBooster({ ...os.deps, listProcesses: () => { throw new Error('before ready'); } });
        b.setShareEnabled(true);
        expect(() => b.setSharing(true)).not.toThrow();
        expect(os.calls).toEqual([]);
    });
});

function fakePower() {
    let next = 100;
    const held = new Set<number>();
    const log: string[] = [];
    const api: PowerBlockerApi & { failStart?: boolean } = {
        start(type) {
            log.push(`start:${type}`);
            if (api.failStart) throw new Error('nope');
            const id = next++;
            held.add(id);
            return id;
        },
        stop(id) { log.push(`stop:${id}`); held.delete(id); },
        isStarted: (id) => held.has(id),
    };
    return { api, held, log };
}

describe('ShareBoostController', () => {
    it('holds a prevent-app-suspension request exactly while (setting on) AND (share live)', () => {
        const os = fakeOs(PROCS, NORMALS);
        const power = fakePower();
        const c = new ShareBoostController(new CallPriorityBooster(os.deps), power.api);
        c.setEnabled(true);
        expect(power.held.size).toBe(0);
        c.setSharing(true);
        expect(c.blockerHeld).toBe(true);
        expect(power.log).toEqual(['start:prevent-app-suspension']);
        expect(os.prio.get(11)).toBe(PRIORITY_HIGH);
        c.setSharing(false);
        expect(c.blockerHeld).toBe(false);
        expect(power.held.size).toBe(0);
        expect(os.prio.get(11)).toBe(PRIORITY_NORMAL);
    });

    it('releases everything when the setting goes off mid-share, and takes it again when it comes back', () => {
        const os = fakeOs(PROCS, NORMALS);
        const power = fakePower();
        const c = new ShareBoostController(new CallPriorityBooster(os.deps), power.api);
        c.setEnabled(true);
        c.setSharing(true);
        c.setEnabled(false);
        expect(power.held.size).toBe(0);
        expect(os.prio.get(11)).toBe(PRIORITY_NORMAL);
        c.setEnabled(true);
        expect(power.held.size).toBe(1);
        expect(os.prio.get(11)).toBe(PRIORITY_HIGH);
    });

    it('setting off: a share never takes a power request or a priority', () => {
        const os = fakeOs(PROCS, NORMALS);
        const power = fakePower();
        const c = new ShareBoostController(new CallPriorityBooster(os.deps), power.api);
        c.setEnabled(false);
        c.setSharing(true);
        expect(power.log).toEqual([]);
        expect(os.calls).toEqual([]);
    });

    it('one request across repeated "sharing" pushes; a lost request is taken again', () => {
        const os = fakeOs(PROCS, NORMALS);
        const power = fakePower();
        const c = new ShareBoostController(new CallPriorityBooster(os.deps), power.api);
        c.setEnabled(true);
        c.setSharing(true);
        c.setSharing(true);
        expect(power.log.filter(l => l.startsWith('start'))).toHaveLength(1);
        power.held.clear(); // the OS dropped it
        c.setSharing(true);
        expect(power.held.size).toBe(1);
    });

    it('a power API that throws never takes the boost down', () => {
        const os = fakeOs(PROCS, NORMALS);
        const power = fakePower();
        power.api.failStart = true;
        const c = new ShareBoostController(new CallPriorityBooster(os.deps), power.api);
        c.setEnabled(true);
        expect(() => c.setSharing(true)).not.toThrow();
        expect(c.blockerHeld).toBe(false);
        expect(os.prio.get(11)).toBe(PRIORITY_HIGH); // priority still applied
    });

    it('power request works off Windows too (priority does not)', () => {
        const os = fakeOs(PROCS, NORMALS, 'linux');
        const power = fakePower();
        const c = new ShareBoostController(new CallPriorityBooster(os.deps), power.api);
        c.setEnabled(true);
        c.setSharing(true);
        expect(power.held.size).toBe(1);
        expect(os.calls).toEqual([]);
        c.setSharing(false);
        expect(power.held.size).toBe(0);
    });
});

describe('ONE setting drives the call path AND the share path (applyGamingSetting)', () => {
    function rig() {
        const os = fakeOs(PROCS, NORMALS);
        const power = fakePower();
        const booster = new CallPriorityBooster(os.deps);
        const share = new ShareBoostController(booster, power.api);
        return { os, power, booster, share, set: (on: boolean) => applyGamingSetting(on, booster, share) };
    }

    it('ON: a call alone raises everything to ABOVE_NORMAL (the old behaviour), with no power request', () => {
        const r = rig();
        r.set(true);
        r.booster.setInCall(true);
        for (const pid of [10, 11, 12, 13]) expect(r.os.prio.get(pid)).toBe(PRIORITY_ABOVE_NORMAL);
        expect(r.power.held.size).toBe(0);
    });

    it('ON: a share (in a call) additionally takes the GPU and main process to HIGH and a power request', () => {
        const r = rig();
        r.set(true);
        r.booster.setInCall(true);
        r.share.setSharing(true);
        expect(r.os.prio.get(11)).toBe(PRIORITY_HIGH);
        expect(r.os.prio.get(10)).toBe(PRIORITY_HIGH);
        expect(r.power.held.size).toBe(1);
    });

    it('ON: a share with the call signal missing still boosts (the share path does not depend on the call path)', () => {
        const r = rig();
        r.set(true);
        r.share.setSharing(true);
        expect(r.os.prio.get(11)).toBe(PRIORITY_HIGH);
        expect(r.power.held.size).toBe(1);
    });

    it('OFF: neither path does anything - call or share', () => {
        const r = rig();
        r.set(false);
        r.booster.setInCall(true);
        r.share.setSharing(true);
        expect(r.os.calls).toEqual([]);
        expect(r.power.log).toEqual([]);
    });

    it('turning it OFF mid-call-and-share releases BOTH at once; back ON takes both again', () => {
        const r = rig();
        r.set(true);
        r.booster.setInCall(true);
        r.share.setSharing(true);
        r.set(false);
        for (const pid of [10, 11, 12, 13]) expect(r.os.prio.get(pid)).toBe(PRIORITY_NORMAL);
        expect(r.power.held.size).toBe(0);
        r.set(true);
        expect(r.os.prio.get(11)).toBe(PRIORITY_HIGH);
        expect(r.power.held.size).toBe(1);
    });

    it('the share ending keeps the call boost; the call ending releases the rest', () => {
        const r = rig();
        r.set(true);
        r.booster.setInCall(true);
        r.share.setSharing(true);
        r.share.setSharing(false);
        expect(r.os.prio.get(11)).toBe(PRIORITY_ABOVE_NORMAL);
        expect(r.power.held.size).toBe(0);
        r.booster.setInCall(false);
        expect(r.os.prio.get(11)).toBe(PRIORITY_NORMAL);
    });
});
