/**
 * The contact side of the ghost-device fix (docs/ghost-device.md §2.4, §7.4).
 * `addUnpinnedPublished` rows mirror the §7.5 table for the mobile port.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { observePublished, publishedDevicesFor, _reset } from './publishedDeviceSets';
import { addUnpinnedPublished, deriveContactTrust } from './contactTrust';

const ME = 'me';
beforeEach(() => _reset());

describe('addUnpinnedPublished (§7.5)', () => {
    const b1 = { deviceId: 'b1', verified: true };
    const b2 = { deviceId: 'b2', verified: true };

    it('published set equal to the pins → unchanged, verified', () => {
        const out = addUnpinnedPublished([b1, b2], ['P1', 'P2'], { b1: 'P1', b2: 'P2' });
        expect(out).toEqual([b1, b2]);
        expect(deriveContactTrust({ devices: out }).level).toBe('verified');
    });

    it('one extra published device → counted unverified, partially_verified 2/3', () => {
        const out = addUnpinnedPublished([b1, b2], ['P1', 'P2'], { b1: 'P1', b2: 'P2', g: 'PG' });
        expect(out).toEqual([b1, b2, { deviceId: 'g', verified: false }]);
        const t = deriveContactTrust({ devices: out });
        expect(t.level).toBe('partially_verified');
        expect([t.verifiedCount, t.deviceCount]).toEqual([2, 3]);
    });

    it('a legacy pub-bucket pin is matched by key', () => {
        const legacy = { deviceId: 'pub:abcd', verified: true };
        expect(addUnpinnedPublished([legacy], ['P1'], { b1: 'P1' })).toEqual([legacy]);
    });

    it('no published set → unchanged', () => {
        expect(addUnpinnedPublished([b1], ['P1'], null)).toEqual([b1]);
    });

    it('a published device can never RAISE trust: it is only ever added unverified', () => {
        const out = addUnpinnedPublished([], [], { x: 'PX' });
        expect(deriveContactTrust({ devices: out }).level).toBe('unverified');
    });
});

describe('observePublished', () => {
    it('identity_keys?user_id=X is complete for X and replaces', () => {
        observePublished([{ device_id: 'a', identity_key_pub_b64: 'PA' }, { device_id: 'b', identity_key_pub_b64: 'PB' }],
            'bob', '/v1/keys/identity_keys?user_id=bob', ME);
        expect(publishedDevicesFor('bob')).toEqual({ a: 'PA', b: 'PB' });
        observePublished([{ device_id: 'a', identity_key_pub_b64: 'PA' }], 'bob', '/v1/keys/identity_keys?user_id=bob', ME);
        expect(publishedDevicesFor('bob')).toEqual({ a: 'PA' });
    });

    it('conversation devices replace per member that appears, and skip me', () => {
        observePublished([
            { user_id: 'bob', device_id: 'a', identity_pub_b64: 'PA' },
            { user_id: 'carol', device_id: 'c', identity_pub_b64: 'PC' },
            { user_id: ME, device_id: 'm', identity_pub_b64: 'PM' },
        ], null, '/v1/conversations/x/devices?claim_otp=1', ME);
        expect(publishedDevicesFor('bob')).toEqual({ a: 'PA' });
        expect(publishedDevicesFor('carol')).toEqual({ c: 'PC' });
        expect(publishedDevicesFor(ME)).toBeNull();
        // A later conversation response without carol leaves carol alone.
        observePublished([{ user_id: 'bob', device_id: 'a2', identity_pub_b64: 'PA2' }], null, '/v1/conversations/y/devices', ME);
        expect(publishedDevicesFor('bob')).toEqual({ a2: 'PA2' });
        expect(publishedDevicesFor('carol')).toEqual({ c: 'PC' });
    });

    it('channel and server-member listings are slices, never used', () => {
        observePublished([{ user_id: 'bob', device_id: 'a', identity_pub_b64: 'PA' }], null, '/v1/servers/s/channels/c/recipient-devices', ME);
        observePublished([{ user_id: 'bob', device_id: 'a', identity_pub_b64: 'PA' }], null, '/v1/servers/s/members/bob/devices', ME);
        expect(publishedDevicesFor('bob')).toBeNull();
    });

    it('an empty full listing does not erase a known set', () => {
        observePublished([{ device_id: 'a', identity_key_pub_b64: 'PA' }], 'bob', '/v1/keys/identity_keys?user_id=bob', ME);
        observePublished([], 'bob', '/v1/keys/identity_keys?user_id=bob', ME);
        expect(publishedDevicesFor('bob')).toEqual({ a: 'PA' });
    });
});
