import { describe, it, expect } from 'vitest';
import {
    gamingVideoStartupSwitches, validateCallMediaActive, CallPriorityBooster,
    GAMING_VIDEO_SWITCHES, GAMING_VIDEO_DISABLED_FEATURE, PRIORITY_ABOVE_NORMAL, PRIORITY_NORMAL,
    type PriorityBoosterDeps,
} from './gaming-video-mode';
import { buildChromiumMediaSwitches } from './capture-flags';

describe('gamingVideoStartupSwitches', () => {
    it('adds nothing when the mode is off', () => {
        expect(gamingVideoStartupSwitches(false, 'win32')).toEqual({ switches: [], disableFeatures: [] });
        expect(gamingVideoStartupSwitches(false, 'linux')).toEqual({ switches: [], disableFeatures: [] });
    });

    it('on Windows: the backgrounding switches AND the occlusion feature', () => {
        const s = gamingVideoStartupSwitches(true, 'win32');
        expect(s.switches).toEqual([
            'disable-renderer-backgrounding',
            'disable-backgrounding-occluded-windows',
            'disable-background-timer-throttling',
        ]);
        expect(s.disableFeatures).toEqual(['CalculateNativeWinOcclusion']);
    });

    it('elsewhere: the backgrounding switches only (native occlusion tracking is Windows-only)', () => {
        expect(gamingVideoStartupSwitches(true, 'linux')).toEqual({ switches: [...GAMING_VIDEO_SWITCHES], disableFeatures: [] });
        expect(gamingVideoStartupSwitches(true, 'darwin').disableFeatures).toEqual([]);
    });

    it('returns fresh arrays (main pushes into the merged media list)', () => {
        const a = gamingVideoStartupSwitches(true, 'win32');
        a.switches.push('x');
        expect(gamingVideoStartupSwitches(true, 'win32').switches).not.toContain('x');
    });

    it('merges into ONE disable-features list alongside the capture switches', () => {
        // Mirrors main.ts: Chromium keeps only the last --disable-features, so
        // the occlusion feature must ride in the same list as a forced DXGI.
        const media = buildChromiumMediaSwitches('win32', 'dxgi');
        media.disableFeatures.push(...gamingVideoStartupSwitches(true, 'win32').disableFeatures);
        expect(media.disableFeatures).toEqual(['AllowWgcScreenCapturer', GAMING_VIDEO_DISABLED_FEATURE]);
    });
});

describe('validateCallMediaActive (IPC trust boundary)', () => {
    it('accepts real booleans', () => {
        expect(validateCallMediaActive(true)).toBe(true);
        expect(validateCallMediaActive(false)).toBe(false);
    });
    it.each([['a string', 'true'], ['a number', 1], ['null', null], ['undefined', undefined], ['an object', { active: true }]])(
        'rejects %s rather than coercing it', (_l, v) => {
            expect(() => validateCallMediaActive(v)).toThrow();
        });
});

/** A fake OS: pid → priority, with optional per-pid failure modes. */
function fakeOs(initial: Record<number, number>, platform = 'win32') {
    const prio = new Map<number, number>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
    const denied = new Set<number>();
    const calls: Array<[number, number]> = [];
    const deps: PriorityBoosterDeps = {
        platform,
        listPids: () => [...prio.keys()],
        getPriority: (pid) => {
            const p = prio.get(pid);
            if (p === undefined) throw new Error('ESRCH');
            return p;
        },
        setPriority: (pid, p) => {
            if (denied.has(pid)) throw new Error('EPERM');
            if (!prio.has(pid)) throw new Error('ESRCH');
            calls.push([pid, p]);
            prio.set(pid, p);
        },
    };
    return { deps, prio, denied, calls };
}

describe('CallPriorityBooster', () => {
    it('does nothing until BOTH the setting is on and a call is running', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL, 11: PRIORITY_NORMAL });
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        expect(os.calls).toEqual([]);
        b.setEnabled(false);
        b.setInCall(true);
        expect(os.calls).toEqual([]);
        expect(b.active).toBe(false);
        b.setEnabled(true);
        expect(b.active).toBe(true);
        expect(os.prio.get(10)).toBe(PRIORITY_ABOVE_NORMAL);
        expect(os.prio.get(11)).toBe(PRIORITY_ABOVE_NORMAL);
    });

    it('resets every raised process to its OWN previous priority when the call ends', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL, 11: 10 /* BELOW_NORMAL */ });
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        b.setInCall(true);
        expect(os.prio.get(11)).toBe(PRIORITY_ABOVE_NORMAL);
        b.setInCall(false);
        expect(os.prio.get(10)).toBe(PRIORITY_NORMAL);
        expect(os.prio.get(11)).toBe(10);
        expect(b.raisedPids()).toEqual([]);
    });

    it('resets when the setting is turned off mid-call', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL });
        const b = new CallPriorityBooster(os.deps);
        b.setInCall(true);
        b.setEnabled(true);
        expect(os.prio.get(10)).toBe(PRIORITY_ABOVE_NORMAL);
        b.setEnabled(false);
        expect(os.prio.get(10)).toBe(PRIORITY_NORMAL);
    });

    it('never lowers a process that is already at or above the boost', () => {
        const os = fakeOs({ 10: -14 /* HIGH */, 11: PRIORITY_ABOVE_NORMAL });
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        b.setInCall(true);
        b.setInCall(false);
        expect(os.calls).toEqual([]);
        expect(os.prio.get(10)).toBe(-14);
        expect(os.prio.get(11)).toBe(PRIORITY_ABOVE_NORMAL);
    });

    it('does not "restore" over a priority something else has set since', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL });
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        b.setInCall(true);
        os.prio.set(10, 19); // e.g. Chromium backgrounded it
        b.setInCall(false);
        expect(os.prio.get(10)).toBe(19);
    });

    it('tick picks up new processes and re-raises one put back to its original value', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL });
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        b.setInCall(true);
        os.prio.set(12, PRIORITY_NORMAL); // GPU process restarted
        os.prio.set(10, PRIORITY_NORMAL); // Chromium re-asserted NORMAL
        b.tick();
        expect(os.prio.get(10)).toBe(PRIORITY_ABOVE_NORMAL);
        expect(os.prio.get(12)).toBe(PRIORITY_ABOVE_NORMAL);
        // ...but leaves alone one moved somewhere else entirely.
        os.prio.set(12, 19);
        b.tick();
        expect(os.prio.get(12)).toBe(19);
        b.setInCall(false);
        expect(os.prio.get(10)).toBe(PRIORITY_NORMAL);
        expect(os.prio.get(12)).toBe(19);
    });

    it('tick does nothing while inactive', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL });
        const b = new CallPriorityBooster(os.deps);
        b.tick();
        expect(os.calls).toEqual([]);
    });

    it('survives processes that exit or refuse, and forgets exited ones', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL, 11: PRIORITY_NORMAL, 12: PRIORITY_NORMAL });
        os.denied.add(11);
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        expect(() => b.setInCall(true)).not.toThrow();
        expect(b.raisedPids().sort()).toEqual([10, 12]);
        os.prio.delete(12); // exited
        b.tick();
        expect(b.raisedPids()).toEqual([10]);
        expect(() => b.setInCall(false)).not.toThrow();
        expect(os.prio.get(10)).toBe(PRIORITY_NORMAL);
    });

    it('a failing process list is not fatal', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL });
        const b = new CallPriorityBooster({ ...os.deps, listPids: () => { throw new Error('before ready'); } });
        b.setEnabled(true);
        expect(() => b.setInCall(true)).not.toThrow();
        expect(os.calls).toEqual([]);
    });

    it('ignores nonsense pids', () => {
        const os = fakeOs({ 10: PRIORITY_NORMAL });
        const b = new CallPriorityBooster({ ...os.deps, listPids: () => [0, -1, 1.5, 10] });
        b.setEnabled(true);
        b.setInCall(true);
        expect(os.calls).toEqual([[10, PRIORITY_ABOVE_NORMAL]]);
    });

    it.each(['linux', 'darwin'])('is a no-op on %s (raising priority needs privilege there)', (platform) => {
        const os = fakeOs({ 10: PRIORITY_NORMAL }, platform);
        const b = new CallPriorityBooster(os.deps);
        b.setEnabled(true);
        b.setInCall(true);
        b.tick();
        expect(b.active).toBe(false);
        expect(os.calls).toEqual([]);
    });
});
