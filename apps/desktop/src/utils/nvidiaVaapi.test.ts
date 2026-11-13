import { describe, it, expect } from 'vitest';
import { parseNvidiaVaapiStatus, parseNvidiaVaapiInstallResult, shouldShowNvidiaVaapiCard, nvidiaVaapiOutcomeText } from './nvidiaVaapi';

const inst = { state: 'install', pkg: 'p', command: 'c', modesetNote: null, canInstall: true } as const;

describe('nvidiaVaapi renderer narrowing', () => {
    it('garbage degrades to nothing to show', () => {
        for (const v of [null, undefined, 3, 'x', {}, { state: 'bogus' }]) expect(parseNvidiaVaapiStatus(v).state).toBe('none');
        expect(parseNvidiaVaapiInstallResult(undefined)).toMatchObject({ outcome: 'failed' });
    });
    it('a valid status survives', () => expect(parseNvidiaVaapiStatus(inst)).toEqual(inst));
    it('the one-time card: shown once, a dismissal sticks, but a post-install restart prompt is not suppressed', () => {
        expect(shouldShowNvidiaVaapiCard(inst, false)).toBe(true);
        expect(shouldShowNvidiaVaapiCard(inst, true)).toBe(false);
        expect(shouldShowNvidiaVaapiCard({ ...inst, state: 'modeset' }, true)).toBe(false);
        expect(shouldShowNvidiaVaapiCard({ ...inst, state: 'restart' }, true)).toBe(true);
        expect(shouldShowNvidiaVaapiCard({ ...inst, state: 'none' }, false)).toBe(false);
    });
    it('copy says restart after install, and points at the command when PackageKit cannot', () => {
        expect(nvidiaVaapiOutcomeText('installed', { ...inst, state: 'restart' })).toContain('Restart Cipherline');
        expect(nvidiaVaapiOutcomeText('not_found', inst)).toContain('command');
        expect(nvidiaVaapiOutcomeText('unavailable', inst)).toContain('command');
    });
});
