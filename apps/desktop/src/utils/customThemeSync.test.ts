import { describe, expect, it } from 'vitest';
import {
    MAX_THEMES_PAYLOAD_BYTES, THEMES_SLOT, THEME_LIBRARY_MAX, THEME_TOMBSTONE_TTL_MS, buildLocalThemeState, buildThemesPayload,
    customThemeLibraryKey, customThemeMetaKey, customThemeViewKey, emptyThemeMeta, libraryFromState, mergeThemeStates,
    parseThemeLibrary, parseThemeMeta, parseThemesPayload, restampAllThemes, sameThemeState, serializeThemeLibrary,
    serializeThemeMeta, stampThemeEdit, themeMetaFromState, type SyncThemeItem, type ThemeSyncState,
} from './customThemeSync';
import { customThemeFromBase, type CustomThemeDef } from '../theme/customTheme';
import { classifyKvKey } from '../services/backupRegistry';

const NOW = 1_800_000_000_000;
const B = NOW - 1_000_000;
const def = (name: string, accent = '#25e0c8'): CustomThemeDef => ({ ...customThemeFromBase('dark', name), colors: { ...customThemeFromBase('dark').colors, accent } });
const item = (id: string, at: number, over: Partial<SyncThemeItem> = {}): SyncThemeItem =>
    ({ id, def: def(`n-${id}`), created: over.created ?? at, at, ...over });
const S = (items: SyncThemeItem[], tombstones: Record<string, number> = {}): ThemeSyncState => ({ items, tombstones });
const ids = (s: ThemeSyncState) => s.items.map((i) => i.id);

describe('mergeThemeStates: per-theme last writer wins, with tombstones', () => {
    it('is commutative and idempotent', () => {
        const a = S([item('x', B + 10), item('y', B + 20)], { z: B + 30 });
        const b = S([item('y', B + 25, { def: def('renamed') }), item('z', B + 5)], { x: B + 15 });
        const ab = mergeThemeStates(a, b, NOW), ba = mergeThemeStates(b, a, NOW);
        expect(sameThemeState(ab, ba)).toBe(true);
        expect(mergeThemeStates(ab, b, NOW)).toBe(ab);
        expect(mergeThemeStates(ab, a, NOW)).toBe(ab);
        expect(ids(ab)).toEqual(['y']);
        expect(ab.items[0].def.name).toBe('renamed');
    });

    it('concurrent edit vs delete: the later wins, in either order', () => {
        const edited = S([{ ...item('a', B + 10), def: def('edited', '#ff8800'), at: B + 20 }]);
        const deletedLater = S([], { a: B + 30 });
        const deletedEarlier = S([], { a: B + 15 });
        expect(ids(mergeThemeStates(edited, deletedLater, NOW))).toEqual([]);
        expect(ids(mergeThemeStates(deletedLater, edited, NOW))).toEqual([]);
        expect(ids(mergeThemeStates(edited, deletedEarlier, NOW))).toEqual(['a']);
        expect(ids(mergeThemeStates(deletedEarlier, edited, NOW))).toEqual(['a']);
    });

    it('a stale device cannot resurrect a deleted theme', () => {
        const stale = S([item('a', B + 10)]);
        const merged = mergeThemeStates(stale, S([], { a: B + 50 }), NOW);
        expect(merged.items).toEqual([]);
        expect(mergeThemeStates(merged, stale, NOW)).toBe(merged);
    });

    it('exact ties are deterministic: item beats tombstone; two items by canonical content', () => {
        expect(ids(mergeThemeStates(S([item('a', B)]), S([], { a: B }), NOW))).toEqual(['a']);
        const p = S([{ ...item('a', B), def: def('a', '#111111') }]);
        const q = S([{ ...item('a', B), def: def('a', '#eeeeee') }]);
        expect(mergeThemeStates(p, q, NOW).items[0].def.colors.accent).toBe(mergeThemeStates(q, p, NOW).items[0].def.colors.accent);
    });

    it('expired tombstones are pruned; the library is capped at 24 (newest created kept)', () => {
        expect(mergeThemeStates(S([]), S([], { old: NOW - THEME_TOMBSTONE_TTL_MS - 1 }), NOW).tombstones).toEqual({});
        const many = S(Array.from({ length: 30 }, (_, i) => item(`t${i}`, B + i)));
        const m = mergeThemeStates(S([]), many, NOW);
        expect(m.items).toHaveLength(THEME_LIBRARY_MAX);
        expect(ids(m)).not.toContain('t0');
        expect(ids(m)).toContain('t29');
    });
});

describe('local stamping', () => {
    it('a local edit beats the ledger even on a clock behind; remove leaves a tombstone', () => {
        let m = stampThemeEdit(emptyThemeMeta(), 'create', 'a', B);
        m = stampThemeEdit(m, 'edit', 'a', B - 500);
        expect(m.stamps.a.at).toBe(B + 1);
        expect(m.stamps.a.created).toBe(B);
        m = stampThemeEdit(m, 'remove', 'a', B);
        expect(m.stamps.a).toBeUndefined();
        expect(m.tombstones.a).toBe(B + 2);
    });

    it('unstamped library items are old (at = 1) and keep their order; meta round-trips', () => {
        const lib = [{ id: 'a', ...def('A') }, { id: 'b', ...def('B') }];
        const s = buildLocalThemeState(lib, emptyThemeMeta());
        expect(s.items.map((i) => [i.id, i.at, i.created])).toEqual([['a', 1, 1], ['b', 1, 2]]);
        const meta = themeMetaFromState(s);
        expect(parseThemeMeta(serializeThemeMeta(meta), NOW)).toEqual(meta);
        expect(libraryFromState(s)).toEqual(lib);
    });

    it('a restore re-stamps every theme as newest and drops their tombstones', () => {
        const r = restampAllThemes(S([item('a', B)], { a: B - 1, b: B }), NOW);
        expect(r.items[0].at).toBe(NOW);
        expect(r.tombstones).toEqual({ b: B });
    });
});

describe('payload validation (what another device sends)', () => {
    it('round-trips', () => {
        const s = S([item('a', B), item('b', B + 1)], { c: B + 2 });
        expect(sameThemeState(parseThemesPayload(JSON.stringify(buildThemesPayload(s, NOW)), NOW), s)).toBe(true);
    });

    it('throws on structural problems; drops bad themes one by one (never as tombstones)', () => {
        expect(() => parseThemesPayload('x'.repeat(MAX_THEMES_PAYLOAD_BYTES + 1), NOW)).toThrow(/too large/);
        expect(() => parseThemesPayload('nope', NOW)).toThrow();
        expect(() => parseThemesPayload(JSON.stringify({ v: 2, items: [] }), NOW)).toThrow(/version/);
        const payload = {
            v: 1, writtenAt: NOW, tombstones: { 'bad id!': B },
            items: [
                { id: 'ok', theme: def('Fine'), created: B, at: B },
                { id: 'css', theme: { ...def('Evil'), colors: { ...def('Evil').colors, bg: 'url(https://x.example)' } }, created: B, at: B },
                { id: 'future', theme: def('F'), created: B, at: NOW + 10 * 24 * 3600 * 1000 },
                { id: '../../etc', theme: def('P'), created: B, at: B },
            ],
        };
        const s = parseThemesPayload(JSON.stringify(payload), NOW);
        expect(ids(s)).toEqual(['ok']);
        expect(s.tombstones).toEqual({});
    });

    it('a low-contrast synced theme arrives exactly as the other device saved it (no readability adjustment)', () => {
        const low = { ...def('Low'), colors: { ...def('Low').colors, text: '#141a2e' } };
        const s = parseThemesPayload(JSON.stringify({ v: 1, items: [{ id: 'a', theme: low, created: B, at: B }], tombstones: {} }), NOW);
        expect(s.items[0].def.colors).toEqual(low.colors);
    });

    it('received colours are still re-validated: a non-colour value is refused', () => {
        const bad = { ...def('Bad'), colors: { ...def('Bad').colors, text: 'url(https://evil.example/x)' } };
        const s = parseThemesPayload(JSON.stringify({ v: 1, items: [{ id: 'a', theme: bad, created: B, at: B }], tombstones: {} }), NOW);
        expect(s.items).toEqual([]);
    });
});

describe('library record + backups', () => {
    it('the library re-validates on read and drops garbage', () => {
        const raw = serializeThemeLibrary([{ id: 'a', ...def('A') }]);
        expect(parseThemeLibrary(raw).map((t) => t.name)).toEqual(['A']);
        expect(parseThemeLibrary('{"items":[{"id":"x","v":1,"base":"dark","colors":{"bg":"var(--x)"}}]}')).toEqual([]);
        expect(parseThemeLibrary('not json')).toEqual([]);
    });

    it('the library and its stamps are backed up; the sync view is device-local', () => {
        expect(THEMES_SLOT).toBe('themes');
        expect(classifyKvKey(customThemeLibraryKey('u1'), 'u1')).toBe('include');
        expect(classifyKvKey(customThemeMetaKey('u1'), 'u1')).toBe('include');
        expect(classifyKvKey(customThemeViewKey('u1'), 'u1')).toBe('exclude');
        // positive control: an unknown neighbour is not silently classified
        expect(classifyKvKey('cipherline_custom_themez_u1', 'u1')).toBe('unknown');
    });
});
