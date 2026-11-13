import { describe, it, expect, vi } from 'vitest';
import { probeGlobalShortcutsPortal, classifyPortalError, type PortalProbeBus } from './global-shortcut-portal';

function bus(getVersion: () => Promise<unknown>): PortalProbeBus & { closed: number } {
    const b = { closed: 0, getVersion, close() { b.closed++; } };
    return b;
}

describe('probeGlobalShortcutsPortal', () => {
    it('present when the interface answers its version (KDE reports 2)', async () => {
        const b = bus(async () => 2);
        expect(await probeGlobalShortcutsPortal(() => b, 500)).toBe('present');
        expect(b.closed).toBe(1);
    });

    it('absent when the portal says the interface / property does not exist', async () => {
        for (const msg of [
            'org.freedesktop.DBus.Error.UnknownProperty No such interface',
            'org.freedesktop.DBus.Error.UnknownInterface',
            'org.freedesktop.DBus.Error.ServiceUnknown The name is not activatable',
        ]) {
            expect(await probeGlobalShortcutsPortal(() => bus(async () => { throw new Error(msg); }), 500)).toBe('absent');
        }
    });

    it('absent when there is no session bus at all', async () => {
        expect(await probeGlobalShortcutsPortal(() => null, 500)).toBe('absent');
    });

    it('unknown (not absent, not present) when nothing answers in time, and it does not wait for the call', async () => {
        vi.useFakeTimers();
        try {
            const b = bus(() => new Promise(() => { /* never answers */ }));
            const p = probeGlobalShortcutsPortal(() => b, 2500);
            await vi.advanceTimersByTimeAsync(2500);
            expect(await p).toBe('unknown');
            expect(b.closed).toBe(1);
        } finally { vi.useRealTimers(); }
    });

    it('unknown on an unrecognised failure; never throws', async () => {
        expect(await probeGlobalShortcutsPortal(() => bus(async () => { throw new Error('socket exploded'); }), 500)).toBe('unknown');
        expect(await probeGlobalShortcutsPortal(() => { throw new Error('boom'); }, 500)).toBe('unknown');
    });

    it('negative control: classifyPortalError does not call a random error "absent"', () => {
        expect(classifyPortalError('connection reset')).toBe('unknown');
        expect(classifyPortalError('org.freedesktop.DBus.Error.UnknownProperty')).toBe('absent');
    });
});
