import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    THEME_CHANGE_EVENT, THEME_STYLE_ID, __resetThemeForTests, applyTheme, bootTheme, getTheme, getThemeColors,
    resolveThemePreference, subscribeTheme, systemPrefersMoreContrast, themeColor,
} from './engine';
import { DARK_THEME, HC_DARK_THEME, HC_LIGHT_THEME, LIGHT_THEME, MIDNIGHT_THEME, themeCssText, type Theme } from './themes';

/** A minimal document: getElementById / createElement / head.appendChild / documentElement attributes. */
function fakeDom() {
    const byId = new Map<string, { id: string; textContent: string }>();
    const attrs: Record<string, string> = {};
    const doc = {
        documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; }, removeAttribute: (k: string) => { delete attrs[k]; } },
        head: { appendChild: (el: { id: string; textContent: string }) => { byId.set(el.id, el); } },
        getElementById: (id: string) => byId.get(id) ?? null,
        createElement: () => ({ id: '', textContent: '' }),
    };
    return { doc, byId, attrs };
}

const g = globalThis as unknown as { document: unknown; window: { dispatchEvent?: (e: Event) => boolean; electronAPI?: unknown } };
let savedDoc: unknown;
let dom: ReturnType<typeof fakeDom>;
const events: Array<CustomEvent<{ theme: Theme }>> = [];

beforeEach(() => {
    __resetThemeForTests();
    savedDoc = g.document;
    dom = fakeDom();
    g.document = dom.doc;
    events.length = 0;
    g.window.dispatchEvent = (e: Event) => { if (e.type === THEME_CHANGE_EVENT) events.push(e as CustomEvent<{ theme: Theme }>); return true; };
});
afterEach(() => {
    g.document = savedDoc;
    delete g.window.dispatchEvent;
    vi.useRealTimers();
});

describe('applyTheme', () => {
    it('writes one <style id="cl-theme"> with the theme rule and sets data-theme on <html>', () => {
        applyTheme(DARK_THEME);
        applyTheme(DARK_THEME);
        expect(dom.byId.size).toBe(1);
        expect(dom.byId.get(THEME_STYLE_ID)!.textContent).toBe(themeCssText(DARK_THEME));
        expect(dom.attrs['data-theme']).toBe('dark');
    });

    it('marks the scheme (light kind rules) and high contrast on <html>, and clears contrast again', () => {
        applyTheme(HC_LIGHT_THEME);
        expect(dom.attrs).toMatchObject({ 'data-theme': 'hc-light', 'data-scheme': 'light', 'data-contrast': 'high' });
        applyTheme(MIDNIGHT_THEME);
        expect(dom.attrs).toMatchObject({ 'data-theme': 'midnight', 'data-scheme': 'dark' });
        expect(dom.attrs['data-contrast']).toBeUndefined();
        applyTheme(HC_DARK_THEME);
        expect(dom.attrs).toMatchObject({ 'data-scheme': 'dark', 'data-contrast': 'high' });
        applyTheme(LIGHT_THEME);
        expect(dom.attrs).toMatchObject({ 'data-theme': 'light', 'data-scheme': 'light' });
        expect(dom.attrs['data-contrast']).toBeUndefined();
    });

    it('notifies subscribers and fires `themechange` only when the theme changes', () => {
        const seen: string[] = [];
        const off = subscribeTheme(() => seen.push(getTheme().id));
        applyTheme(DARK_THEME); // same object: no change
        expect(seen).toEqual([]);
        expect(events).toHaveLength(0);
        const variant: Theme = { ...DARK_THEME, palette: { ...DARK_THEME.palette, lume: '#000000' } };
        applyTheme(variant);
        expect(seen).toEqual(['dark']);
        expect(events).toHaveLength(1);
        expect(events[0].detail.theme).toBe(variant);
        expect(themeColor('lume')).toBe('#000000');
        off();
        applyTheme(DARK_THEME);
        expect(seen).toEqual(['dark']);
    });

    it('works with no DOM (node / workers): state still moves', () => {
        g.document = undefined;
        const variant: Theme = { ...DARK_THEME, palette: { ...DARK_THEME.palette, deep: '#111111' } };
        expect(() => applyTheme(variant)).not.toThrow();
        expect(getTheme()).toBe(variant);
    });
});

describe('themeColor', () => {
    it('returns the resolved hex, or rgba() with an alpha', () => {
        expect(themeColor('lume')).toBe('#25E0C8');
        expect(themeColor('lume', 0.22)).toBe('rgba(37,224,200,0.22)');
        expect(themeColor('deep', 1)).toBe('#131A30');
        expect(getThemeColors().abyss).toBe('#0B0F1E');
    });
});

describe('bootTheme', () => {
    it('applies Dark synchronously, before the host answers', () => {
        void bootTheme({ getTheme: () => new Promise(() => {}) }, 10_000);
        expect(dom.attrs['data-theme']).toBe('dark');
    });

    it('marks the scheme (light kind rules) and high contrast on <html>, and clears contrast again', () => {
        applyTheme(HC_LIGHT_THEME);
        expect(dom.attrs).toMatchObject({ 'data-theme': 'hc-light', 'data-scheme': 'light', 'data-contrast': 'high' });
        applyTheme(MIDNIGHT_THEME);
        expect(dom.attrs).toMatchObject({ 'data-theme': 'midnight', 'data-scheme': 'dark' });
        expect(dom.attrs['data-contrast']).toBeUndefined();
        applyTheme(HC_DARK_THEME);
        expect(dom.attrs).toMatchObject({ 'data-scheme': 'dark', 'data-contrast': 'high' });
        applyTheme(LIGHT_THEME);
        expect(dom.attrs).toMatchObject({ 'data-theme': 'light', 'data-scheme': 'light' });
        expect(dom.attrs['data-contrast']).toBeUndefined();
    });

    it('applies the host’s stored id', async () => {
        await expect(bootTheme({ getTheme: async () => ({ id: 'dark' }) })).resolves.toBe('dark');
    });

    it('falls back to Dark for an unknown id, a rejecting host, no host, or a host that never answers', async () => {
        await expect(bootTheme({ getTheme: async () => ({ id: 'neon' }) })).resolves.toBe('dark');
        await expect(bootTheme({ getTheme: async () => { throw new Error('No handler registered'); } })).resolves.toBe('dark');
        await expect(bootTheme(undefined)).resolves.toBe('dark');
        vi.useFakeTimers();
        const p = bootTheme({ getTheme: () => new Promise(() => {}) }, 400);
        await vi.advanceTimersByTimeAsync(401);
        await expect(p).resolves.toBe('dark');
    });
});

describe('Sync with system: more contrast', () => {
    const w = globalThis as unknown as { window: { matchMedia?: (q: string) => { matches: boolean } } };
    afterEach(() => { delete w.window.matchMedia; });
    const os = (on: string[]) => { w.window.matchMedia = (q: string) => ({ matches: on.includes(q) }); };

    it('prefers-contrast: more or forced-colors: active picks High contrast, by light/dark', () => {
        os(['(prefers-contrast: more)']);
        expect(systemPrefersMoreContrast()).toBe(true);
        expect(resolveThemePreference('system').id).toBe('hc-dark');
        os(['(forced-colors: active)', '(prefers-color-scheme: light)']);
        expect(resolveThemePreference('system').id).toBe('hc-light');
        os(['(prefers-color-scheme: light)']);
        expect(systemPrefersMoreContrast()).toBe(false);
        expect(resolveThemePreference('system').id).toBe('light');
        os([]);
        expect(resolveThemePreference('system').id).toBe('dark');
    });

    it('an explicit pick is never overridden by the OS', () => {
        os(['(prefers-contrast: more)']);
        expect(resolveThemePreference('midnight').id).toBe('midnight');
        expect(resolveThemePreference('dark').id).toBe('dark');
    });
});
