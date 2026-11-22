import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, string>();
const writes: string[] = [];
let ready = true;
vi.mock('../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { writes.push(k); kv.set(k, v); },
        removeItem: (k: string) => { kv.delete(k); },
        isAccountReady: () => ready,
        keys: () => [...kv.keys()],
        whenAccountReady: () => Promise.resolve(),
    },
}));

vi.mock('../services/ownSlotEnv', () => ({ createOwnSlotEnv: () => ({}) }));

import {
    activeThemeMirrorKey, chooseBuiltinTheme, chooseCustomTheme, parseActiveThemeMirror, readActiveThemeMirror,
} from './activeThemeMirror';
import { applyRestoredActiveTheme, takeRestoredThemeName } from './restoreActiveTheme';
import { reconcileActiveCustomTheme, readCustomThemes } from './customThemeLibrary';
import {
    __resetThemeForTests, getActiveCustomThemeId, getTheme, getThemePreference, setCustomTheme, setThemePreference,
} from './engine';
import { CUSTOM_THEME_PRESETS } from './customPresets';
import { KV_RULES, classifyKvKey, collectIncludedKv, applyIncludedKv } from '../services/backupRegistry';
import { loadLocalCustomThemeState, saveCustomThemeState } from '../services/customThemeSyncEnv';
import { buildThemesPayload, customThemeLibraryKey, mergeThemeStates, serializeThemeLibrary, type ThemeSyncState } from '../utils/customThemeSync';

const UID = 'user-1';
const rose = CUSTOM_THEME_PRESETS.find((p) => p.key === 'rose')!.def;
const ocean = CUSTOM_THEME_PRESETS.find((p) => p.key === 'ocean')!.def;
const KEY = activeThemeMirrorKey(UID);

function seedLibrary(items: { id: string; def: typeof rose }[]) {
    kv.set(customThemeLibraryKey(UID), serializeThemeLibrary(items.map((i) => ({ id: i.id, ...i.def }))));
}

function fakeDom() {
    const byId = new Map<string, { id: string; textContent: string }>();
    return {
        documentElement: { setAttribute: () => undefined, removeAttribute: () => undefined },
        head: { appendChild: (el: { id: string; textContent: string }) => { byId.set(el.id, el); } },
        getElementById: (id: string) => byId.get(id) ?? null,
        createElement: () => ({ id: '', textContent: '' }),
    };
}
const g = globalThis as unknown as { document: unknown };
let savedDoc: unknown;
beforeEach(() => { kv.clear(); writes.length = 0; ready = true; __resetThemeForTests(); savedDoc = g.document; g.document = fakeDom(); });
afterEach(() => { g.document = savedDoc; });

describe('active theme mirror: written only on user actions', () => {
    it('a user pick of a built-in / Sync with system writes it', async () => {
        await chooseBuiltinTheme(UID, 'light');
        expect(readActiveThemeMirror(UID)).toEqual({ kind: 'builtin', id: 'light' });
        await chooseBuiltinTheme(UID, 'system');
        expect(readActiveThemeMirror(UID)).toEqual({ kind: 'builtin', id: 'system' });
    });

    it('a user pick of a custom theme writes the id AND a normalised snapshot', async () => {
        await chooseCustomTheme(UID, 't1', rose);
        const m = readActiveThemeMirror(UID);
        expect(m?.kind).toBe('custom');
        expect(m && m.kind === 'custom' && m.snapshot?.colors.bg).toBe(rose.colors.bg);
        expect(getActiveCustomThemeId()).toBe('t1');
    });

    it('does not write on a cold account store (positive control: it does once ready)', async () => {
        ready = false;
        await chooseBuiltinTheme(UID, 'light');
        expect(kv.has(KEY)).toBe(false);
        expect(getThemePreference()).toBe('light'); // the device still switches
        ready = true;
        await chooseBuiltinTheme(UID, 'light');
        expect(kv.has(KEY)).toBe(true);
    });

    it('engine boot / hydrate / reconcile paths never write the mirror', async () => {
        seedLibrary([{ id: 't1', def: rose }]);
        await setCustomTheme('t1', rose);          // the engine alone (boot payload path)
        reconcileActiveCustomTheme(UID);
        await setThemePreference('dark');
        expect(writes.filter((k) => k === KEY)).toHaveLength(0);
    });
});

describe('registry + backup + sync classification', () => {
    it('is classified include, and the backup collects it (and restores it through applyIncludedKv)', () => {
        expect(classifyKvKey(KEY, UID)).toBe('include');
        expect(KV_RULES.find((r) => r.pattern === 'cipherline_active_theme_{uid}')?.include).toBe(true);
        kv.set(KEY, JSON.stringify({ kind: 'builtin', id: 'light' }));
        const out = collectIncludedKv({ getItem: (k: string) => kv.get(k) ?? null, keysWithPrefix: (p: string) => [...kv.keys()].filter((k: string) => k.startsWith(p)) } as never, UID);
        expect(out['cipherline_active_theme_{uid}']).toContain('light');
        // control: an unclassified neighbour is not collected
        kv.set(`cipherline_unknown_thing_${UID}`, 'x');
        expect(Object.keys(collectIncludedKv({ getItem: (k: string) => kv.get(k) ?? null, keysWithPrefix: (p: string) => [...kv.keys()].filter((k: string) => k.startsWith(p)) } as never, UID)))
            .not.toContain('cipherline_unknown_thing_{uid}');
        const target = new Map<string, string>();
        applyIncludedKv({ setItem: (k: string, v: string) => { target.set(k, v); }, getItem: () => null, removeItem: () => undefined, keys: () => [] } as never, out, UID);
        expect(target.get(KEY)).toContain('light');
    });

    it('the themes SYNC state/payload carries only the library, never the active choice', async () => {
        await chooseCustomTheme(UID, 't1', rose);
        seedLibrary([{ id: 't1', def: rose }]);
        const state = loadLocalCustomThemeState(UID);
        expect(Object.keys(state).sort()).toEqual(['items', 'tombstones']);
        const json = JSON.stringify(buildThemesPayload(state, Date.now()));
        expect(Object.keys(JSON.parse(json)).sort()).toEqual(['items', 'tombstones', 'v', 'writtenAt']);
        expect(json).not.toContain('active');
        expect(json).not.toContain('snapshot');
        // positive control: the library item IS in it
        expect(json).toContain('"t1"');
    });
});

describe('sync never changes which theme a device uses', () => {
    const NOW = Date.now();
    const state = (items: { id: string; def: typeof rose; at: number }[], tombstones: Record<string, number> = {}): ThemeSyncState =>
        ({ items: items.map((i) => ({ id: i.id, def: i.def, created: i.at, at: i.at })), tombstones });

    it('a merge that adds other themes leaves a built-in device choice and the mirror alone', async () => {
        await chooseBuiltinTheme(UID, 'light');
        const before = kv.get(KEY);
        const merged = mergeThemeStates(loadLocalCustomThemeState(UID), state([{ id: 'x', def: ocean, at: NOW }]), NOW);
        expect(saveCustomThemeState(UID, merged)).toBe(true);
        reconcileActiveCustomTheme(UID);
        expect(getThemePreference()).toBe('light');
        expect(getTheme().id).toBe('light');
        expect(kv.get(KEY)).toBe(before);
        expect(readCustomThemes(UID).map((t) => t.id)).toEqual(['x']);
    });

    it('the active custom theme edited on another device: same id, new COLOURS, no switch', async () => {
        seedLibrary([{ id: 't1', def: rose }]);
        await chooseCustomTheme(UID, 't1', rose);
        const merged = mergeThemeStates(loadLocalCustomThemeState(UID), state([{ id: 't1', def: ocean, at: NOW + 5_000 }]), NOW + 5_000);
        saveCustomThemeState(UID, merged);
        reconcileActiveCustomTheme(UID);
        expect(getActiveCustomThemeId()).toBe('t1');
        expect(getTheme().palette.abyss).toBe(ocean.colors.bg);
        expect(getTheme().palette.abyss).not.toBe(rose.colors.bg);
    });

    it('the active custom theme deleted on another device: this device keeps its last copy', async () => {
        seedLibrary([{ id: 't1', def: rose }]);
        await chooseCustomTheme(UID, 't1', rose);
        const merged = mergeThemeStates(loadLocalCustomThemeState(UID), state([], { t1: NOW + 5_000 }), NOW + 5_000);
        saveCustomThemeState(UID, merged);
        expect(readCustomThemes(UID)).toHaveLength(0); // control: it really is gone from the library
        reconcileActiveCustomTheme(UID);
        expect(getActiveCustomThemeId()).toBe('t1');
        expect(getTheme().palette.abyss).toBe(rose.colors.bg);
        expect(getThemePreference()).toBe('custom');
    });

    it('deleting the theme in use HERE (a user action) falls back to its base and updates the mirror', async () => {
        seedLibrary([{ id: 't1', def: rose }]);
        await chooseCustomTheme(UID, 't1', rose);
        saveCustomThemeState(UID, state([], { t1: NOW }));
        reconcileActiveCustomTheme(UID, { onMissing: 'builtin' });
        expect(getActiveCustomThemeId()).toBeNull();
        expect(readActiveThemeMirror(UID)).toEqual({ kind: 'builtin', id: rose.base });
    });
});

describe('restore applies the backed-up theme on this device', () => {
    it('builtin: applied and named', async () => {
        kv.set(KEY, JSON.stringify({ kind: 'builtin', id: 'light' }));
        expect(await applyRestoredActiveTheme(UID)).toBe('Light');
        expect(getThemePreference()).toBe('light');
        expect(takeRestoredThemeName()).toBe('Light');
        expect(takeRestoredThemeName()).toBeNull();
    });

    it('custom with the library entry present: applies it (library colours win)', async () => {
        seedLibrary([{ id: 't1', def: ocean }]);
        kv.set(KEY, JSON.stringify({ kind: 'custom', id: 't1', snapshot: rose }));
        expect(await applyRestoredActiveTheme(UID)).toBe(ocean.name);
        expect(getTheme().palette.abyss).toBe(ocean.colors.bg);
    });

    it('custom with the library entry GONE: the snapshot is used', async () => {
        kv.set(KEY, JSON.stringify({ kind: 'custom', id: 't1', snapshot: rose }));
        expect(readCustomThemes(UID)).toHaveLength(0);
        expect(await applyRestoredActiveTheme(UID)).toBe(rose.name);
        expect(getActiveCustomThemeId()).toBe('t1');
        expect(getTheme().palette.abyss).toBe(rose.colors.bg);
    });

    it('invalid snapshot: falls back to the restored library entry', async () => {
        seedLibrary([{ id: 't1', def: ocean }]);
        kv.set(KEY, JSON.stringify({ kind: 'custom', id: 't1', snapshot: { colors: { bg: 'not-a-colour' } } }));
        expect(await applyRestoredActiveTheme(UID)).toBe(ocean.name);
        expect(getActiveCustomThemeId()).toBe('t1');
    });

    it('invalid snapshot and no library entry: Dark, and the mirror is corrected', async () => {
        await setThemePreference('light');
        kv.set(KEY, JSON.stringify({ kind: 'custom', id: 't1', snapshot: 'garbage' }));
        expect(await applyRestoredActiveTheme(UID)).toBe('Dark');
        expect(getThemePreference()).toBe('dark');
        expect(readActiveThemeMirror(UID)).toEqual({ kind: 'builtin', id: 'dark' });
    });

    it('a backup with no theme choice (older build) leaves this device alone', async () => {
        await setThemePreference('light');
        expect(await applyRestoredActiveTheme(UID)).toBeNull();
        expect(getThemePreference()).toBe('light');
    });

    it('a crafted mirror (bad kind / unsafe id / unknown builtin) is rejected by the parser', () => {
        expect(parseActiveThemeMirror('{"kind":"builtin","id":"neon"}')).toBeNull();
        expect(parseActiveThemeMirror('{"kind":"custom","id":"../x","snapshot":{}}')).toBeNull();
        expect(parseActiveThemeMirror('{"kind":"other"}')).toBeNull();
        expect(parseActiveThemeMirror('not json')).toBeNull();
        expect(parseActiveThemeMirror('{"kind":"builtin","id":"dark"}')).toEqual({ kind: 'builtin', id: 'dark' }); // control
    });
});

describe('Midnight / High contrast in the mirror and in restore (themes-merge)', () => {
    const NAMES = { midnight: 'Midnight', 'hc-dark': 'High contrast dark', 'hc-light': 'High contrast light', system: 'Sync with system' } as const;

    it('every new built-in (and Sync with system) is mirrored on a pick and restored by name', async () => {
        for (const id of ['midnight', 'hc-dark', 'hc-light', 'system'] as const) {
            await chooseBuiltinTheme(UID, id);
            expect(readActiveThemeMirror(UID)).toEqual({ kind: 'builtin', id });
            await setThemePreference('dark');
            expect(await applyRestoredActiveTheme(UID)).toBe(NAMES[id]);
            expect(getThemePreference()).toBe(id);
            expect(getActiveCustomThemeId()).toBeNull();
        }
    });

    it('custom -> High contrast -> restore of a custom backup puts the custom theme back', async () => {
        await chooseCustomTheme(UID, 't1', ocean);
        const backup = kv.get(KEY)!;
        await chooseBuiltinTheme(UID, 'hc-dark');
        expect(readActiveThemeMirror(UID)).toEqual({ kind: 'builtin', id: 'hc-dark' });
        kv.set(KEY, backup);
        expect(await applyRestoredActiveTheme(UID)).toBe(ocean.name);
        expect(getActiveCustomThemeId()).toBe('t1');
        expect(getTheme().contrast).toBeUndefined();
    });
});
