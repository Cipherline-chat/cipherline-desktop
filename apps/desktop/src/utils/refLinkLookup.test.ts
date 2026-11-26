import { describe, it, expect, vi } from 'vitest';
import { decideRefLinkOutcome, resolveRefLink } from './refLinkLookup';

const ok = (over = {}) => ({ status: 200, data: { user_id: 'u1', username: 'sam', discriminator: 12, is_self: false, ...over } });

describe('decideRefLinkOutcome', () => {
    it('200 other person -> open their profile', () => {
        expect(decideRefLinkOutcome(ok())).toEqual({ kind: 'open_profile', userId: 'u1' });
    });
    it('200 is_self -> self', () => {
        expect(decideRefLinkOutcome(ok({ is_self: true }))).toEqual({ kind: 'self' });
    });
    it('404 -> not_found', () => {
        expect(decideRefLinkOutcome({ status: 404 })).toEqual({ kind: 'not_found' });
    });
    it('network error, 5xx, 429 and malformed 200 bodies -> error', () => {
        expect(decideRefLinkOutcome({ networkError: true })).toEqual({ kind: 'error' });
        expect(decideRefLinkOutcome({ status: 500 })).toEqual({ kind: 'error' });
        expect(decideRefLinkOutcome({ status: 429 })).toEqual({ kind: 'error' });
        expect(decideRefLinkOutcome({ status: 200, data: {} })).toEqual({ kind: 'error' });
        expect(decideRefLinkOutcome({ status: 200, data: null })).toEqual({ kind: 'error' });
    });
});

describe('resolveRefLink', () => {
    it('upper-cases the code before the request', async () => {
        const f = vi.fn(async () => ok());
        await expect(resolveRefLink('abcdef12', f)).resolves.toEqual({ kind: 'open_profile', userId: 'u1' });
        expect(f).toHaveBeenCalledWith('ABCDEF12');
    });
    it('malformed code -> not_found without a request', async () => {
        const f = vi.fn(async () => ok());
        await expect(resolveRefLink('nope', f)).resolves.toEqual({ kind: 'not_found' });
        await expect(resolveRefLink(null, f)).resolves.toEqual({ kind: 'not_found' });
        expect(f).not.toHaveBeenCalled();
    });
    it('a thrown fetcher -> error', async () => {
        await expect(resolveRefLink('ABCDEF12', async () => { throw new Error('offline'); })).resolves.toEqual({ kind: 'error' });
    });
});
