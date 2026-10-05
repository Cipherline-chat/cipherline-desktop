/**
 * The editable override set behind the channel / category permission editor,
 * as pure data + a reducer, so every bulk action (allow all, paste, presets,
 * undo …) is unit-testable without a DOM.
 *
 * A draft is `targetKey → { allow, deny }` where targetKey is
 * `role:<role_id>` or `member:<user_id>`. Bits are bigint end to end — the
 * shared contract already uses bits up to 29 and JS `|`/`&` on numbers is
 * signed 32-bit.
 *
 * Important property: editing only ever touches the bits the editor SHOWS
 * (the `mask` passed to each action). Bits outside it — e.g. an old override
 * carrying MANAGE_CHANNELS on a text channel, where the editor no longer
 * lists it — are carried through untouched. The previous editor rebuilt the
 * whole allow/deny pair from its visible rows on every save and silently
 * dropped anything else.
 */

export type Tri = 'allow' | 'deny' | 'inherit';

export interface OverrideBits {
    allow: bigint;
    deny: bigint;
}

export type DraftMap = Readonly<Record<string, OverrideBits>>;

export const EMPTY_BITS: OverrideBits = Object.freeze({ allow: 0n, deny: 0n });

export const roleKey = (roleId: string) => `role:${roleId}`;
export const memberKey = (userId: string) => `member:${userId}`;

export const parseKey = (key: string): { target_kind: 'role' | 'member'; target_id: string } => {
    const i = key.indexOf(':');
    const kind = key.slice(0, i);
    return { target_kind: kind === 'member' ? 'member' : 'role', target_id: key.slice(i + 1) };
};

export const isEmptyBits = (b: OverrideBits | undefined): boolean => !b || (b.allow === 0n && b.deny === 0n);

export const sameBits = (a: OverrideBits | undefined, b: OverrideBits | undefined): boolean =>
    (a?.allow ?? 0n) === (b?.allow ?? 0n) && (a?.deny ?? 0n) === (b?.deny ?? 0n);

/** State of one bit. Allow wins if (corruptly) both are set — that is what the
 *  server's deny-then-allow does with such a row. */
export const triOf = (b: OverrideBits | undefined, bit: bigint): Tri => {
    if (!b) return 'inherit';
    if ((b.allow & bit) === bit) return 'allow';
    if ((b.deny & bit) === bit) return 'deny';
    return 'inherit';
};

/** The uniform state of every bit in `mask`, or null when they differ. */
export const triOfMask = (b: OverrideBits | undefined, bits: readonly bigint[]): Tri | null => {
    let seen: Tri | null = null;
    for (const bit of bits) {
        const t = triOf(b, bit);
        if (seen === null) seen = t;
        else if (seen !== t) return null;
    }
    return seen;
};

/** Set every bit in `mask` to `tri`, leaving all other bits alone. */
export const withTri = (b: OverrideBits | undefined, mask: bigint, tri: Tri): OverrideBits => {
    const allow = (b?.allow ?? 0n) & ~mask;
    const deny = (b?.deny ?? 0n) & ~mask;
    if (tri === 'allow') return { allow: allow | mask, deny };
    if (tri === 'deny') return { allow, deny: deny | mask };
    return { allow, deny };
};

/** Replace the `mask` bits of `into` with those of `from`; keep the rest of `into`. */
export const overlayMasked = (into: OverrideBits | undefined, from: OverrideBits | undefined, mask: bigint): OverrideBits => ({
    allow: ((into?.allow ?? 0n) & ~mask) | ((from?.allow ?? 0n) & mask),
    deny: ((into?.deny ?? 0n) & ~mask) | ((from?.deny ?? 0n) & mask),
});

/** Drop empty entries — an empty override and a missing one mean the same thing. */
export const normalizeDraft = (d: DraftMap): DraftMap => {
    const out: Record<string, OverrideBits> = {};
    for (const [k, v] of Object.entries(d)) if (!isEmptyBits(v)) out[k] = { allow: v.allow, deny: v.deny };
    return out;
};

export const draftsEqual = (a: DraftMap, b: DraftMap): boolean => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!sameBits(a[k], b[k])) return false;
    return true;
};

/** Build a draft from the API's override rows. */
export const draftFromRows = (rows: readonly {
    target_kind: string; target_id: string; allow_bits?: string | null; deny_bits?: string | null;
}[]): DraftMap => {
    const parse = (s: string | null | undefined) => { try { return s ? BigInt(s) : 0n; } catch { return 0n; } };
    const out: Record<string, OverrideBits> = {};
    for (const r of rows) {
        const key = r.target_kind === 'member' ? memberKey(r.target_id) : roleKey(r.target_id);
        out[key] = { allow: parse(r.allow_bits), deny: parse(r.deny_bits) };
    }
    return normalizeDraft(out);
};

export interface OverrideUpsert {
    target_kind: 'role' | 'member';
    target_id: string;
    allow_bits: string;
    deny_bits: string;
}

export interface OverrideDelete {
    target_kind: 'role' | 'member';
    target_id: string;
}

/**
 * What to send to turn `baseline` into `draft`: an upsert per changed,
 * non-empty target and a delete per target that became empty.
 *
 * `firstKey` (the @everyone role key) is moved to the FRONT of the upserts —
 * callers apply it before the rest so a freshly created private channel is
 * never visible for longer than the first request takes.
 */
export const diffDraft = (
    baseline: DraftMap,
    draft: DraftMap,
    firstKey?: string,
): { upserts: OverrideUpsert[]; deletes: OverrideDelete[] } => {
    const upserts: OverrideUpsert[] = [];
    const deletes: OverrideDelete[] = [];
    const keys = [...new Set([...Object.keys(baseline), ...Object.keys(draft)])].sort();
    for (const k of keys) {
        const before = baseline[k];
        const after = draft[k];
        if (sameBits(before, after)) continue;
        const target = parseKey(k);
        if (isEmptyBits(after)) {
            if (!isEmptyBits(before)) deletes.push(target);
        } else {
            upserts.push({ ...target, allow_bits: after!.allow.toString(10), deny_bits: after!.deny.toString(10) });
        }
    }
    if (firstKey) {
        const t = parseKey(firstKey);
        const i = upserts.findIndex(u => u.target_kind === t.target_kind && u.target_id === t.target_id);
        if (i > 0) upserts.unshift(...upserts.splice(i, 1));
    }
    return { upserts, deletes };
};

/** Count of targets with any override in `mask` (for badges). */
export const countTargets = (d: DraftMap, mask: bigint): number =>
    Object.values(d).filter(b => ((b.allow | b.deny) & mask) !== 0n).length;

// ── Guard: what the current user is allowed to change ───────────────────────

/**
 * Mirror of the server's rule (apps/api/src/servers/override-guard.service.ts):
 * a bit may be CHANGED — in an allow or a deny, set or cleared — only if the
 * actor holds it in the channel / category being edited, and the comparison
 * is against what the server holds NOW (`baseline`), not the previous draft.
 * A bit the actor lacks that is already on a saved row may stay exactly as
 * it is; touching it is what the server refuses.
 */
export interface EditGuard {
    /** Bits this user may change: their EFFECTIVE permissions in the edited
     *  channel / category, resolved before any of this draft is saved. */
    editable: bigint;
    /** The overrides as saved on the server. */
    baseline: DraftMap;
    /** Targets this user may not edit at all (role / member hierarchy). */
    lockedKeys: ReadonlySet<string>;
}

export const OPEN_GUARD: EditGuard = { editable: ~0n, baseline: {}, lockedKeys: new Set() };

/**
 * Clamp a proposed draft to what the user may do:
 *  - a locked target keeps exactly its `prev` value;
 *  - on every other target, each bit that differs from `baseline` (on either
 *    side) and is not `editable` is put back to its baseline state.
 * Returns how many bits/targets were refused so the UI can say so.
 */
export const applyGuard = (prev: DraftMap, next: DraftMap, guard: EditGuard): { draft: DraftMap; refused: number } => {
    const out: Record<string, OverrideBits> = {};
    let refused = 0;
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const k of keys) {
        const p = prev[k];
        const n = next[k];
        if (guard.lockedKeys.has(k)) {
            if (!sameBits(p, n)) refused++;
            if (p) out[k] = p;
            continue;
        }
        const b = guard.baseline[k];
        const nAllow = n?.allow ?? 0n;
        const nDeny = n?.deny ?? 0n;
        const bAllow = b?.allow ?? 0n;
        const bDeny = b?.deny ?? 0n;
        const blocked = ((nAllow ^ bAllow) | (nDeny ^ bDeny)) & ~guard.editable;
        if (blocked !== 0n) {
            refused += bitCount(blocked);
            out[k] = {
                allow: (nAllow & ~blocked) | (bAllow & blocked),
                deny: (nDeny & ~blocked) | (bDeny & blocked),
            };
        } else if (n) {
            out[k] = n;
        }
    }
    return { draft: normalizeDraft(out), refused };
};

export const bitCount = (b: bigint): number => {
    let n = 0;
    for (let x = b; x > 0n; x >>= 1n) if (x & 1n) n++;
    return n;
};

// ── Reducer with undo ───────────────────────────────────────────────────────

export interface EditorState {
    draft: DraftMap;
    /** Newest last. Each entry is the draft BEFORE the labelled action. */
    history: { draft: DraftMap; label: string }[];
    /** Set when the guard refused part of the last action. */
    notice: string | null;
}

export type EditorAction =
    /** Set `mask` bits on one target (a row, a section, or "allow all"). */
    | { type: 'set'; key: string; mask: bigint; tri: Tri; label: string }
    /** Replace the `mask` bits of one target with `bits` (paste a role). */
    | { type: 'setTarget'; key: string; bits: OverrideBits; mask: bigint; label: string }
    /** Replace the `mask` bits of EVERY target (paste channel, preset, sync). */
    | { type: 'replaceAll'; draft: DraftMap; mask: bigint; label: string }
    | { type: 'undo' }
    /** New baseline (load / after save): clears history. */
    | { type: 'reset'; draft: DraftMap }
    | { type: 'dismissNotice' };

export const HISTORY_LIMIT = 40;

export const initialEditorState = (draft: DraftMap = {}): EditorState => ({
    draft: normalizeDraft(draft), history: [], notice: null,
});

const refusedNotice = (n: number) =>
    n === 1
        ? '1 change was skipped — you can only change permissions you have here, for roles and members below yours.'
        : `${n} changes were skipped — you can only change permissions you have here, for roles and members below yours.`;

export function editorReducer(state: EditorState, action: EditorAction, guard: EditGuard = OPEN_GUARD): EditorState {
    const commit = (proposed: DraftMap, label: string): EditorState => {
        const { draft, refused } = applyGuard(state.draft, normalizeDraft(proposed), guard);
        const notice = refused > 0 ? refusedNotice(refused) : null;
        if (draftsEqual(draft, state.draft)) return notice === state.notice ? state : { ...state, notice };
        const history = [...state.history, { draft: state.draft, label }].slice(-HISTORY_LIMIT);
        return { draft, history, notice };
    };

    switch (action.type) {
        case 'set': {
            const next = { ...state.draft, [action.key]: withTri(state.draft[action.key], action.mask, action.tri) };
            return commit(next, action.label);
        }
        case 'setTarget': {
            const next = { ...state.draft, [action.key]: overlayMasked(state.draft[action.key], action.bits, action.mask) };
            return commit(next, action.label);
        }
        case 'replaceAll': {
            const next: Record<string, OverrideBits> = {};
            const keys = new Set([...Object.keys(state.draft), ...Object.keys(action.draft)]);
            for (const k of keys) next[k] = overlayMasked(state.draft[k], action.draft[k], action.mask);
            return commit(next, action.label);
        }
        case 'undo': {
            const last = state.history[state.history.length - 1];
            if (!last) return state;
            return { draft: last.draft, history: state.history.slice(0, -1), notice: null };
        }
        case 'reset':
            return initialEditorState(action.draft);
        case 'dismissNotice':
            return state.notice ? { ...state, notice: null } : state;
    }
}
