import { describe, it, expect } from 'vitest';
import {
    mergeScope,
    mergeSaves,
    sameScope,
    sameSaves,
    sanitizeScope,
    parseSavesPayload,
    buildSavesPayload,
    addedSaves,
    emptySaves,
    isEmptySaves,
    MAX_SAVES_PER_SCOPE,
    type PinScopeState,
    type SavesState,
} from './personalSavesSync';

const C = 'c0ffee00-0000-4000-8000-000000000001';
const M1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const M2 = 'aaaaaaaa-0000-4000-8000-000000000002';

const scope = (pins: Record<string, string[]>, ledger: Record<string, Record<string, number>> = {}): PinScopeState => ({ pins, ledger });
const saved = (s: PinScopeState, c: string, m: string) => (s.pins[c] ?? []).includes(m);

describe('mergeScope — last-write-wins per message', () => {
    it('a newer save beats an older tombstone, in both argument orders', () => {
        const a = scope({ [C]: [M1] }, { [C]: { [M1]: 200 } });
        const b = scope({}, { [C]: { [M1]: 100 } });
        expect(saved(mergeScope(a, b), C, M1)).toBe(true);
        expect(saved(mergeScope(b, a), C, M1)).toBe(true);
        expect(mergeScope(a, b).ledger[C][M1]).toBe(200);
    });

    it('a newer tombstone beats an older save, in both argument orders', () => {
        const a = scope({ [C]: [M1] }, { [C]: { [M1]: 100 } });
        const b = scope({}, { [C]: { [M1]: 200 } });
        expect(saved(mergeScope(a, b), C, M1)).toBe(false);
        expect(saved(mergeScope(b, a), C, M1)).toBe(false);
        expect(mergeScope(a, b).ledger[C][M1]).toBe(200);
    });

    it('an exact tie keeps the save', () => {
        const a = scope({ [C]: [M1] }, { [C]: { [M1]: 100 } });
        const b = scope({}, { [C]: { [M1]: 100 } });
        expect(saved(mergeScope(a, b), C, M1)).toBe(true);
        expect(saved(mergeScope(b, a), C, M1)).toBe(true);
    });

    it('a side that never heard of a message cannot outvote one that has', () => {
        const a = scope({ [C]: [M1] }, { [C]: { [M1]: 5 } });
        expect(saved(mergeScope(a, scope({})), C, M1)).toBe(true);
        expect(saved(mergeScope(scope({}), a), C, M1)).toBe(true);
    });

    it('a pre-ledger pin (no timestamp) counts as time 0: kept against silence, removed by a real unpin', () => {
        const legacy = scope({ [C]: [M1] });
        expect(saved(mergeScope(legacy, scope({})), C, M1)).toBe(true);
        expect(saved(mergeScope(legacy, scope({}, { [C]: { [M1]: 1 } })), C, M1)).toBe(false);
        // and it does not invent a ledger entry for itself
        expect(mergeScope(legacy, scope({})).ledger[C]).toBeUndefined();
    });

    it('is commutative (as a set) and idempotent', () => {
        const a = scope({ [C]: [M1] }, { [C]: { [M1]: 10, [M2]: 30 } });
        const b = scope({ [C]: [M2] }, { [C]: { [M2]: 20 } });
        expect(sameScope(mergeScope(a, b), mergeScope(b, a))).toBe(true);
        const once = mergeScope(a, b);
        expect(sameScope(mergeScope(once, b), once)).toBe(true);
        expect(sameScope(mergeScope(once, once), once)).toBe(true);
    });

    it('keeps the local (first-argument) order and appends what is new', () => {
        const local = scope({ [C]: [M2, M1] });
        const remote = scope({ [C]: ['bbbbbbbb-0000-4000-8000-000000000003'] }, { [C]: { 'bbbbbbbb-0000-4000-8000-000000000003': 9 } });
        expect(mergeScope(local, remote).pins[C]).toEqual([M2, M1, 'bbbbbbbb-0000-4000-8000-000000000003']);
    });

    it('drops a container whose last save was removed (no empty arrays)', () => {
        const a = scope({ [C]: [M1] }, { [C]: { [M1]: 1 } });
        const b = scope({}, { [C]: { [M1]: 2 } });
        expect(mergeScope(a, b).pins[C]).toBeUndefined();
    });
});

describe('mergeSaves keeps the two scopes apart', () => {
    it('a channel save never lands in the conversation scope (the 09-20 misfile)', () => {
        const local = emptySaves();
        const remote: SavesState = { conversation: scope({}), channel: scope({ [C]: [M1] }, { [C]: { [M1]: 5 } }) };
        const m = mergeSaves(local, remote);
        expect(m.channel.pins[C]).toEqual([M1]);
        expect(m.conversation.pins[C]).toBeUndefined();
    });
});

describe('payload validation', () => {
    it('round-trips a built payload', () => {
        const state: SavesState = {
            conversation: scope({ [C]: [M1] }, { [C]: { [M1]: 3 } }),
            channel: scope({}, { [C]: { [M2]: 4 } }),
        };
        const p = parseSavesPayload(JSON.stringify(buildSavesPayload(state, 99)));
        expect(p.writtenAt).toBe(99);
        expect(sameSaves(p, state)).toBe(true);
    });

    it('rejects an unknown payload version rather than guessing', () => {
        expect(() => parseSavesPayload(JSON.stringify({ v: 2 }))).toThrow(/version 2/);
        expect(() => parseSavesPayload('nope')).toThrow(/not valid JSON/);
        expect(() => parseSavesPayload('[]')).toThrow(/not an object/);
    });

    it('drops unsafe ids and non-finite or negative timestamps instead of repairing them', () => {
        const s = sanitizeScope({
            pins: { [C]: [M1, '../etc', 42, M1], '../../x': [M1], [M2]: 'not-an-array' },
            ledger: { [C]: { [M1]: 5, [M2]: Number.NaN, 'bad/id': 1, 'aaaaaaaa-0000-4000-8000-000000000009': -1 } },
        });
        expect(s.pins).toEqual({ [C]: [M1] });
        expect(s.ledger).toEqual({ [C]: { [M1]: 5 } });
    });

    it('caps a scope so a hostile payload cannot balloon memory', () => {
        const ids = Array.from({ length: MAX_SAVES_PER_SCOPE + 50 }, (_, i) => `m${i}`);
        const s = sanitizeScope({ pins: { [C]: ids } });
        expect(s.pins[C].length).toBe(MAX_SAVES_PER_SCOPE);
    });
});

describe('helpers', () => {
    it('addedSaves lists exactly the new saves', () => {
        const before = scope({ [C]: [M1] });
        const after = scope({ [C]: [M1, M2] });
        expect(addedSaves(before, after)).toEqual([{ container_id: C, message_id: M2 }]);
    });
    it('isEmptySaves sees tombstones as content', () => {
        expect(isEmptySaves(emptySaves())).toBe(true);
        expect(isEmptySaves({ conversation: scope({}, { [C]: { [M1]: 1 } }), channel: scope({}) })).toBe(false);
    });
});
