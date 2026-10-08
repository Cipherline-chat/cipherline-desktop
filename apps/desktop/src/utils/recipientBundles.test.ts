import { describe, it, expect, vi } from 'vitest';
import { createRecipientBundles, recipientBundleKey, type RecipientDevice } from './recipientBundles';

let n = 0;
/** Each fetch is a distinct claim — like the real endpoint, which spends a new one-time prekey per call. */
const claim = (): RecipientDevice[] => [{ device_id: 'd1', spk_pub_b64: 's', otp_id: ++n }];

describe('recipientBundles', () => {
    it('take() hands out the bundle primed while typing — no request at send time', async () => {
        const b = createRecipientBundles();
        const fetch = vi.fn(async () => claim());
        b.prime('k', fetch);
        const got = await b.take('k', fetch);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(got[0].otp_id).toBeDefined();
    });

    it('is SINGLE USE: two sends never encrypt to the same one-time prekey', async () => {
        const b = createRecipientBundles();
        const fetch = vi.fn(async () => claim());
        b.prime('k', fetch);
        const first = await b.take('k', fetch);
        const second = await b.take('k', fetch);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(second[0].otp_id).not.toBe(first[0].otp_id);
        expect(second).not.toBe(first);
    });

    it('priming again while a fresh bundle is primed or in flight does not claim again', () => {
        const b = createRecipientBundles();
        const fetch = vi.fn(() => new Promise<RecipientDevice[]>(() => {})); // still in flight
        b.prime('k', fetch);
        b.prime('k', fetch);
        b.prime('k', fetch);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('a bundle older than the TTL is not used (roster freshness); a fresh claim is made', async () => {
        let now = 0;
        const b = createRecipientBundles({ ttlMs: 1000, now: () => now });
        const fetch = vi.fn(async () => claim());
        b.prime('k', fetch);
        now = 1000;
        expect(b.has('k')).toBe(false);
        await b.take('k', fetch);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('typing after the TTL primes a new bundle', () => {
        let now = 0;
        const b = createRecipientBundles({ ttlMs: 1000, now: () => now });
        const fetch = vi.fn(async () => claim());
        b.prime('k', fetch);
        now = 1500;
        b.prime('k', fetch);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('a failed prime is invisible: take() fetches its own', async () => {
        const b = createRecipientBundles();
        const bad = vi.fn(async () => { throw new Error('offline'); });
        b.prime('k', bad);
        const good = vi.fn(async () => claim());
        await expect(b.take('k', good)).resolves.toHaveLength(1);
        expect(good).toHaveBeenCalledTimes(1);
    });

    it('a failed prime is forgotten, so the next keystroke primes again', async () => {
        const b = createRecipientBundles();
        b.prime('k', async () => { throw new Error('offline'); });
        await new Promise(r => setTimeout(r, 0));
        expect(b.has('k')).toBe(false);
    });

    it('invalidate() drops primed bundles (one key, or all)', async () => {
        const b = createRecipientBundles();
        const fetch = vi.fn(async () => claim());
        b.prime('a', fetch);
        b.prime('b', fetch);
        b.invalidate('a');
        expect(b.has('a')).toBe(false);
        expect(b.has('b')).toBe(true);
        b.invalidate();
        expect(b.has('b')).toBe(false);
    });

    it('a send with nothing primed still works (one request, as before)', async () => {
        const b = createRecipientBundles();
        const fetch = vi.fn(async () => claim());
        await b.take('k', fetch);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('keys are per account device, so two accounts never share a bundle', () => {
        expect(recipientBundleKey('dev-1', 'conv')).not.toBe(recipientBundleKey('dev-2', 'conv'));
    });
});
