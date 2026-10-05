import { describe, it, expect, vi, afterEach } from 'vitest';
import { workletModuleUrl, forgetWorkletModuleUrl } from './workletModuleUrl';

/**
 * The 4.8 MB RNNoise worklet source must be wrapped in a Blob ONCE per
 * session, not once per AudioContext (twice per call join).
 */
describe('workletModuleUrl', () => {
    afterEach(() => { vi.restoreAllMocks(); forgetWorkletModuleUrl('p'); forgetWorkletModuleUrl('q'); });

    it('wraps each processor source once and reuses the URL', () => {
        const create = vi.spyOn(URL, 'createObjectURL');
        const a = workletModuleUrl('p', 'registerProcessor("p", class {})');
        const b = workletModuleUrl('p', 'registerProcessor("p", class {})');
        const c = workletModuleUrl('q', 'registerProcessor("q", class {})');
        expect(a).toBe(b);
        expect(c).not.toBe(a);
        expect(create).toHaveBeenCalledTimes(2);
    });

    it('forgetting revokes it, and the next call rebuilds', () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL');
        const a = workletModuleUrl('p', 'x');
        forgetWorkletModuleUrl('p');
        expect(revoke).toHaveBeenCalledWith(a);
        expect(workletModuleUrl('p', 'x')).not.toBe(a);
    });
});
