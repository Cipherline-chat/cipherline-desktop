import { describe, it, expect, vi } from 'vitest';

vi.mock('./secureLocalStore', () => {
    const s = { getItem: () => null, setItem: () => {}, isAccountReady: () => true };
    return { default: s, secureLocalStore: s };
});

const { extractPortableSaves, portableSavesFromVault, mergeSavesIntoPolicy } = await import('./retentionPortability');

describe('extractPortableSaves (export)', () => {
    it('takes only the saved id lists', () => {
        expect(extractPortableSaves(JSON.stringify({
            messageRetention: '1wk', savedMessageIds: ['m'], savedAttachmentIds: ['a'], unsavedMessageIds: ['x'],
        }))).toEqual({ savedMessageIds: ['m'], savedAttachmentIds: ['a'] });
    });
    it.each([
        ['absent', null],
        ['corrupt', '{no'],
        ['not an object', '"str"'],
        ['nothing saved', JSON.stringify({ savedMessageIds: [], unsavedMessageIds: ['x'] })],
    ])('is undefined when %s', (_n, raw) => {
        expect(extractPortableSaves(raw)).toBeUndefined();
    });
});

describe('portableSavesFromVault (import)', () => {
    it('unions the current field with a legacy retentionPolicy, dropping non-strings', () => {
        expect(portableSavesFromVault({
            retentionSaves: { savedMessageIds: ['a', 'b'], savedAttachmentIds: [] },
            retentionPolicy: { savedMessageIds: ['b', 'c', 7, null, ''], savedAttachmentIds: ['f'], messageRetention: '1wk' },
        })).toEqual({ savedMessageIds: ['a', 'b', 'c'], savedAttachmentIds: ['f'] });
    });
    it.each([null, undefined, 'x', [], { retentionPolicy: 'garbage' }, { retentionSaves: [1] }])(
        'yields no saves for %j', (v) => {
            expect(portableSavesFromVault(v)).toEqual({ savedMessageIds: [], savedAttachmentIds: [] });
        },
    );
});

describe('mergeSavesIntoPolicy', () => {
    const saves = { savedMessageIds: ['m1'], savedAttachmentIds: ['a1'] };

    it('with no local record writes a saves-only record (no retention fields)', () => {
        expect(JSON.parse(mergeSavesIntoPolicy(null, saves)!)).toEqual({ savedMessageIds: ['m1'], savedAttachmentIds: ['a1'] });
    });

    it('never touches the local retention windows, and unions ids', () => {
        const out = JSON.parse(mergeSavesIntoPolicy(JSON.stringify({ messageRetention: '1y', savedMessageIds: ['m0'] }), saves)!);
        expect(out.messageRetention).toBe('1y');
        expect(out.savedMessageIds).toEqual(['m0', 'm1']);
    });

    it('a restored save beats a local unsave (the lossless resolution) and clears its timestamp', () => {
        const out = JSON.parse(mergeSavesIntoPolicy(JSON.stringify({
            unsavedMessageIds: ['m1', 'm9'], unsavedMessageTimestamps: { m1: 1, m9: 2 },
        }), saves)!);
        expect(out.savedMessageIds).toEqual(['m1']);
        expect(out.unsavedMessageIds).toEqual(['m9']);
        expect(out.unsavedMessageTimestamps).toEqual({ m9: 2 });
    });

    it('returns null when nothing changes', () => {
        expect(mergeSavesIntoPolicy(JSON.stringify({ savedMessageIds: ['m1'], savedAttachmentIds: ['a1'] }), saves)).toBeNull();
        expect(mergeSavesIntoPolicy(null, { savedMessageIds: [], savedAttachmentIds: [] })).toBeNull();
    });
});
