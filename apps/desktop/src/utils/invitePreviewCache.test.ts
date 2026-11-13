import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVITE_PREVIEW_TTL_MS, clearInvitePreviews, sharedInvitePreview } from './invitePreviewCache';

describe('sharedInvitePreview', () => {
    let at = 0;
    const now = () => at;
    beforeEach(() => { at = 1_000; clearInvitePreviews(); });

    it('a card that remounts within the minute costs no second request', async () => {
        const f = vi.fn(async () => ({ name: 'a' }));
        expect(await sharedInvitePreview('abc', f, false, now)).toEqual({ name: 'a' });
        at += INVITE_PREVIEW_TTL_MS - 1;
        expect(await sharedInvitePreview('abc', f, false, now)).toEqual({ name: 'a' });
        expect(f).toHaveBeenCalledTimes(1);
    });

    it('asks again after the minute, and for a different code', async () => {
        const f = vi.fn(async () => 1);
        await sharedInvitePreview('abc', f, false, now);
        await sharedInvitePreview('xyz', f, false, now);
        expect(f).toHaveBeenCalledTimes(2);
        at += INVITE_PREVIEW_TTL_MS;
        await sharedInvitePreview('abc', f, false, now);
        expect(f).toHaveBeenCalledTimes(3);
    });

    it('two cards for one invite at once share one request', async () => {
        let release: (v: number) => void = () => {};
        const f = vi.fn(() => new Promise<number>(r => { release = r; }));
        const a = sharedInvitePreview('abc', f, false, now);
        const b = sharedInvitePreview('abc', f, false, now);
        release(7);
        expect(await Promise.all([a, b])).toEqual([7, 7]);
        expect(f).toHaveBeenCalledTimes(1);
    });

    it('a failure is never remembered: 429, 404, network', async () => {
        const f = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce(5);
        await expect(sharedInvitePreview('abc', f, false, now)).rejects.toThrow('429');
        expect(await sharedInvitePreview('abc', f, false, now)).toBe(5);
    });

    it('a manual retry goes to the server', async () => {
        const f = vi.fn(async () => 1);
        await sharedInvitePreview('abc', f, false, now);
        await sharedInvitePreview('abc', f, true, now);
        expect(f).toHaveBeenCalledTimes(2);
    });
});
