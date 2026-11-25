import { describe, it, expect, vi } from 'vitest';
import { holderLabel, lookupHolderLabel, ownTransferCapable, pickRows, requestOwnTransfer, splitHolderLabel } from './nearOwnTransfer';

describe('requestOwnTransfer', () => {
    it('asks the chosen device, naming this one (the host never guesses it)', async () => {
        const nearTransferRequest = vi.fn(async () => ({}));
        await requestOwnTransfer({ nearTransferRequest }, { deviceId: 'dev-H' }, 'dev-N');
        expect(nearTransferRequest).toHaveBeenCalledWith({ deviceId: 'dev-H', ownDeviceId: 'dev-N' });
        expect(ownTransferCapable({ nearTransferRequest })).toBe(true);
        expect(ownTransferCapable({})).toBe(false);
    });
    it('refuses without a bridge member, without this device id, or when the target is this device', async () => {
        const nearTransferRequest = vi.fn(async () => ({}));
        await expect(requestOwnTransfer({}, { deviceId: 'dev-H' }, 'dev-N')).rejects.toThrow(/not available/);
        await expect(requestOwnTransfer({ nearTransferRequest }, { deviceId: 'dev-H' }, null)).rejects.toThrow(/not registered/);
        await expect(requestOwnTransfer({ nearTransferRequest }, { deviceId: 'dev-N' }, 'dev-N')).rejects.toThrow(/another device/);
        expect(nearTransferRequest).not.toHaveBeenCalled();
    });
    it('passes the host\'s refusal on', async () => {
        await expect(requestOwnTransfer({ nearTransferRequest: async () => { throw new Error('a near session is already running'); } }, { deviceId: 'dev-H' }, 'dev-N')).rejects.toThrow(/already running/);
    });
});

describe('H2: the holder sheet names the asking device, sanitised', () => {
    const evil = 'Dawn\u202ePC\u200b\u0000 \u2066' + 'x'.repeat(100);
    it('shows name, platform and the registered date, with bidi / control / zero-width stripped and the length capped', () => {
        const l = holderLabel({ device_name: evil, platform: 'windows', created_at: '2026-11-12T10:00:00Z' })!;
        expect(l.length).toBeLessThanOrEqual(64);
        expect(l).not.toMatch(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
        expect(l.startsWith('DawnPC ')).toBe(true);
        expect(l).toContain('Windows PC');
        expect(l).toMatch(/added Nov 1[12], 2026$/);
    });
    it('falls back to the platform when the name is empty, omits an unreadable date, and says nothing for an unknown device', () => {
        expect(holderLabel({ device_name: '\u202e', platform: 'ios', created_at: 'garbage' })).toBe('iPhone \u00b7 iPhone');
        expect(holderLabel(undefined)).toBeUndefined();
    });
    it('looks the device up by id in the device list and never throws', async () => {
        const list = [{ device_id: 'a', device_name: 'Old', platform: 'linux', created_at: '2026-01-02T00:00:00Z' }, { device_id: 'b', device_name: 'Pixel', platform: 'android', created_at: '2026-03-04T00:00:00Z' }];
        expect(await lookupHolderLabel(async () => list, 'b')).toMatch(/^Pixel \u00b7 Android phone \u00b7 added Mar [34], 2026$/);
        expect(await lookupHolderLabel(async () => list, 'zzz')).toBeUndefined();
        expect(await lookupHolderLabel(async () => { throw new Error('net'); }, 'a')).toBeUndefined();
        expect(await lookupHolderLabel(async () => ({ not: 'a list' }), 'a')).toBeUndefined();
    });
    it('B9: splitHolderLabel keeps the name apart from the detail and invents nothing', () => {
        expect(splitHolderLabel('Pixel · Android phone · added Mar 4, 2026')).toEqual({ name: 'Pixel', detail: 'Android phone · added Mar 4, 2026' });
        expect(splitHolderLabel('Desk PC')).toEqual({ name: 'Desk PC', detail: '' });
        expect(splitHolderLabel(undefined)).toEqual({ name: 'your other device', detail: '' });
        expect(splitHolderLabel('')).toEqual({ name: 'your other device', detail: '' });
    });
    it('B3: a phone is pickable although the API says it is not connected; a disconnected desktop stays greyed', () => {
        const d = (id: string, platform: string, connected: boolean, seen = '2026-11-01') => ({ device_id: id, device_name: id, platform, connected, attentive: false, last_active_at: null, last_seen_at: seen });
        const rows = pickRows([d('desk-off', 'linux', false, '2026-11-20'), d('phone-ios', 'ios', false), d('phone-and', 'android', false, '2026-11-10'), d('desk-on', 'windows', true), d('me', 'linux', true)], 'me');
        const by = Object.fromEntries(rows.map(r => [r.deviceId, r]));
        expect(by['phone-ios']).toMatchObject({ phone: true, online: false, selectable: true });
        expect(by['phone-and']).toMatchObject({ phone: true, online: false, selectable: true });
        expect(by['desk-off']).toMatchObject({ phone: false, online: false, selectable: false });
        expect(by['desk-on']).toMatchObject({ phone: false, online: true, selectable: true });
        expect(by['me']).toBeUndefined();
        // pickable rows first (connected before not connected, most recently active first), the greyed desktop last
        expect(rows.map(r => r.deviceId)).toEqual(['desk-on', 'phone-and', 'phone-ios', 'desk-off']);
    });
    it('L8: the picker sanitises device names too', () => {
        const rows = pickRows([{ device_id: 'x', device_name: evil, platform: 'android', connected: true, attentive: true, last_active_at: null, last_seen_at: '2026-11-01' }], 'me');
        expect(rows[0].name).not.toMatch(/[\u200b\u202e\u2066\u0000]/);
        expect(rows[0].name.length).toBeLessThanOrEqual(64);
    });
});
