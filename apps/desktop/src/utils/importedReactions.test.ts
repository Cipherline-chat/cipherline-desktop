// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { gateImportedFrom, parseImportedFrom, parseImportedReactions, verifiedImportedFrom, type ImportedFrom } from '@cipherline/shared';
import {
    isImportedReactorId, mergeImportedReactions, noteImportAuthorClaim, reactorClaimsFor,
    resetReactorClaimsForTests, setReactorClaimsForTests,
} from './importedReactions';
import { verifiedBlockOf } from './importedAuthor';

/**
 * Imported reactions: inside the encrypted block, honoured only on a VERIFIED
 * row (B6.2 rules 1-3), reactors only when the server lists them as authors
 * of that import (rule 2), a claimed reactor shows as the claimant (rule 4),
 * and a claim / link move transfers them.
 */
const IID = '33333333-3333-4333-8333-333333333333';
const AUTHOR = '44444444-4444-4444-8444-444444444444';
const SAM = '55555555-5555-4555-8555-555555555551';
const ALEX = '55555555-5555-4555-8555-555555555552';
const FORGED = '55555555-5555-4555-8555-555555555559';
const SAM_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const NEW_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

const block = (reactions: unknown): ImportedFrom => ({
    v: 1, source: 'discord', author_ref: AUTHOR, kind: 'user', name: 'Alex', original_ts: '2026-11-01T10:00:00.000Z',
    reactions: reactions as ImportedFrom['reactions'],
});
const mark = { import_id: IID, import_author_id: AUTHOR };
const row = (reactions: unknown, m: typeof mark | null = mark) => ({
    content: { type: 'text', text: 'hi', imported_from: block(reactions) }, import_mark: m,
});
const party = [{ emoji: '🎉', count: 3, reactors: [{ ref: SAM, name: 'Sam' }, { ref: ALEX, name: 'Alex' }] }];

describe('the block: strict parse of reactions', () => {
    it('a valid list parses (names cleaned, refs lower-cased)', () => {
        const b = parseImportedFrom({ ...block(null), reactions: [{ emoji: '🎉', count: 2, reactors: [{ ref: SAM.toUpperCase(), name: ' Sam​ ' }] }] });
        expect(b?.reactions).toEqual([{ emoji: '🎉', count: 2, reactors: [{ ref: SAM, name: 'Sam' }] }]);
    });
    it.each([
        ['an unknown key', [{ emoji: '🎉', count: 1, reactors: [], extra: 1 }]],
        ['count below the named reactors', [{ emoji: '🎉', count: 1, reactors: [{ ref: SAM, name: 'a' }, { ref: ALEX, name: 'b' }] }]],
        ['a duplicate emoji', [{ emoji: '🎉', count: 1, reactors: [] }, { emoji: '🎉', count: 1, reactors: [] }]],
        ['a duplicate reactor', [{ emoji: '🎉', count: 2, reactors: [{ ref: SAM, name: 'a' }, { ref: SAM, name: 'b' }] }]],
        ['a reserved object key as emoji', [{ emoji: '__proto__', count: 1, reactors: [] }]],
        ['a non-uuid reactor ref', [{ emoji: '🎉', count: 1, reactors: [{ ref: '80351110224678912', name: 'a' }] }]],
        ['21 reactions', Array.from({ length: 21 }, (_, i) => ({ emoji: `e${i}`, count: 1, reactors: [] }))],
    ])('REJECTS %s, and with it the WHOLE block (render as the real sender)', (_n, reactions) => {
        expect(parseImportedReactions(reactions)).toBeNull();
        expect(parseImportedFrom({ ...block(null), reactions })).toBeNull();
    });
});

describe('rule 1: only a server-marked, verified row carries imported reactions', () => {
    it('marked + matching: the reactions are there', () => {
        expect(verifiedBlockOf(row(party))?.reactions).toHaveLength(1);
    });
    it('a NON-marked row whose content claims reactions carries NONE (the gate drops the block)', () => {
        expect(verifiedImportedFrom(row(party, null).content, null)).toBeNull();
        const gated = gateImportedFrom(row(party, null).content, null) as Record<string, unknown>;
        expect('imported_from' in gated).toBe(false);
        // And the merge leaves the live reactions untouched.
        const live = { '👍': ['u1'] };
        expect(mergeImportedReactions(live, verifiedBlockOf(row(party, null)), undefined).reactions).toBe(live);
    });
    it('POSITIVE CONTROL: the same content on the marked row does merge', () => {
        const r = mergeImportedReactions({ '👍': ['u1'] }, verifiedBlockOf(row(party)), undefined).reactions!;
        expect(r['🎉']).toHaveLength(3);
        expect(r['👍']).toEqual(['u1']);
    });
});

describe('merge', () => {
    beforeEach(() => resetReactorClaimsForTests());

    it('unclaimed reactors: their imported names; the rest of Discord\'s count as "someone on Discord"; never "mine"', () => {
        const m = mergeImportedReactions(undefined, block(party), new Map([[SAM, null], [ALEX, null]]));
        const ids = m.reactions!['🎉'];
        expect(ids.map(id => m.names[id])).toEqual(['Sam', 'Alex', 'someone on Discord']);
        expect(ids.every(isImportedReactorId)).toBe(true);
        expect(m.claimed).toEqual({});
    });

    it('rule 2: a reactor ref the server does not list for THIS import is dropped (a forged ref names no one)', () => {
        const forged = [{ emoji: '🎉', count: 2, reactors: [{ ref: SAM, name: 'Sam' }, { ref: FORGED, name: 'Owner' }] }];
        const m = mergeImportedReactions(undefined, block(forged), new Map([[SAM, SAM_USER]]));
        expect(Object.values(m.names)).not.toContain('Owner');
        expect(Object.keys(m.claimed)).toHaveLength(1);
    });

    it('a claimed reactor shows as the claimant; claiming / a link move TRANSFERS their reactions', () => {
        setReactorClaimsForTests(IID, new Map([[SAM, null], [ALEX, null]]));
        let m = mergeImportedReactions(undefined, block(party), reactorClaimsFor(IID));
        expect(Object.values(m.claimed)).toEqual([]);
        noteImportAuthorClaim(SAM, SAM_USER); // claim
        m = mergeImportedReactions(undefined, block(party), reactorClaimsFor(IID));
        expect(m.claimed[`imp:${SAM}`]).toBe(SAM_USER);
        noteImportAuthorClaim(SAM, NEW_USER); // the link moved to another account
        m = mergeImportedReactions(undefined, block(party), reactorClaimsFor(IID));
        expect(m.claimed[`imp:${SAM}`]).toBe(NEW_USER);
        noteImportAuthorClaim(SAM, null); // unclaimed
        m = mergeImportedReactions(undefined, block(party), reactorClaimsFor(IID));
        expect(m.claimed).toEqual({});
        expect(m.names[`imp:${SAM}`]).toBe('Sam');
    });

    it('the claimant\'s own LIVE reaction with the same emoji is counted once', () => {
        const m = mergeImportedReactions({ '🎉': [SAM_USER] }, block(party), new Map([[SAM, SAM_USER], [ALEX, null]]));
        expect(m.reactions!['🎉']).toHaveLength(3); // Alex + 1 unnamed + Sam (live) — not 4
        expect(m.reactions!['🎉']).toContain(SAM_USER);
    });

    it('a huge Discord count pads at most 999 unnamed reactors', () => {
        const m = mergeImportedReactions(undefined, block([{ emoji: '🔥', count: 50_000, reactors: [] }]), undefined);
        expect(m.reactions!['🔥']).toHaveLength(999);
    });
});
