import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const get = vi.fn();
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }));
vi.mock('../constants', () => ({ API_BASE: 'http://api.test/v1' }));

import {
    dueStaleDevices, fetchOwnDevices, formatLastActive, keepStaleDevices, removeOwnDevice, staleBadgeLabel, staleTierOf,
    type OwnDevice,
} from './staleDevices';

const ME = 'me-device';
const dev = (id: string, over: Partial<OwnDevice> = {}): OwnDevice => ({
    device_id: id, device_name: `PC-${id}`, platform: 'windows', last_active_on: '2026-08-03',
    stale_tier: '30d', stale_prompt_due: true, ...over,
});

beforeEach(() => { post.mockReset(); get.mockReset(); post.mockResolvedValue({ data: { ok: true } }); });

describe('dueStaleDevices — what the prompt lists', () => {
    it('lists only devices the server marks due, never this device', () => {
        const out = dueStaleDevices([
            dev(ME),                                         // this device: never
            dev('a'),                                        // due
            dev('b', { stale_prompt_due: false }),           // already answered
            dev('c', { stale_tier: 'none', stale_prompt_due: true }), // inconsistent → ignored
        ], ME);
        expect(out.map(d => d.device_id)).toEqual(['a']);
    });

    it('an older server (no stale_* fields) never prompts', () => {
        const legacy = { device_id: 'x', device_name: 'Old', platform: 'linux' } as OwnDevice;
        expect(dueStaleDevices([legacy], ME)).toEqual([]);
        expect(staleTierOf(legacy)).toBe('none');
    });

    it('6-month devices first, then oldest last-active, then name (stable order)', () => {
        const out = dueStaleDevices([
            dev('n', { last_active_on: '2026-09-01' }),
            dev('o', { stale_tier: '180d', last_active_on: '2026-03-01' }),
            dev('m', { last_active_on: '2026-08-01' }),
        ], ME);
        expect(out.map(d => d.device_id)).toEqual(['o', 'm', 'n']);
    });

    it('rejects unknown tier strings', () => {
        expect(staleTierOf({ stale_tier: 'forever' as never })).toBe('none');
    });
});

describe('labels', () => {
    it('badge copy per tier', () => {
        expect(staleBadgeLabel('none')).toBeNull();
        expect(staleBadgeLabel('30d')).toBe('Not used in 30+ days');
        expect(staleBadgeLabel('180d')).toBe('Not used in 6+ months');
    });
    it('last-active is a calendar day, never shifted by the local time zone', () => {
        expect(formatLastActive('2026-08-03')).toMatch(/Aug\D+3\D+2026|3\D+Aug\D+2026/);
        expect(formatLastActive('2026-01-01')).toMatch(/2026/);
        expect(formatLastActive('2026-08-03T10:00:00Z')).toBeNull();
        expect(formatLastActive(undefined)).toBeNull();
    });
});

describe('network calls', () => {
    it('Keep → one batched POST /devices/stale-dismiss at each device\'s CURRENT tier, from this device', async () => {
        await keepStaleDevices('TOKEN', ME, [dev('a'), dev('b', { stale_tier: '180d' }), dev('c', { stale_tier: 'none' })]);
        expect(post).toHaveBeenCalledTimes(1);
        const [url, body, cfg] = post.mock.calls[0];
        expect(url).toBe('http://api.test/v1/devices/stale-dismiss');
        expect(body).toEqual({ dismissals: [{ device_id: 'a', tier: '30d' }, { device_id: 'b', tier: '180d' }] });
        expect(cfg.headers).toEqual({ Authorization: 'Bearer TOKEN', 'x-device-id': ME });
    });

    it('Keep with nothing dismissible makes no request', async () => {
        await keepStaleDevices('TOKEN', ME, [dev('c', { stale_tier: 'none' })]);
        expect(post).not.toHaveBeenCalled();
    });

    it('Remove uses the existing revoke route with the id encoded as one path segment', async () => {
        await removeOwnDevice('TOKEN', ME, 'abc/../x');
        const [url, , cfg] = post.mock.calls[0];
        expect(url).toBe('http://api.test/v1/devices/abc%2F..%2Fx/revoke');
        expect(cfg.headers['x-device-id']).toBe(ME);
    });

    it('fetchOwnDevices tolerates a non-array body', async () => {
        get.mockResolvedValue({ data: { nope: 1 } });
        expect(await fetchOwnDevices('TOKEN')).toEqual([]);
        get.mockResolvedValue({ data: [dev('a')] });
        expect((await fetchOwnDevices('TOKEN')).map(d => d.device_id)).toEqual(['a']);
    });
});
