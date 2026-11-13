import { describe, it, expect } from 'vitest';
import {
    describeViewers, capViewers, viewerAriaLabel, viewerLabel, avatarOfMetadata, viewersOf,
    WATCHING_META_KEY, UNNAMED_VIEWER, VIEWER_LIST_CAP, type NamedRosterEntry,
} from './screenShareViewers';

const w = (identity: string, name: string | null | undefined, extra: Record<string, unknown> = {}): NamedRosterEntry =>
    ({ identity, name, metadata: JSON.stringify({ ...extra, [WATCHING_META_KEY]: ['pub'] }) });

describe('describeViewers', () => {
    it('names exactly the identities viewersOf counts, sorted by name (case-insensitive)', () => {
        const roster = [w('3', 'carl'), w('1', 'Ben'), w('2', 'amy'), { identity: '9', name: 'Idle', metadata: '{}' }];
        expect(describeViewers(roster, 'pub').map(p => p.name)).toEqual(['amy', 'Ben', 'carl']);
        expect(describeViewers(roster, 'pub').map(p => p.identity).sort()).toEqual(viewersOf(roster, 'pub'));
    });

    it('missing / blank / identity-as-name falls back to Unknown, never the id', () => {
        const roster = [w('uuid-1', undefined), w('uuid-2', null), w('uuid-3', '  '), w('uuid-4', 'uuid-4')];
        expect(describeViewers(roster, 'pub').map(p => p.name)).toEqual([UNNAMED_VIEWER, UNNAMED_VIEWER, UNNAMED_VIEWER, UNNAMED_VIEWER]);
    });

    it('a viewer who left (not in the roster) is not described', () => {
        expect(describeViewers([w('1', 'Ann')], 'pub')).toHaveLength(1);
        expect(describeViewers([], 'pub')).toEqual([]);
    });

    it('marks the local participant and reads the avatar from metadata', () => {
        const [me] = describeViewers([w('me', 'Me', { avatar_url: 'att-1' })], 'pub', 'me');
        expect(me).toMatchObject({ isSelf: true, avatar: 'att-1' });
        expect(viewerLabel(me)).toBe('Me (you)');
    });

    it('avatarOfMetadata is total', () => {
        for (const raw of [undefined, null, '', 'not json', '[]', '{"avatar_url":5}', '{"avatar_url":""}']) {
            expect(avatarOfMetadata(raw as string | null | undefined)).toBeUndefined();
        }
    });
});

describe('capViewers / viewerAriaLabel', () => {
    it('keeps the first cap items and counts the rest', () => {
        expect(capViewers([1, 2, 3, 4], 3)).toEqual({ shown: [1, 2, 3], more: 1 });
        expect(capViewers([1, 2], 3)).toEqual({ shown: [1, 2], more: 0 });
        expect(VIEWER_LIST_CAP).toBe(8);
    });

    it('speaks the names, then "and N more"', () => {
        const people = Array.from({ length: 10 }, (_, i) => ({ identity: String(i), name: `P${i}`, avatar: undefined, isSelf: false }));
        expect(viewerAriaLabel(people, 2)).toBe('10 viewers: P0, P1 and 8 more');
        expect(viewerAriaLabel(people.slice(0, 1))).toBe('1 viewer: P0');
        expect(viewerAriaLabel([])).toBe('No one is watching yet');
    });
});
