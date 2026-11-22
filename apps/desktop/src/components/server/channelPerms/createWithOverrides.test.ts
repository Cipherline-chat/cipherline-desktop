import { describe, it, expect, vi } from 'vitest';
import { Permissions as P } from '@cipherline/shared';
import { createWithOverrides, isUnknownOverridesFieldError, overridesForCreate } from './createWithOverrides';
import { memberKey, roleKey, type DraftMap } from './overrideDraft';

const EVERYONE = 'ev-role';
const STAFF = 'staff-role';
const ME = 'me-user';

/** "Private to staff + me": @everyone denied VIEW, staff and I allowed it. */
const privateDraft: DraftMap = {
    [roleKey(STAFF)]: { allow: P.VIEW_CHANNEL, deny: 0n },
    [roleKey(EVERYONE)]: { allow: 0n, deny: P.VIEW_CHANNEL },
    [memberKey(ME)]: { allow: P.VIEW_CHANNEL, deny: 0n },
};

/** What the Nest ValidationPipe (forbidNonWhitelisted) answers for an API that predates the field. */
const unknownFieldError = () => Object.assign(new Error('Request failed with status code 400'), {
    response: { status: 400, data: { statusCode: 400, error: 'Bad Request', message: ['property permission_overrides should not exist'] } },
});
const httpError = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

describe('overridesForCreate', () => {
    it('sends every non-empty target in the PATCH body shape, @everyone first', () => {
        const out = overridesForCreate(privateDraft, EVERYONE);
        expect(out[0]).toEqual({ target_kind: 'role', target_id: EVERYONE, allow_bits: '0', deny_bits: P.VIEW_CHANNEL.toString(10) });
        expect(out).toHaveLength(3);
        expect(out).toContainEqual({ target_kind: 'role', target_id: STAFF, allow_bits: P.VIEW_CHANNEL.toString(10), deny_bits: '0' });
        expect(out).toContainEqual({ target_kind: 'member', target_id: ME, allow_bits: P.VIEW_CHANNEL.toString(10), deny_bits: '0' });
    });

    it('is empty for an empty draft or one made only of neutral rows', () => {
        expect(overridesForCreate({}, EVERYONE)).toEqual([]);
        expect(overridesForCreate({ [roleKey(STAFF)]: { allow: 0n, deny: 0n } }, EVERYONE)).toEqual([]);
    });
});

describe('isUnknownOverridesFieldError', () => {
    it('matches only the API refusing the property (array or string message)', () => {
        expect(isUnknownOverridesFieldError(unknownFieldError())).toBe(true);
        expect(isUnknownOverridesFieldError(httpError(400, { message: 'property permission_overrides should not exist' }))).toBe(true);
    });

    it.each([
        ['a 403 for a bit the caller lacks', httpError(403, { code: 'OVERRIDE_MISSING_PERMISSION', message: 'You can only change permissions you have here yourself' })],
        ['a 400 for bad values', httpError(400, { code: 'OVERRIDE_INVALID_BITS', message: 'allow_bits must be a decimal string' })],
        ['a 400 for a different unknown property', httpError(400, { message: ['property member_limit should not exist'] })],
        ['a 400 for the array cap', httpError(400, { message: ['permission_overrides must contain no more than 50 elements'] })],
        ['a 500', httpError(500, { message: 'Internal server error' })],
        ['a network error', new Error('Network Error')],
        ['undefined', undefined],
    ])('does not match %s', (_n, e) => {
        expect(isUnknownOverridesFieldError(e)).toBe(false);
    });
});

describe('createWithOverrides', () => {
    const body = { name: 'secret', kind: 'text' };

    it('private: ONE create request carrying permission_overrides, and the caller must not PATCH them again', async () => {
        const post = vi.fn(async (_b: Record<string, unknown>) => ({ data: { channel_id: 'new' } }));
        const out = await createWithOverrides({ post, body, draft: privateDraft, everyoneRoleId: EVERYONE });
        expect(post).toHaveBeenCalledTimes(1);
        const sent = post.mock.calls[0][0] as Record<string, unknown>;
        expect(sent).toMatchObject({ name: 'secret', kind: 'text' });
        expect(sent.permission_overrides).toEqual(overridesForCreate(privateDraft, EVERYONE));
        expect(out).toEqual({ data: { channel_id: 'new' }, overridesSent: true });
    });

    it('public (nothing to restrict): the body is exactly what it was before - no permission_overrides key at all', async () => {
        const post = vi.fn(async (_b: Record<string, unknown>) => ({ data: { channel_id: 'new' } }));
        const out = await createWithOverrides({ post, body, draft: {}, everyoneRoleId: EVERYONE });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0]).toEqual(body);
        expect('permission_overrides' in (post.mock.calls[0][0] as object)).toBe(false);
        expect(out.overridesSent).toBe(false);
    });

    it('an API that predates the field: retries ONCE without it and tells the caller to run the old two-step', async () => {
        const post = vi.fn<(b: Record<string, unknown>) => Promise<{ data: unknown }>>()
            .mockRejectedValueOnce(unknownFieldError())
            .mockResolvedValueOnce({ data: { channel_id: 'new' } });
        const out = await createWithOverrides({ post, body, draft: privateDraft, everyoneRoleId: EVERYONE });
        expect(post).toHaveBeenCalledTimes(2);
        expect((post.mock.calls[0][0] as Record<string, unknown>).permission_overrides).toBeDefined();
        expect(post.mock.calls[1][0]).toEqual(body);
        expect(out).toEqual({ data: { channel_id: 'new' }, overridesSent: false });
    });

    it('a refusal is NEVER retried without the restriction (that would create the public channel the user did not ask for)', async () => {
        const forbidden = httpError(403, { code: 'OVERRIDE_MISSING_PERMISSION' });
        const post = vi.fn<(b: Record<string, unknown>) => Promise<{ data: unknown }>>().mockRejectedValue(forbidden);
        await expect(createWithOverrides({ post, body, draft: privateDraft, everyoneRoleId: EVERYONE })).rejects.toBe(forbidden);
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('a network failure on the atomic create propagates too (nothing was created, nothing to repair)', async () => {
        const post = vi.fn<(b: Record<string, unknown>) => Promise<{ data: unknown }>>().mockRejectedValue(new Error('Network Error'));
        await expect(createWithOverrides({ post, body, draft: privateDraft, everyoneRoleId: EVERYONE })).rejects.toThrow('Network Error');
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('a failing plain create (no overrides) propagates untouched', async () => {
        const post = vi.fn<(b: Record<string, unknown>) => Promise<{ data: unknown }>>().mockRejectedValue(httpError(400, { message: ['name is too long'] }));
        await expect(createWithOverrides({ post, body, draft: {}, everyoneRoleId: null })).rejects.toBeDefined();
        expect(post).toHaveBeenCalledTimes(1);
    });
});
