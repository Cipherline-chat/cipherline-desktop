import { describe, it, expect } from 'vitest';
import { selectAddressableDevices } from './encryptAndAddress';

describe('selectAddressableDevices', () => {
    it('splits devices into addressable and skipped by wrapped id set', () => {
        const devices = [
            { device_id: 'a', spk_pub_b64: 'x' },
            { device_id: 'b', spk_pub_b64: 'y' },
            { device_id: 'c', spk_pub_b64: 'z' },
        ];
        const { addressable, skipped } = selectAddressableDevices(devices, ['a', 'c']);
        expect(addressable.map(d => d.device_id)).toEqual(['a', 'c']);
        expect(skipped.map(d => d.device_id)).toEqual(['b']);
    });

    it('everything addressable when all devices were wrapped', () => {
        const devices = [{ device_id: 'a', spk_pub_b64: 'x' }, { device_id: 'b', spk_pub_b64: 'y' }];
        const { addressable, skipped } = selectAddressableDevices(devices, ['a', 'b']);
        expect(addressable).toHaveLength(2);
        expect(skipped).toHaveLength(0);
    });

    it('everything skipped when nothing was wrapped', () => {
        const devices = [{ device_id: 'a', spk_pub_b64: 'x' }];
        const { addressable, skipped } = selectAddressableDevices(devices, []);
        expect(addressable).toHaveLength(0);
        expect(skipped.map(d => d.device_id)).toEqual(['a']);
    });

    it('preserves input order within each bucket', () => {
        const devices = [
            { device_id: 'z', spk_pub_b64: '1' },
            { device_id: 'a', spk_pub_b64: '2' },
            { device_id: 'm', spk_pub_b64: '3' },
        ];
        const { addressable } = selectAddressableDevices(devices, ['a', 'm', 'z']);
        // Order follows `devices` (input), not the wrapped-id list.
        expect(addressable.map(d => d.device_id)).toEqual(['z', 'a', 'm']);
    });

    it('handles an empty device list', () => {
        expect(selectAddressableDevices([], ['a'])).toEqual({ addressable: [], skipped: [] });
    });

    it('a wrapped id absent from the device list is simply ignored', () => {
        const devices = [{ device_id: 'a', spk_pub_b64: 'x' }];
        const { addressable, skipped } = selectAddressableDevices(devices, ['a', 'ghost']);
        expect(addressable.map(d => d.device_id)).toEqual(['a']);
        expect(skipped).toEqual([]);
    });
});
