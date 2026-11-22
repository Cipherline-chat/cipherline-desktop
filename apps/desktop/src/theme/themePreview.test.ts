/**
 * Live theme preview (engine.ts startThemePreview / stopThemePreview, the
 * bottom-left bar's Save / Save and use in themePreviewActions.ts).
 *
 * The contract: a preview shows a theme on the whole app and STORES NOTHING
 * (no theme:set / theme:set-custom, no active-theme mirror write, no library or
 * sync write), so a reload / restart comes back in the real theme; Stop puts
 * back exactly what the device would show now; a user's theme choice ends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const kv = new Map<string, string>();
const writes: string[] = [];
vi.mock('../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { writes.push(k); kv.set(k, v); },
        removeItem: (k: string) => { writes.push(`-${k}`); kv.delete(k); },
        isAccountReady: () => true,
        keys: () => [...kv.keys()],
        whenAccountReady: () => Promise.resolve(),
    },
}));
vi.mock('../services/ownSlotEnv', () => ({ createOwnSlotEnv: () => ({}) }));

import {
    PREVIEW_THEME_ID, THEME_STYLE_ID, __resetThemeForTests, bootTheme, getActiveCustomThemeId, getTheme, getThemePreference,
    getThemePreview, realTheme, setCustomTheme, setThemePreference, startThemePreview, stopThemePreview, subscribeThemePreview,
    type ThemeHost,
} from './engine';
import { activeThemeMirrorKey, chooseBuiltinTheme, chooseCustomTheme } from './activeThemeMirror';
import { CUSTOM_THEME_USER_EDIT_EVENT, readCustomThemes, reconcileActiveCustomTheme } from './customThemeLibrary';
import { saveAndUsePreviewedTheme, savePreviewedTheme, savedEntryFor } from './themePreviewActions';
import { CUSTOM_THEME_PRESETS } from './customPresets';
import { deriveCustomTheme, normalizeCustomTheme, type CustomThemeBootPayload, type CustomThemeDef } from './customTheme';
import { customThemeLibraryKey, serializeThemeLibrary } from '../utils/customThemeSync';
import { THEMES } from './themes';

const UID = 'user-1';
const preset = (k: string): CustomThemeDef => CUSTOM_THEME_PRESETS.find((p) => p.key === k)!.def;
const rose = preset('rose');
const ocean = preset('ocean');

/** A fake main process: what it STORES (theme:set / theme:set-custom) and what it PAINTS. */
function fakeMain() {
    const calls: string[] = [];
    let stored: { id: string; pref: string; custom?: CustomThemeBootPayload } = { id: 'dark', pref: 'dark' };
    let pushed: ((s: { id: string; pref?: string; custom?: unknown }) => void) | null = null;
    const host: ThemeHost = {
        getTheme: async () => { calls.push('get'); return stored; },
        setTheme: async (pref) => { calls.push(`set:${pref}`); stored = { id: pref === 'system' ? 'dark' : pref, pref }; return stored; },
        setCustomTheme: async (p) => { calls.push(`set-custom:${p.id}`); stored = { id: p.theme.base, pref: 'custom', custom: p }; return stored; },
        previewTheme: async (p) => { calls.push(`preview:${p.id}`); return true; },
        endThemePreview: async () => { calls.push('preview-end'); return true; },
        onThemeChanged: (cb) => { pushed = cb; return () => { pushed = null; }; },
    };
    return {
        host, calls,
        stored: () => stored,
        push: (s: { id: string; pref?: string; custom?: unknown }) => pushed?.(s),
        /** What the preload hands a freshly (re)loaded page. */
        bootAnswer: (): ThemeHost => ({ ...host, bootThemeId: stored.id, bootCustomTheme: stored.custom }),
        persistCalls: () => calls.filter((c) => c.startsWith('set')),
    };
}

function fakeDom() {
    const byId = new Map<string, { id: string; textContent: string }>();
    const attrs: Record<string, string> = {};
    const doc = {
        documentElement: {
            setAttribute: (k: string, v: string) => { attrs[k] = v; },
            removeAttribute: (k: string) => { delete attrs[k]; },
        },
        head: { appendChild: (el: { id: string; textContent: string }) => { byId.set(el.id, el); } },
        getElementById: (id: string) => byId.get(id) ?? null,
        createElement: () => ({ id: '', textContent: '' }),
    };
    return { doc, byId, attrs };
}

const g = globalThis as unknown as { document: unknown; window: unknown; CustomEvent: unknown };
let savedDoc: unknown;
let savedWin: unknown;
let dom: ReturnType<typeof fakeDom>;
let main: ReturnType<typeof fakeMain>;
let events: string[];

function seedLibrary(items: { id: string; def: CustomThemeDef }[]) {
    kv.set(customThemeLibraryKey(UID), serializeThemeLibrary(items.map((i) => ({ id: i.id, ...i.def }))));
}
const css = () => dom.byId.get(THEME_STYLE_ID)?.textContent ?? '';

beforeEach(() => {
    __resetThemeForTests();
    kv.clear();
    writes.length = 0;
    savedDoc = g.document;
    savedWin = g.window;
    dom = fakeDom();
    g.document = dom.doc;
    main = fakeMain();
    events = [];
    // The window the engine / library / mirror reach for: the host bridge plus an event log.
    g.window = {
        electronAPI: main.host,
        dispatchEvent: (e: { type: string }) => { events.push(e.type); return true; },
        addEventListener: () => {},
        removeEventListener: () => {},
    };
});
afterEach(() => { g.document = savedDoc; g.window = savedWin; });

describe('a preview never persists', () => {
    it('start, replace and stop: no theme:set / theme:set-custom, no store write, no library edit or sync event', async () => {
        await chooseBuiltinTheme(UID, 'light');
        main.calls.length = 0;
        writes.length = 0;
        events.length = 0;
        startThemePreview(rose);
        startThemePreview(ocean);
        stopThemePreview();
        expect(main.persistCalls()).toEqual([]);
        expect(writes).toEqual([]);
        expect(events).not.toContain(CUSTOM_THEME_USER_EDIT_EVENT);
        expect(events).not.toContain('cipherline:custom-themes-changed');
        // Main was only asked to paint (theme:preview, which stores nothing) and to put the real colours back.
        expect(main.calls).toEqual([`preview:${PREVIEW_THEME_ID}`, `preview:${PREVIEW_THEME_ID}`, 'preview-end']);
        expect(main.stored()).toEqual({ id: 'light', pref: 'light' });
    });

    it('the theme is on the whole app while previewing (engine CSS + data attributes), the preference is untouched', () => {
        startThemePreview(ocean);
        expect(getTheme().palette.abyss).toBe(ocean.colors.bg);
        expect(dom.attrs['data-custom-theme']).toBe(PREVIEW_THEME_ID);
        expect(dom.attrs['data-theme']).toBe(ocean.base);
        expect(css().toLowerCase()).toContain(ocean.colors.bg.toLowerCase());
        expect(getThemePreference()).toBe('dark');
        expect(getActiveCustomThemeId()).toBeNull();
        expect(realTheme()).toBe(THEMES.dark);
    });

    it('a reload / restart boots in the real theme, never the previewed one', async () => {
        await chooseCustomTheme(UID, 'mine', rose);
        startThemePreview(ocean);
        expect(getTheme().palette.abyss).toBe(ocean.colors.bg);
        // The page reloads: module state is gone, the preload answers from main's store.
        __resetThemeForTests();
        const id = await bootTheme(main.bootAnswer());
        expect(getThemePreview()).toBeNull();
        expect(getTheme().customId).toBe('mine');
        expect(getTheme().palette.abyss).toBe(rose.colors.bg);
        expect(id).toBe(rose.base);
        expect(main.stored().pref).toBe('custom');
        expect(main.stored().custom?.id).toBe('mine');
    });
});

describe('Stop restores exactly the previous theme', () => {
    for (const pref of ['dark', 'light', 'midnight', 'hc-dark', 'hc-light'] as const) {
        it(`built-in ${pref}`, async () => {
            await chooseBuiltinTheme(UID, pref);
            const before = getTheme();
            const attrs = { ...dom.attrs };
            const beforeCss = css();
            startThemePreview(rose);
            expect(getTheme()).not.toBe(before);
            stopThemePreview();
            expect(getTheme()).toBe(before);
            expect(dom.attrs).toEqual(attrs);
            expect(css()).toBe(beforeCss);
            expect(getThemePreference()).toBe(pref);
        });
    }

    it('Sync with system', async () => {
        await chooseBuiltinTheme(UID, 'system');
        const before = getTheme();
        startThemePreview(ocean);
        stopThemePreview();
        expect(getThemePreference()).toBe('system');
        expect(getTheme()).toBe(before);
    });

    it('a custom theme (same derived theme object: no re-derive, no flash)', async () => {
        await chooseCustomTheme(UID, 'mine', ocean);
        const before = getTheme();
        const attrs = { ...dom.attrs };
        startThemePreview(rose);
        stopThemePreview();
        expect(getTheme()).toBe(before);
        expect(dom.attrs).toEqual(attrs);
        expect(getActiveCustomThemeId()).toBe('mine');
    });

    it('on Sync with system, an OS flip DURING the preview is what Stop shows (main\'s push lands behind the preview)', async () => {
        await bootTheme(main.host);
        await setThemePreference('system', main.host);
        startThemePreview(rose);
        main.push({ id: 'light', pref: 'system' });
        expect(getTheme().palette.abyss).toBe(rose.colors.bg);
        stopThemePreview();
        expect(getTheme()).toBe(THEMES.light);
    });

    it('a synced edit of the active custom theme during the preview does not end it, and Stop shows the edit', async () => {
        seedLibrary([{ id: 'mine', def: ocean }]);
        await chooseCustomTheme(UID, 'mine', ocean);
        startThemePreview(rose);
        const edited = { ...ocean, colors: { ...ocean.colors, accent: '#33aaff' } };
        seedLibrary([{ id: 'mine', def: edited }]);
        reconcileActiveCustomTheme(UID);
        expect(getThemePreview()).not.toBeNull();
        expect(getTheme().palette.abyss).toBe(rose.colors.bg);
        stopThemePreview();
        expect(getActiveCustomThemeId()).toBe('mine');
        const want = normalizeCustomTheme(edited);
        expect(want.ok).toBe(true);
        expect(getTheme().palette.lume).toBe(deriveCustomTheme((want as { def: CustomThemeDef }).def, 'mine').palette.lume);
        expect(getTheme().palette.lume).not.toBe(deriveCustomTheme(ocean, 'mine').palette.lume);
    });

    it('stop with no preview is a no-op (no repaint, no host call)', () => {
        const before = getTheme();
        stopThemePreview();
        expect(getTheme()).toBe(before);
        expect(main.calls).toEqual([]);
    });
});

describe('starting a second preview replaces the first', () => {
    it('the new theme shows, the seq moves on, and Stop still goes back to the REAL theme', async () => {
        await chooseBuiltinTheme(UID, 'midnight');
        const real = getTheme();
        let notified = 0;
        const off = subscribeThemePreview(() => { notified++; });
        startThemePreview(rose);
        const first = getThemePreview()!;
        startThemePreview(ocean, { libraryId: 'lib-ocean' });
        const second = getThemePreview()!;
        expect(second.seq).toBeGreaterThan(first.seq);
        expect(second.def).toBe(ocean);
        expect(second.libraryId).toBe('lib-ocean');
        expect(getTheme().customId).toBe('lib-ocean');
        expect(getTheme().palette.abyss).toBe(ocean.colors.bg);
        stopThemePreview();
        expect(getTheme()).toBe(real);
        expect(notified).toBe(3);
        off();
    });
});

describe('a theme choice in Settings ends the preview', () => {
    it('picking a built-in tile', async () => {
        startThemePreview(rose);
        await chooseBuiltinTheme(UID, 'light');
        expect(getThemePreview()).toBeNull();
        expect(getTheme()).toBe(THEMES.light);
        expect(main.stored()).toEqual({ id: 'light', pref: 'light' });
        expect(JSON.parse(kv.get(activeThemeMirrorKey(UID))!)).toEqual({ kind: 'builtin', id: 'light' });
        // The preview's paint was dropped before the real one was stored.
        expect(main.calls.slice(-2)).toEqual(['preview-end', 'set:light']);
    });

    it('picking a custom tile', async () => {
        startThemePreview(rose);
        await chooseCustomTheme(UID, 'mine', ocean);
        expect(getThemePreview()).toBeNull();
        expect(getActiveCustomThemeId()).toBe('mine');
        expect(getTheme().palette.abyss).toBe(ocean.colors.bg);
    });

    it('positive control: a plain engine setter (sync / restore, not a user choice) keeps the preview up', async () => {
        startThemePreview(rose);
        await setThemePreference('light', main.host);
        expect(getThemePreview()).not.toBeNull();
        expect(getTheme().palette.abyss).toBe(rose.colors.bg);
        await setCustomTheme('x', ocean, main.host);
        expect(getThemePreview()).not.toBeNull();
        stopThemePreview();
        expect(getActiveCustomThemeId()).toBe('x');
    });
});

describe('Save vs Save and use', () => {
    it('Save adds it to Your themes once and keeps previewing; nothing about the device theme changes', async () => {
        await chooseBuiltinTheme(UID, 'dark');
        main.calls.length = 0;
        startThemePreview(ocean);
        const r = savePreviewedTheme(UID);
        expect(r.ok && r.created).toBe(true);
        expect(readCustomThemes(UID).map((t) => t.name)).toEqual([ocean.name]);
        expect(getThemePreview()).not.toBeNull();
        expect(events).toContain(CUSTOM_THEME_USER_EDIT_EVENT);
        expect(main.persistCalls()).toEqual([]);
        expect(JSON.parse(kv.get(activeThemeMirrorKey(UID))!)).toEqual({ kind: 'builtin', id: 'dark' });
        // Again: already saved (same look), no duplicate.
        const again = savePreviewedTheme(UID);
        expect(again.ok && !again.created).toBe(true);
        expect(readCustomThemes(UID)).toHaveLength(1);
        expect(savedEntryFor(getThemePreview(), readCustomThemes(UID))?.name).toBe(ocean.name);
        stopThemePreview();
        expect(getTheme()).toBe(THEMES.dark);
    });

    it('Save and use makes it the real theme the normal way (main store + mirror) and closes the preview', async () => {
        startThemePreview(rose);
        const r = await saveAndUsePreviewedTheme(UID);
        expect(r.ok).toBe(true);
        const entry = readCustomThemes(UID)[0];
        expect(entry.name).toBe(rose.name);
        expect(getThemePreview()).toBeNull();
        expect(getActiveCustomThemeId()).toBe(entry.id);
        expect(main.stored().pref).toBe('custom');
        expect(main.stored().custom?.id).toBe(entry.id);
        expect(JSON.parse(kv.get(activeThemeMirrorKey(UID))!).id).toBe(entry.id);
        // A restart now boots in it.
        __resetThemeForTests();
        await bootTheme(main.bootAnswer());
        expect(getActiveCustomThemeId()).toBe(entry.id);
    });

    it('Save and use of a tile preview (already in the library) does not duplicate it', async () => {
        seedLibrary([{ id: 'lib-1', def: ocean }]);
        startThemePreview(ocean, { libraryId: 'lib-1' });
        await saveAndUsePreviewedTheme(UID);
        expect(readCustomThemes(UID)).toHaveLength(1);
        expect(getActiveCustomThemeId()).toBe('lib-1');
    });

    it('a refused save (no account) changes nothing and keeps previewing', async () => {
        startThemePreview(ocean);
        expect(savePreviewedTheme(null)).toEqual({ ok: false });
        expect(await saveAndUsePreviewedTheme(null)).toEqual({ ok: false });
        expect(getThemePreview()).not.toBeNull();
        expect(main.persistCalls()).toEqual([]);
    });
});

describe('the bar (source checks)', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'themeShare', 'ThemePreviewBar.tsx'), 'utf8');
    it('Escape goes through the shared Esc stack, never a raw key listener', () => {
        expect(src).toMatch(/useEscape\(\(\) => \{ stop\(\); \}, !!p\)/);
        expect(src).not.toMatch(/addEventListener\(\s*['"]key/);
        expect(src).not.toMatch(/onKeyDown/);
    });
    it('claims Escape from the close-panel keybind while previewing, so one press is one step (Settings stays open)', () => {
        expect(src).toContain("useEffect(() => (previewing ? claimKeyCombo('escape') : undefined), [previewing]);");
    });
    it('announces the preview and says how to stop it; focus moves to the bar', () => {
        expect(src).toContain('Previewing theme ${name}. Press Escape to stop.');
        expect(src).toContain('aria-live="polite"');
        expect(src).toMatch(/bar\?\.focus\(/);
        expect(src).toContain('ariaLabel="Stop previewing"');
    });
    it('the preview cannot outlive the bar (sign-out)', () => {
        expect(src).toContain('useEffect(() => () => { stopThemePreview(); }, []);');
    });
    it('the entry points start a preview instead of a dialog-only mini preview', () => {
        const read = (...p: string[]) => readFileSync(join(__dirname, '..', 'components', ...p), 'utf8');
        expect(read('themeShare', 'ThemeLinkEmbed.tsx')).toContain('startThemePreview(def');
        expect(read('settings', 'panes', 'CustomThemeShareDialog.tsx')).toContain('startThemePreview(parsed.def)');
        expect(read('settings', 'panes', 'CustomThemes.tsx')).toContain('startThemePreview(stripId(t), { libraryId: t.id })');
        expect(read('settings', 'panes', 'ThemePicker.tsx')).toContain('<ThemePreviewNotice />');
        expect(read('Dashboard.tsx')).toContain('<ThemePreviewBar />');
    });
    it('Save and use from a chat card / deep link goes the normal way (mirror too), never the bare engine setter', () => {
        const read = (...p: string[]) => readFileSync(join(__dirname, '..', 'components', ...p), 'utf8');
        for (const f of ['ThemeLinkEmbed.tsx', 'ThemeDeepLinkHost.tsx']) {
            const s = read('themeShare', f);
            expect(s, f).toContain('chooseCustomTheme(uid');
            expect(s, f).not.toMatch(/\bsetCustomTheme\(/);
        }
    });
});
