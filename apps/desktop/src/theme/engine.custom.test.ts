import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    THEME_STYLE_ID, __resetThemeForTests, bootTheme, getActiveCustomThemeId, getTheme, getThemePreference, setCustomTheme,
    setThemePreference, type ThemeHost,
} from './engine';
import { customBootPayload, type CustomThemeBootPayload } from './customTheme';
import { CUSTOM_THEME_PRESETS } from './customPresets';

const rose = CUSTOM_THEME_PRESETS.find((p) => p.key === 'rose')!.def;
const ocean = CUSTOM_THEME_PRESETS.find((p) => p.key === 'ocean')!.def;

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
const g = globalThis as unknown as { document: unknown };
let saved: unknown;
let dom: ReturnType<typeof fakeDom>;
beforeEach(() => { __resetThemeForTests(); saved = g.document; dom = fakeDom(); g.document = dom.doc; });
afterEach(() => { g.document = saved; });

describe('custom themes in the engine', () => {
    it('setCustomTheme: base in data-theme, the custom marker, the derived CSS, and the device copy to the host', async () => {
        const sent: CustomThemeBootPayload[] = [];
        const host: ThemeHost = { setCustomTheme: async (p) => { sent.push(p); return {}; } };
        await setCustomTheme('t1', rose, host);
        expect(dom.attrs['data-theme']).toBe('light');
        expect(dom.attrs['data-custom-theme']).toBe('t1');
        expect(getThemePreference()).toBe('custom');
        expect(getActiveCustomThemeId()).toBe('t1');
        expect(getTheme().palette.abyss).toBe(rose.colors.bg);
        expect(dom.byId.get(THEME_STYLE_ID)!.textContent).toContain(':root[data-theme="light"][data-custom-theme]{');
        expect(sent).toHaveLength(1);
        expect(sent[0].id).toBe('t1');
        expect(JSON.stringify(sent[0])).not.toContain(rose.name);
    });

    it('picking a built-in clears the custom marker', async () => {
        await setCustomTheme('t1', ocean, {});
        await setThemePreference('dark', {});
        expect(dom.attrs['data-custom-theme']).toBeUndefined();
        expect(getActiveCustomThemeId()).toBeNull();
        expect(getTheme().customId).toBeUndefined();
    });

    it('boot: the preload\'s device copy is applied synchronously, before the first render', () => {
        void bootTheme({ bootThemeId: 'dark', bootCustomTheme: customBootPayload('t9', ocean) });
        expect(getTheme().customId).toBe('t9');
        expect(getTheme().palette.deep).toBe(ocean.colors.panel);
        expect(dom.attrs['data-custom-theme']).toBe('t9');
    });

    it('boot: a tampered device copy falls back to the stored built-in', () => {
        const bad = { ...customBootPayload('t9', ocean), theme: { v: 1, base: 'dark', colors: { bg: 'url(x)' }, glow: true } };
        void bootTheme({ bootThemeId: 'light', bootCustomTheme: bad });
        expect(getTheme().customId).toBeUndefined();
        expect(getTheme().id).toBe('light');
    });

    it('a host push of a custom state (another window) applies it', async () => {
        let push: ((s: { id: string; pref?: string; custom?: unknown }) => void) | undefined;
        await bootTheme({ onThemeChanged: (cb) => { push = cb; return () => {}; } });
        push!({ id: 'light', pref: 'custom', custom: customBootPayload('t2', rose) });
        expect(getTheme().customId).toBe('t2');
        push!({ id: 'dark', pref: 'dark' });
        expect(getTheme().customId).toBeUndefined();
    });
});

describe('custom themes next to Midnight / High contrast (data-scheme, data-contrast)', () => {
    it('a custom theme carries its BASE scheme and never data-contrast', async () => {
        await setCustomTheme('r', rose, {});
        expect(dom.attrs['data-scheme']).toBe('light');
        expect(dom.attrs['data-contrast']).toBeUndefined();
        await setCustomTheme('o', ocean, {});
        expect(dom.attrs['data-theme']).toBe('dark');
        expect(dom.attrs['data-scheme']).toBe('dark');
        expect(dom.attrs['data-contrast']).toBeUndefined();
    });

    it('High contrast -> custom clears data-contrast; custom -> Midnight / HC light clears the custom marker', async () => {
        await setThemePreference('hc-dark', {});
        expect(dom.attrs['data-contrast']).toBe('high');
        expect(dom.attrs['data-scheme']).toBe('dark');
        await setCustomTheme('r', rose, {});
        expect(dom.attrs['data-contrast']).toBeUndefined();
        expect(dom.attrs['data-custom-theme']).toBe('r');
        await setThemePreference('midnight', {});
        expect(dom.attrs['data-theme']).toBe('midnight');
        expect(dom.attrs['data-scheme']).toBe('dark');
        expect(dom.attrs['data-custom-theme']).toBeUndefined();
        await setThemePreference('hc-light', {});
        expect(dom.attrs).toMatchObject({ 'data-theme': 'hc-light', 'data-scheme': 'light', 'data-contrast': 'high' });
        expect(dom.attrs['data-custom-theme']).toBeUndefined();
    });

    it("a custom theme's rule never uses a Midnight / High contrast selector", async () => {
        for (const def of [rose, ocean]) {
            await setCustomTheme('x', def, {});
            const css = dom.byId.get(THEME_STYLE_ID)!.textContent;
            expect(css).not.toMatch(/data-contrast|midnight|hc-(dark|light)/);
        }
    });

    it('boot: the preload\'s built-in id for every built-in theme applies with its scheme', () => {
        for (const [id, scheme] of [['dark', 'dark'], ['light', 'light'], ['midnight', 'dark'], ['hc-dark', 'dark'], ['hc-light', 'light']] as const) {
            __resetThemeForTests();
            void bootTheme({ bootThemeId: id });
            expect(getTheme().id).toBe(id);
            expect(dom.attrs['data-scheme']).toBe(scheme);
            expect(dom.attrs['data-contrast']).toBe(id.startsWith('hc-') ? 'high' : undefined);
        }
    });
});
