import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRowSaveIndex, retentionShared, rowSaveKey } from '../utils/rowSaveState';
import type { StoragePolicy } from '../hooks/useRetentionPolicy';

/**
 * "Saving a message makes the chat jump for a split second" (owner,
 * 0.1.2-staging.245). Saving / unsaving / pinning / unpinning ONE message used
 * to re-render EVERY message row, because the saved / pinned / personal-save
 * id lists were pane-wide row deps; any row whose render was not perfectly
 * idempotent then moved (measured: an image link above the saved message grew
 * 4.5 px at 1000x720 and pushed everything below it; harness/save-no-jump-check.mjs).
 * A row now depends on its OWN save state only. ChatPane has no vitest render
 * harness, so the wiring is pinned by a scan (like messageRowIdentityWiring)
 * and the per-row key by unit tests; the frame-level proof is the harness check.
 */
const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const rowGlobals = (code: string) => {
    const at = code.indexOf('const rowGlobals = [');
    return at < 0 ? '' : code.slice(at, code.indexOf('];', at));
};
const PANE_WIDE_SAVE_DEPS = /\b(stServerSavedIds|stablePinnedMsgIds|stRetentionPolicy|serverSavedIds|pinnedMsgIds)\b/;

describe('ChatPane: a save re-renders only the saved row', () => {
    it('positive control: the scan sees the pre-fix pane-wide deps', () => {
        const before = 'const rowGlobals = [\n token, stUser,\n stablePinnedMsgIds, stServerSavedIds, stActiveChannel,\n stRetentionPolicy, nowTick,\n ];';
        expect(rowGlobals(before)).toMatch(PANE_WIDE_SAVE_DEPS);
    });

    it('rowGlobals carries no saved / pinned / per-id retention list', () => {
        const g = rowGlobals(src);
        expect(g.length).toBeGreaterThan(100);
        expect(g).not.toMatch(PANE_WIDE_SAVE_DEPS);
        // The rest of the policy (periods, per-type defaults) is still pane-wide.
        expect(g).toContain('stRetentionShared');
        expect(src).toMatch(/const stRetentionShared = useShallowStable\(retentionShared\(retention\.policy\), 2\);/);
    });

    it("each row's deps carry its own save key", () => {
        const at = src.indexOf('const rowDeps = [');
        const deps = src.slice(at, src.indexOf('];', at));
        expect(deps).toContain('rowSaveKey(rowSaveIndex, msg.id,');
    });
});

const policy = (p: Partial<StoragePolicy> = {}): StoragePolicy => ({
    attachmentRetention: '24h', messageRetention: '1mo',
    savedAttachmentIds: [], unsavedAttachmentIds: [], savedMessageIds: [], unsavedMessageIds: [],
    unsavedMessageTimestamps: {}, unsavedAttachmentTimestamps: {}, ...p,
});

describe('rowSaveKey', () => {
    const MSGS = ['a', 'b', 'c'];
    const keys = (saved: string[], pinned: string[], pol: StoragePolicy) => {
        const ix = buildRowSaveIndex(saved, pinned, pol);
        return MSGS.map(id => rowSaveKey(ix, id, id === 'c' ? 'att-c' : undefined));
    };

    it('server save / unsave / pin / unpin change ONLY that message\'s key', () => {
        const k0 = keys([], [], policy());
        const k1 = keys(['b'], [], policy());          // save b
        const k2 = keys(['b'], ['b'], policy());       // pin b
        const k3 = keys(['b'], [], policy());          // unpin b
        const k4 = keys([], [], policy());             // unsave b
        for (const [x, y] of [[k0, k1], [k1, k2], [k2, k3], [k3, k4]]) {
            expect(x[0]).toBe(y[0]);
            expect(x[1]).not.toBe(y[1]);
            expect(x[2]).toBe(y[2]);
        }
    });

    it('personal save / unsave (message and attachment) change only that row', () => {
        const k0 = keys([], [], policy());
        const k1 = keys([], [], policy({ savedMessageIds: ['a'] }));
        expect([k1[0] !== k0[0], k1[1] === k0[1], k1[2] === k0[2]]).toEqual([true, true, true]);
        const k2 = keys([], [], policy({ unsavedAttachmentIds: ['att-c'], unsavedAttachmentTimestamps: { 'att-c': 5 } }));
        expect([k2[0] === k0[0], k2[1] === k0[1], k2[2] !== k0[2]]).toEqual([true, true, true]);
        // A new unsave time for the same message is a change (its countdown restarts).
        const u1 = keys([], [], policy({ unsavedMessageIds: ['a'], unsavedMessageTimestamps: { a: 1 } }));
        const u2 = keys([], [], policy({ unsavedMessageIds: ['a'], unsavedMessageTimestamps: { a: 2 } }));
        expect(u1[0]).not.toBe(u2[0]);
    });

    it('retentionShared drops exactly the per-id lists', () => {
        const s = retentionShared(policy({ savedMessageIds: ['x'], serverMessageRetention: '1wk' }));
        expect(s).not.toHaveProperty('savedMessageIds');
        expect(s).not.toHaveProperty('unsavedAttachmentTimestamps');
        expect(s).toMatchObject({ attachmentRetention: '24h', serverMessageRetention: '1wk' });
    });
});
