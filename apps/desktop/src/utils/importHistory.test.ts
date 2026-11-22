import { describe, it, expect } from 'vitest';
import {
    foldNameForCollision, gateImportedFrom, importMarkOf, importedAuthorLabel, importedNameCollides,
    parseImportedFrom, verifiedImportedFrom, cleanImportedName, Permissions, ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS,
    type ImportedFrom,
} from '@cipherline/shared';

/**
 * packages/shared/import-history.ts: the anti-impersonation rules every reader
 * applies to imported history (plan B6.2). There is no visible label, so the
 * server's import mark + these checks are the control.
 */
const IID = '33333333-3333-4333-8333-333333333333';
const REF = '44444444-4444-4444-8444-444444444444';
const OTHER_REF = '55555555-5555-4555-8555-555555555555';
const block: ImportedFrom = { v: 1, source: 'discord', author_ref: REF, kind: 'user', name: 'Alex', username: 'alex_92', original_ts: '2026-11-01T10:00:00.000Z' };
const text = (extra: Record<string, unknown> = {}) => ({ type: 'text', text: 'hello', imported_from: block, ...extra });
const mark = { import_id: IID, import_author_id: REF };

describe('rules 1-3: an alternate author ONLY on a server-marked row whose block matches the mark', () => {
    it('marked + matching -> the imported author', () => {
        expect(verifiedImportedFrom(text(), mark)?.name).toBe('Alex');
    });
    it('POSITIVE CONTROL: the very same content on a NON-marked row -> no alternate author', () => {
        expect(verifiedImportedFrom(text(), null)).toBeNull();
        expect(verifiedImportedFrom(text(), undefined)).toBeNull();
    });
    it('a mark for a DIFFERENT author ref -> no alternate author (content cannot be moved between authors)', () => {
        expect(verifiedImportedFrom(text(), { import_id: IID, import_author_id: OTHER_REF })).toBeNull();
    });
    it('only text and attachment rows can carry one', () => {
        expect(verifiedImportedFrom({ type: 'klipy_gif', imported_from: block }, mark)).toBeNull();
        expect(verifiedImportedFrom({ type: 'attachment', attachment_id: 'x', imported_from: block }, mark)?.name).toBe('Alex');
    });
    it('the ingest gate DROPS an unverified block entirely, keeps a verified one (cleaned)', () => {
        const dropped = gateImportedFrom(text(), null) as Record<string, unknown>;
        expect('imported_from' in dropped).toBe(false);
        expect(dropped.text).toBe('hello');
        const kept = gateImportedFrom(text({ imported_from: { ...block, name: ' Al​ex ‮ ' } }), mark) as { imported_from: ImportedFrom };
        expect(kept.imported_from.name).toBe('Alex');
        const mismatched = gateImportedFrom(text(), { import_id: IID, import_author_id: OTHER_REF }) as Record<string, unknown>;
        expect('imported_from' in mismatched).toBe(false);
        // Content with no block passes through untouched.
        const plain = { type: 'text', text: 'x' };
        expect(gateImportedFrom(plain, mark)).toBe(plain);
    });
    it('importMarkOf reads the SERVER\'s fields strictly (uuids or nothing)', () => {
        expect(importMarkOf({ import_id: IID, import_author_id: REF })).toEqual({ import_id: IID, import_author_id: REF, claimed_user_id: null });
        expect(importMarkOf({ import_id: IID })).toBeNull();
        expect(importMarkOf({ import_id: 'x', import_author_id: REF })).toBeNull();
        expect(importMarkOf({ content: { import_id: IID, import_author_id: REF } })).toBeNull();
        expect(importMarkOf(null)).toBeNull();
    });
});

describe('parseImportedFrom rejects, never coerces', () => {
    const bad: Array<[string, unknown]> = [
        ['unknown key', { ...block, url: 'https://x' }],
        ['wrong version', { ...block, v: 2 }],
        ['wrong source', { ...block, source: 'slack' }],
        ['author_ref not a uuid', { ...block, author_ref: 'alex' }],
        ['unknown kind', { ...block, kind: 'admin' }],
        ['empty name', { ...block, name: '​ ' }],
        ['bad time', { ...block, original_ts: 'yesterday' }],
        ['bad handle', { ...block, username: 'Alex Smith!' }],
        ['edited not true', { ...block, edited: 'yes' }],
        ['avatar with extra key', { ...block, avatar: { attachment_id: REF, file_key_b64: 'AA==', file_nonce_b64: 'AA==', mime: 'image/png', url: 'x' } }],
        ['avatar svg', { ...block, avatar: { attachment_id: REF, file_key_b64: 'AA==', file_nonce_b64: 'AA==', mime: 'image/svg+xml' } }],
        ['array', [block]],
        ['string', 'Alex'],
    ];
    it.each(bad)('%s -> null', (_n, v) => { expect(parseImportedFrom(v)).toBeNull(); });
    it('names are cleaned of hidden characters and clipped', () => {
        expect(cleanImportedName('A\u0000l‮ex\n\nB')).toBe('Alex B');
        expect(Array.from(cleanImportedName('x'.repeat(500))).length).toBe(80);
    });
});

describe('rule 6 / D18: name collisions', () => {
    it('folds case, spacing, punctuation, accents and common look-alikes', () => {
        expect(foldNameForCollision('A l e x')).toBe('alex');
        expect(foldNameForCollision('ÁLEX')).toBe('alex');
        expect(foldNameForCollision('Аlex')).toBe('alex'); // Cyrillic А
        expect(foldNameForCollision('al3x')).toBe('alex');
        expect(foldNameForCollision('a.l_e-x')).toBe('alex');
    });
    it('collides with a current member\'s display name or username, not otherwise', () => {
        expect(importedNameCollides('Sam', ['Mira', 'sam'])).toBe(true);
        expect(importedNameCollides('Sam', ['Mira', 'Samantha'])).toBe(false);
        expect(importedNameCollides('Sam', [null, undefined, ''])).toBe(false);
    });
    it('label: "Name · @handle" on a collision only', () => {
        expect(importedAuthorLabel(block, false)).toEqual({ name: 'Alex', suffix: null });
        expect(importedAuthorLabel(block, true)).toEqual({ name: 'Alex', suffix: '@alex_92' });
        expect(importedAuthorLabel({ ...block, username: undefined }, true)).toEqual({ name: 'Alex', suffix: null });
    });
});

describe('IMPORT_HISTORY (bit 15)', () => {
    it('is bit 15, owner/ADMINISTRATOR hold it, @everyone does not', () => {
        expect(Permissions.IMPORT_HISTORY).toBe(1n << 15n);
        expect(ALL_PERMISSIONS & Permissions.IMPORT_HISTORY).toBe(Permissions.IMPORT_HISTORY);
        expect(DEFAULT_EVERYONE_PERMISSIONS & Permissions.IMPORT_HISTORY).toBe(0n);
    });
});
