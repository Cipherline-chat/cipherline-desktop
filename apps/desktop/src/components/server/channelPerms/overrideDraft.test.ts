import { describe, it, expect } from 'vitest';
import { Permissions as P } from '@cipherline/shared';
import {
    applyGuard,
    bitCount,
    countTargets,
    diffDraft,
    draftFromRows,
    draftsEqual,
    editorReducer,
    initialEditorState,
    memberKey,
    overlayMasked,
    roleKey,
    triOf,
    triOfMask,
    withTri,
    HISTORY_LIMIT,
    type DraftMap,
    type EditGuard,
    type EditorAction,
    type EditorState,
} from './overrideDraft';

const EV = roleKey('ev');
const MOD = roleKey('mod');
const MASK = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ADD_REACTIONS;

const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce((st, a) => editorReducer(st, a), s);

describe('tri-state bit helpers', () => {
    it('reads allow / deny / inherit, allow winning a corrupt both-set row', () => {
        const b = { allow: P.SEND_MESSAGES | P.VIEW_CHANNEL, deny: P.VIEW_CHANNEL | P.ADD_REACTIONS };
        expect(triOf(b, P.SEND_MESSAGES)).toBe('allow');
        expect(triOf(b, P.VIEW_CHANNEL)).toBe('allow');
        expect(triOf(b, P.ADD_REACTIONS)).toBe('deny');
        expect(triOf(b, P.ATTACH_FILES)).toBe('inherit');
        expect(triOf(undefined, P.ATTACH_FILES)).toBe('inherit');
    });

    it('withTri sets every masked bit and leaves the others exactly as they were', () => {
        const hidden = P.MANAGE_CHANNELS; // not in MASK
        const b = { allow: hidden | P.SEND_MESSAGES, deny: P.ADD_REACTIONS };
        expect(withTri(b, MASK, 'deny')).toEqual({ allow: hidden, deny: MASK });
        expect(withTri(b, MASK, 'allow')).toEqual({ allow: hidden | MASK, deny: 0n });
        expect(withTri(b, MASK, 'inherit')).toEqual({ allow: hidden, deny: 0n });
        // Moving a bit from deny to allow never leaves it in both.
        const flipped = withTri({ allow: 0n, deny: P.SEND_MESSAGES }, P.SEND_MESSAGES, 'allow');
        expect(flipped).toEqual({ allow: P.SEND_MESSAGES, deny: 0n });
    });

    it('triOfMask reports a uniform state or null when mixed', () => {
        const bits = [P.VIEW_CHANNEL, P.SEND_MESSAGES];
        expect(triOfMask({ allow: P.VIEW_CHANNEL | P.SEND_MESSAGES, deny: 0n }, bits)).toBe('allow');
        expect(triOfMask(undefined, bits)).toBe('inherit');
        expect(triOfMask({ allow: P.VIEW_CHANNEL, deny: 0n }, bits)).toBe(null);
    });

    it('overlayMasked swaps only the masked bits', () => {
        const into = { allow: P.MANAGE_CHANNELS | P.VIEW_CHANNEL, deny: P.SPEAK };
        const from = { allow: P.SEND_MESSAGES, deny: P.VIEW_CHANNEL | P.CONNECT };
        expect(overlayMasked(into, from, MASK)).toEqual({
            allow: P.MANAGE_CHANNELS | P.SEND_MESSAGES,
            deny: P.SPEAK | P.VIEW_CHANNEL,
        });
    });

    it('counts bits', () => {
        expect(bitCount(0n)).toBe(0);
        expect(bitCount(MASK)).toBe(3);
        expect(bitCount(1n << 40n)).toBe(1);
    });
});

describe('wire conversion + diff', () => {
    it('reads API rows (dropping empty ones) and diffs to upserts + deletes', () => {
        const baseline = draftFromRows([
            { target_kind: 'role', target_id: 'ev', allow_bits: '0', deny_bits: P.SEND_MESSAGES.toString() },
            { target_kind: 'role', target_id: 'mod', allow_bits: P.SEND_MESSAGES.toString(), deny_bits: '0' },
            { target_kind: 'member', target_id: 'u1', allow_bits: '0', deny_bits: '0' },
        ]);
        expect(Object.keys(baseline).sort()).toEqual([EV, MOD]);
        const draft: DraftMap = {
            [EV]: { allow: 0n, deny: P.SEND_MESSAGES }, // unchanged
            [memberKey('u2')]: { allow: P.VIEW_CHANNEL, deny: 0n }, // new
            // MOD removed
        };
        const d = diffDraft(baseline, draft);
        expect(d.upserts).toEqual([{ target_kind: 'member', target_id: 'u2', allow_bits: P.VIEW_CHANNEL.toString(), deny_bits: '0' }]);
        expect(d.deletes).toEqual([{ target_kind: 'role', target_id: 'mod' }]);
    });

    it('puts the @everyone upsert first when asked', () => {
        const draft: DraftMap = {
            [roleKey('a')]: { allow: P.VIEW_CHANNEL, deny: 0n },
            [roleKey('zz-everyone')]: { allow: 0n, deny: P.VIEW_CHANNEL },
            [roleKey('b')]: { allow: P.VIEW_CHANNEL, deny: 0n },
        };
        const d = diffDraft({}, draft, roleKey('zz-everyone'));
        expect(d.upserts[0].target_id).toBe('zz-everyone');
        expect(d.upserts).toHaveLength(3);
    });

    it('an unchanged draft produces no requests; an empty-bits entry counts as missing', () => {
        const base = { [EV]: { allow: 0n, deny: P.SEND_MESSAGES } };
        expect(diffDraft(base, { ...base, [MOD]: { allow: 0n, deny: 0n } })).toEqual({ upserts: [], deletes: [] });
        expect(draftsEqual(base, { ...base, [MOD]: { allow: 0n, deny: 0n } })).toBe(true);
    });

    it('bigint bits above 2^31 survive the round trip', () => {
        const hi = 1n << 40n;
        const d = diffDraft({}, { [EV]: { allow: hi, deny: 0n } });
        expect(draftFromRows([d.upserts[0]])[EV].allow).toBe(hi);
    });

    it('countTargets counts targets with visible overrides only', () => {
        expect(countTargets({ [EV]: { allow: P.MANAGE_CHANNELS, deny: 0n }, [MOD]: { allow: P.SEND_MESSAGES, deny: 0n } }, MASK)).toBe(1);
    });
});

describe('editor reducer', () => {
    it('sets a single row, a whole mask (allow all / deny all / clear), and records undo for each', () => {
        let s = initialEditorState();
        s = run(s, { type: 'set', key: MOD, mask: P.SEND_MESSAGES, tri: 'allow', label: 'Send → Allow' });
        expect(s.draft[MOD]).toEqual({ allow: P.SEND_MESSAGES, deny: 0n });
        s = run(s, { type: 'set', key: MOD, mask: MASK, tri: 'deny', label: 'Deny all' });
        expect(s.draft[MOD]).toEqual({ allow: 0n, deny: MASK });
        s = run(s, { type: 'set', key: MOD, mask: MASK, tri: 'inherit', label: 'Clear' });
        expect(s.draft[MOD]).toBeUndefined(); // normalised away
        expect(s.history.map(h => h.label)).toEqual(['Send → Allow', 'Deny all', 'Clear']);

        s = run(s, { type: 'undo' });
        expect(s.draft[MOD]).toEqual({ allow: 0n, deny: MASK });
        s = run(s, { type: 'undo' }, { type: 'undo' });
        expect(s.draft).toEqual({});
        expect(run(s, { type: 'undo' })).toBe(s); // nothing left: identity
    });

    it('a no-op edit does not push history', () => {
        const s = run(initialEditorState({ [MOD]: { allow: P.SEND_MESSAGES, deny: 0n } }),
            { type: 'set', key: MOD, mask: P.SEND_MESSAGES, tri: 'allow', label: 'same' });
        expect(s.history).toHaveLength(0);
    });

    it('paste-role overlays only the visible mask and keeps the target’s hidden bits', () => {
        const s0 = initialEditorState({ [MOD]: { allow: P.MANAGE_CHANNELS, deny: P.VIEW_CHANNEL } });
        const s = run(s0, {
            type: 'setTarget', key: MOD, mask: MASK, label: 'Paste',
            bits: { allow: P.SEND_MESSAGES | P.CONNECT /* not visible */, deny: P.ADD_REACTIONS },
        });
        expect(s.draft[MOD]).toEqual({ allow: P.MANAGE_CHANNELS | P.SEND_MESSAGES, deny: P.ADD_REACTIONS });
    });

    it('replaceAll (paste channel / preset) replaces every target’s visible bits, clearing targets not in the source', () => {
        const s0 = initialEditorState({
            [EV]: { allow: 0n, deny: P.SEND_MESSAGES },
            [MOD]: { allow: P.SEND_MESSAGES | P.MANAGE_CHANNELS, deny: 0n },
        });
        const s = run(s0, { type: 'replaceAll', mask: MASK, label: 'Preset', draft: { [EV]: { allow: 0n, deny: P.VIEW_CHANNEL } } });
        expect(s.draft).toEqual({
            [EV]: { allow: 0n, deny: P.VIEW_CHANNEL },
            [MOD]: { allow: P.MANAGE_CHANNELS, deny: 0n }, // hidden bit survives
        });
        expect(run(s, { type: 'undo' }).draft).toEqual(s0.draft);
    });

    it('reset loads a new baseline and forgets history', () => {
        const s = run(initialEditorState(), { type: 'set', key: MOD, mask: MASK, tri: 'allow', label: 'x' },
            { type: 'reset', draft: { [EV]: { allow: P.VIEW_CHANNEL, deny: 0n } } });
        expect(s.history).toEqual([]);
        expect(s.draft).toEqual({ [EV]: { allow: P.VIEW_CHANNEL, deny: 0n } });
    });

    it('caps history', () => {
        let s = initialEditorState();
        for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
            s = run(s, { type: 'set', key: MOD, mask: P.SEND_MESSAGES, tri: i % 2 ? 'allow' : 'deny', label: `#${i}` });
        }
        expect(s.history).toHaveLength(HISTORY_LIMIT);
    });
});

describe('guard (the server’s diff rule + hierarchy, mirrored)', () => {
    // The caller holds VIEW + SEND in this channel; Admin is above them.
    const baseline: DraftMap = { [MOD]: { allow: P.MANAGE_MESSAGES, deny: P.EMBED_LINKS } }; // set by someone above
    const guard: EditGuard = { editable: P.VIEW_CHANNEL | P.SEND_MESSAGES, baseline, lockedKeys: new Set([roleKey('admin')]) };

    it('changes to bits the caller holds pass; changes to other bits — allow OR deny — are put back to the saved state', () => {
        const next: DraftMap = { [MOD]: { allow: P.MANAGE_MESSAGES | P.ATTACH_FILES | P.SEND_MESSAGES, deny: P.EMBED_LINKS | P.ADD_REACTIONS } };
        const { draft, refused } = applyGuard(baseline, next, guard);
        expect(draft[MOD]).toEqual({ allow: P.MANAGE_MESSAGES | P.SEND_MESSAGES, deny: P.EMBED_LINKS });
        expect(refused).toBe(2); // ATTACH_FILES allow, ADD_REACTIONS deny
    });

    it('a saved bit the caller lacks may stay, but may not be REMOVED (that is a change to it)', () => {
        // Dropping the foreign MANAGE_MESSAGES allow and the foreign EMBED deny → both reverted.
        const { draft, refused } = applyGuard(baseline, { [MOD]: { allow: 0n, deny: 0n } }, guard);
        expect(draft[MOD]).toEqual(baseline[MOD]);
        expect(refused).toBe(2);
        // Leaving them exactly as saved while changing a held bit is fine.
        const ok = applyGuard(baseline, { [MOD]: { allow: P.MANAGE_MESSAGES, deny: P.EMBED_LINKS | P.SEND_MESSAGES } }, guard);
        expect(ok.draft[MOD]).toEqual({ allow: P.MANAGE_MESSAGES, deny: P.EMBED_LINKS | P.SEND_MESSAGES });
        expect(ok.refused).toBe(0);
    });

    it('the comparison is against the BASELINE, not the previous draft', () => {
        // prev already differs from baseline on SEND (held); moving SEND back is not refused,
        // and a foreign bit is judged against what the server holds regardless of prev.
        const prev: DraftMap = { [MOD]: { allow: P.MANAGE_MESSAGES | P.SEND_MESSAGES, deny: P.EMBED_LINKS } };
        const { draft, refused } = applyGuard(prev, { [MOD]: { allow: P.MANAGE_MESSAGES, deny: P.EMBED_LINKS } }, guard);
        expect(draft[MOD]).toEqual(baseline[MOD]);
        expect(refused).toBe(0);
    });

    it('locks a target entirely', () => {
        const prev: DraftMap = { [roleKey('admin')]: { allow: 0n, deny: P.VIEW_CHANNEL } };
        const { draft, refused } = applyGuard(prev, {}, guard);
        expect(draft).toEqual(prev);
        expect(refused).toBe(1);
        expect(applyGuard({}, { [roleKey('admin')]: { allow: 0n, deny: P.VIEW_CHANNEL } }, guard).draft).toEqual({});
    });

    it('the reducer applies the guard and surfaces a notice; allow-all yields only editable bits', () => {
        const open: EditGuard = { ...guard, baseline: {} };
        const s = editorReducer(initialEditorState(), { type: 'set', key: MOD, mask: MASK, tri: 'allow', label: 'Allow all' }, open);
        expect(s.draft[MOD]).toEqual({ allow: P.VIEW_CHANNEL | P.SEND_MESSAGES, deny: 0n });
        expect(s.notice).toMatch(/1 change was skipped/);
        const s2 = editorReducer(s, { type: 'dismissNotice' }, open);
        expect(s2.notice).toBe(null);
    });

    it('deny-all is clamped the same way — denies are not free', () => {
        const open: EditGuard = { ...guard, baseline: {} };
        const s = editorReducer(initialEditorState(), { type: 'set', key: MOD, mask: MASK, tri: 'deny', label: 'Deny all' }, open);
        expect(s.draft[MOD]).toEqual({ allow: 0n, deny: P.VIEW_CHANNEL | P.SEND_MESSAGES });
        expect(s.notice).toMatch(/1 change was skipped/);
    });

    it('a fully refused action changes nothing and pushes no history', () => {
        const s = editorReducer(initialEditorState(), { type: 'set', key: roleKey('admin'), mask: MASK, tri: 'deny', label: 'Deny all' }, guard);
        expect(s.draft).toEqual({});
        expect(s.history).toHaveLength(0);
        expect(s.notice).toMatch(/skipped/);
    });
});
