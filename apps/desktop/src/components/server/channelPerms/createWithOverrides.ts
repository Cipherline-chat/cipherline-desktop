/**
 * Create a channel / category WITH its permission overrides in one request.
 *
 * The old flow was create, then one PATCH per override
 * (`saveOverrideDiff`). In between, the new channel existed with no
 * restriction and every member had just been told to refresh, so a PRIVATE
 * channel's name was listed to members who must never see it. The API now
 * takes `permission_overrides` on the create body (same item shape as the
 * override PATCH), writes both in one transaction and announces the result
 * only to members who can see it - nothing is ever visible half-restricted.
 *
 * Compatibility: an API that predates the field rejects it as an unknown
 * property (the global ValidationPipe runs `forbidNonWhitelisted`, so it is a
 * 400 "property permission_overrides should not exist"). ONLY that exact
 * refusal falls back to the old two-step, with `overridesSent: false` so the
 * caller still runs `saveOverrideDiff`. Every other failure (403 for a bit the
 * caller lacks, 400 for bad values, network) propagates: the create was
 * refused as a whole, nothing exists, and quietly retrying it WITHOUT the
 * restriction would be the very leak this avoids.
 */

import { diffDraft, roleKey, type DraftMap, type OverrideUpsert } from './overrideDraft';

/** The `permission_overrides` array for a brand-new scope: every non-empty
 *  target of the draft (a create has no baseline, so nothing to delete). */
export const overridesForCreate = (draft: DraftMap, everyoneRoleId: string | null): OverrideUpsert[] =>
    diffDraft({}, draft, everyoneRoleId ? roleKey(everyoneRoleId) : undefined).upserts;

/** True when `e` is the API's refusal of an unknown `permission_overrides`
 *  property (an API older than the field), and nothing else. */
export const isUnknownOverridesFieldError = (e: unknown): boolean => {
    const res = (e as { response?: { status?: unknown; data?: { message?: unknown } } })?.response;
    if (res?.status !== 400) return false;
    const m = res.data?.message;
    const texts = Array.isArray(m) ? m : [m];
    return texts.some(t => typeof t === 'string' && /\bpermission_overrides should not exist\b/.test(t));
};

export interface CreateWithOverridesResult<T> {
    data: T;
    /** true = the server applied the overrides with the create; the caller
     *  must NOT write them again. false = none to send, or an older API
     *  (fallback): the caller still runs `saveOverrideDiff` from `{}`. */
    overridesSent: boolean;
}

export async function createWithOverrides<T>(opts: {
    post: (body: Record<string, unknown>) => Promise<{ data: T }>;
    body: Record<string, unknown>;
    draft: DraftMap;
    everyoneRoleId: string | null;
}): Promise<CreateWithOverridesResult<T>> {
    const overrides = overridesForCreate(opts.draft, opts.everyoneRoleId);
    if (overrides.length === 0) {
        return { data: (await opts.post(opts.body)).data, overridesSent: false };
    }
    try {
        const res = await opts.post({ ...opts.body, permission_overrides: overrides });
        return { data: res.data, overridesSent: true };
    } catch (e) {
        if (!isUnknownOverridesFieldError(e)) throw e;
        return { data: (await opts.post(opts.body)).data, overridesSent: false };
    }
}
