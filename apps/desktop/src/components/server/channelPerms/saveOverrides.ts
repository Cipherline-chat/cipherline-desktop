/**
 * Push a draft's changes to the server.
 *
 * There is no batch endpoint, so this is one request per changed target,
 * and the server judges EACH request against the state at that moment:
 * every bit a request changes must be one the caller holds in the channel
 * right then (apps/api/src/servers/override-guard.service.ts). So the order
 * matters for the caller's own access, not just for privacy:
 *
 *   - "Make it private, keep my role in": the @everyone deny would lock the
 *     caller out, and the allow for their role would then be refused. The
 *     allow has to go first.
 *   - "Make it public again": the @everyone deny has to be removed BEFORE the
 *     caller's role allow is, or the second delete is refused.
 *
 * With `resolveMine` (the caller's effective bits for a given override set,
 * from the editor guard) the changes are sent in rounds: everything that does
 * not take any bit away from the caller goes now, in parallel; the rest is
 * re-checked after each round. Only when every remaining change narrows the
 * caller's own access are they sent one at a time, in stable order — that is
 * the caller deliberately locking themselves out, which the dialog has
 * already warned about.
 *
 * Privacy ordering is kept inside each round: when the @everyone upsert is
 * in a round it goes FIRST and alone, so a channel being made private is
 * hidden before the round's other changes land. Without `resolveMine`
 * (owner / admin, or no member row) that is the whole ordering, as before.
 *
 * Never throws — it reports per-target failures so the dialog can keep the
 * unsaved targets dirty and let the user retry just those.
 */

import {
    diffDraft, memberKey, roleKey,
    type DraftMap, type OverrideBits, type OverrideDelete, type OverrideUpsert,
} from './overrideDraft';

export interface OverrideHttp {
    patch: (url: string, body: unknown) => Promise<unknown>;
    delete: (url: string) => Promise<unknown>;
}

export interface SaveResult {
    applied: number;
    failed: { target: OverrideUpsert | OverrideDelete; message: string }[];
}

/** The server's 403/400 codes for override writes, in the dialog's voice. */
const CODE_MESSAGES: Record<string, string> = {
    OVERRIDE_HIERARCHY: 'that role or member is at or above your highest role',
    OVERRIDE_MISSING_PERMISSION: 'you can only change permissions you have here yourself',
    OVERRIDE_INVALID_BITS: 'the permission values were not valid',
};

const errMessage = (e: unknown): string => {
    const data = (e as { response?: { data?: { message?: unknown; code?: unknown } } })?.response?.data;
    const code = typeof data?.code === 'string' ? CODE_MESSAGES[data.code] : undefined;
    if (code) return code;
    const m = data?.message;
    if (typeof m === 'string') return m;
    if (Array.isArray(m) && typeof m[0] === 'string') return m[0];
    return 'Request failed';
};

type Change =
    | { kind: 'upsert'; key: string; target: OverrideUpsert; bits: OverrideBits }
    | { kind: 'delete'; key: string; target: OverrideDelete };

const keyOf = (t: { target_kind: 'role' | 'member'; target_id: string }) =>
    t.target_kind === 'member' ? memberKey(t.target_id) : roleKey(t.target_id);

/** `current` with one change applied — what the server holds after it lands. */
const applyChange = (current: DraftMap, c: Change): DraftMap => {
    const next: Record<string, OverrideBits> = { ...current };
    if (c.kind === 'upsert') next[c.key] = c.bits;
    else delete next[c.key];
    return next;
};

/** `base` is e.g. `${API_BASE}/servers/:sid/channels/:cid/overrides`. */
export async function saveOverrideDiff(opts: {
    http: OverrideHttp;
    base: string;
    baseline: DraftMap;
    draft: DraftMap;
    everyoneRoleId: string | null;
    /** The caller's effective bits in the target for a given override set. */
    resolveMine?: (draft: DraftMap) => bigint;
}): Promise<SaveResult> {
    const { upserts, deletes } = diffDraft(opts.baseline, opts.draft, opts.everyoneRoleId ? roleKey(opts.everyoneRoleId) : undefined);
    const result: SaveResult = { applied: 0, failed: [] };

    const run = async (target: OverrideUpsert | OverrideDelete, fn: () => Promise<unknown>): Promise<boolean> => {
        try { await fn(); result.applied++; return true; }
        catch (e) { result.failed.push({ target, message: errMessage(e) }); return false; }
    };
    const send = (c: Change) => c.kind === 'upsert'
        ? run(c.target, () => opts.http.patch(opts.base, c.target))
        : run(c.target, () => opts.http.delete(`${opts.base}/${c.target.target_kind}/${encodeURIComponent(c.target.target_id)}`));

    const isEveryoneUpsert = (c: Change) =>
        c.kind === 'upsert' && !!opts.everyoneRoleId && c.target.target_kind === 'role' && c.target.target_id === opts.everyoneRoleId;

    const changes: Change[] = [
        ...upserts.map((u): Change => ({
            kind: 'upsert', key: keyOf(u), target: u,
            bits: { allow: BigInt(u.allow_bits), deny: BigInt(u.deny_bits) },
        })),
        ...deletes.map((d): Change => ({ kind: 'delete', key: keyOf(d), target: d })),
    ];

    /** One round: the @everyone upsert first and alone, then the rest in parallel. */
    const sendRound = async (round: Change[], current: DraftMap): Promise<DraftMap> => {
        let next = current;
        const ev = round.find(isEveryoneUpsert);
        if (ev && await send(ev)) next = applyChange(next, ev);
        const rest = round.filter(c => c !== ev);
        const ok = await Promise.all(rest.map(send));
        rest.forEach((c, i) => { if (ok[i]) next = applyChange(next, c); });
        return next;
    };

    if (!opts.resolveMine) {
        await sendRound(changes, opts.baseline);
        return result;
    }

    let current: DraftMap = opts.baseline;
    let pending = changes;
    while (pending.length > 0) {
        const mine = opts.resolveMine(current);
        // A change is safe when it takes nothing away from the caller.
        const safe = pending.filter(c => (mine & ~opts.resolveMine!(applyChange(current, c))) === 0n);
        const round = safe.length > 0 ? safe : [pending[0]];
        current = await sendRound(round, current);
        pending = pending.filter(c => !round.includes(c));
    }
    return result;
}

/** One-line summary of a partial failure. */
export const describeFailures = (r: SaveResult): string | null => {
    if (r.failed.length === 0) return null;
    const first = r.failed[0].message;
    return r.failed.length === 1
        ? `1 permission change wasn’t saved: ${first}`
        : `${r.failed.length} permission changes weren’t saved: ${first}`;
};
