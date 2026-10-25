import { describe, it, expect } from 'vitest';
import { BLOCKED_DEBUG_SWITCHES, stripDebugSwitches, type CommandLineLike } from './debug-switches';

function fakeCommandLine(initial: string[]) {
    const present = new Set(initial);
    const removed: string[] = [];
    const cl: CommandLineLike = {
        hasSwitch: (n) => present.has(n),
        removeSwitch: (n) => { present.delete(n); removed.push(n); },
    };
    return { cl, present, removed };
}

describe('stripDebugSwitches (E-6)', () => {
    it('packaged: removes the Chromium debugging switches and the inspector ones', () => {
        const f = fakeCommandLine(['remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins', 'inspect', 'inspect-brk', 'log-level']);
        const removed = stripDebugSwitches(f.cl, true);
        expect(removed.sort()).toEqual(['inspect', 'inspect-brk', 'remote-allow-origins', 'remote-debugging-pipe', 'remote-debugging-port']);
        // an unrelated switch is untouched
        expect([...f.present]).toEqual(['log-level']);
    });

    it('packaged: nothing to remove is a quiet no-op', () => {
        const f = fakeCommandLine(['log-level']);
        expect(stripDebugSwitches(f.cl, true)).toEqual([]);
        expect(f.removed).toEqual([]);
    });

    it('unpackaged (dev): leaves every switch alone so DevTools attach keeps working', () => {
        const f = fakeCommandLine(['remote-debugging-port', 'inspect']);
        expect(stripDebugSwitches(f.cl, false)).toEqual([]);
        expect(f.removed).toEqual([]);
    });

    it('never throws, even if a switch cannot be removed', () => {
        const cl: CommandLineLike = { hasSwitch: () => true, removeSwitch: () => { throw new Error('nope'); } };
        expect(() => stripDebugSwitches(cl, true)).not.toThrow();
    });

    it('covers the CDP port, the CDP pipe and the Node inspector (never vacuous)', () => {
        for (const n of ['remote-debugging-port', 'remote-debugging-pipe', 'inspect']) expect(BLOCKED_DEBUG_SWITCHES).toContain(n);
    });

    it('does not block switches the CI/Linux launch legitimately needs', () => {
        for (const n of ['no-sandbox', 'user-data-dir', 'ozone-platform-hint', 'log-level']) expect(BLOCKED_DEBUG_SWITCHES).not.toContain(n);
    });
});
