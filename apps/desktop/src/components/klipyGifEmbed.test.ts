import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * A received `klipy_gif` message loads media from KLIPY — i.e. tells KLIPY the
 * viewer's IP address. So:
 *   - someone who has NOT opted in sees a "tap to load" card and the markup
 *     contains no KLIPY URL at all (nothing for the browser to fetch);
 *   - a tap loads that one GIF (the mode flips to 'load'), "Always load"
 *     turns the setting on;
 *   - a payload naming any other host renders "couldn't be shown", loads
 *     nothing, even for someone who opted in.
 *
 * Rendered with react-dom/server (this app's vitest has no DOM): it runs
 * render but not effects, which is exactly the part that decides what URL
 * ends up in the markup.
 */

const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

// Import-time browser probes in the embed's dependency tree (the cl physics
// module asks matchMedia for reduced motion) — set up BEFORE the imports.
{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only global stubs
    const g = globalThis as Record<string, any>;
    g.document.hidden = false;
    g.document.hasFocus = () => true;
    if (typeof g.window.matchMedia !== 'function') {
        g.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
    g.window.removeEventListener = g.window.removeEventListener || (() => {});
    g.window.dispatchEvent = g.window.dispatchEvent || (() => true);
    // axios (via GifPicker → AuthContext) reads window.location at import time.
    if (!g.window.location) g.window.location = { href: 'http://localhost/', origin: 'http://localhost' };
}

const { KlipyGifEmbed } = await import('./KlipyGifEmbed');
const { klipyEmbedMode, klipyDisplaySize, initialGifTab, KLIPY_TAP_TO_LOAD_TEXT, KLIPY_ALWAYS_LOAD_TEXT } =
    await import('../utils/klipy');
// The picker module must still import cleanly in this environment.
await import('./GifPicker');
const { updateGifSettings } = await import('../hooks/useGifSettings');

const URL_OK = 'https://static1.klipy.com/ii/abc/md/x.webp?v=1';
const GOOD = { type: 'klipy_gif', slug: 'wave-1', media: { url: URL_OK, width: 480, height: 270, mime: 'image/webp' }, title: 'Wave' };

const render = (content: unknown) => renderToStaticMarkup(React.createElement(KlipyGifEmbed, { content }));
const escaped = (s: string) => s.replace(/&/g, '&amp;');

beforeEach(() => { mem.clear(); });

describe('KlipyGifEmbed — opt-in gate', () => {
    it('not opted in → "tap to load" card, and NO KLIPY URL anywhere in the markup', () => {
        const html = render(GOOD);
        expect(html).toContain(KLIPY_TAP_TO_LOAD_TEXT);
        expect(html).toContain(KLIPY_ALWAYS_LOAD_TEXT);
        expect(html).not.toMatch(/klipy\.com/);
        expect(html).not.toMatch(/<img/);
    });

    it('opted in → the image loads from the KLIPY CDN with no referrer', () => {
        updateGifSettings({ klipyEnabled: true });
        const html = render(GOOD);
        expect(html).toContain(`src="${escaped(URL_OK)}"`);
        expect(html).toMatch(/referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/);
        expect(html).not.toContain(KLIPY_TAP_TO_LOAD_TEXT);
        expect(html).toContain('alt="Wave (GIF from KLIPY)"');
    });

    it.each([
        ['a tracker host', 'https://tracker.example/p.gif'],
        ['a look-alike KLIPY host', 'https://static.klipy.com.evil.net/p.gif'],
        ['plain http', 'http://static.klipy.com/p.gif'],
    ])('a payload pointing at %s loads nothing, even when opted in', (_l, url) => {
        updateGifSettings({ klipyEnabled: true });
        const html = render({ ...GOOD, media: { ...GOOD.media, url } });
        expect(html).toContain('couldn’t be shown');
        expect(html).not.toMatch(/<img/);
        expect(html).not.toContain(url);
    });

    it('does not throw on hostile shapes', () => {
        for (const c of [null, 42, 'x', { type: 'klipy_gif' }, { type: 'klipy_gif', slug: 'a', media: 'https://static.klipy.com/a.gif' }]) {
            expect(() => render(c)).not.toThrow();
            expect(render(c)).toContain('couldn’t be shown');
        }
    });
});

describe('klipyEmbedMode — decision table', () => {
    const ref = { slug: 'a', media: { url: URL_OK, width: 1, height: 1, mime: 'image/gif' as const } };
    it.each([
        // ref,   enabled, tapped → mode
        [null,    false,   false,   'invalid'],
        [null,    true,    true,    'invalid'],
        [ref,     false,   false,   'placeholder'],
        [ref,     false,   true,    'load'],       // tap to load once
        [ref,     true,    false,   'load'],
        [ref,     true,    true,    'load'],
    ] as const)('ref=%o enabled=%s tapped=%s → %s', (r, en, tap, mode) => {
        expect(klipyEmbedMode(r, en, tap)).toBe(mode);
    });

    it('"Always load KLIPY GIFs" turns the setting on (which flips new embeds to load)', () => {
        expect(render(GOOD)).toContain(KLIPY_TAP_TO_LOAD_TEXT);
        updateGifSettings({ klipyEnabled: true });   // what the button calls
        expect(render(GOOD)).not.toContain(KLIPY_TAP_TO_LOAD_TEXT);
    });
});

describe('sizing and picker defaults', () => {
    it('fits within 300px keeping aspect ratio, never upscales', () => {
        expect(klipyDisplaySize(480, 270)).toEqual({ width: 300, height: 169 });
        expect(klipyDisplaySize(100, 50)).toEqual({ width: 100, height: 50 });
        expect(klipyDisplaySize(200, 8000)).toEqual({ width: 8, height: 300 });
    });

    it.each([
        // configured, enabled, dismissed, last → tab
        [false, true, false, 'klipy', 'saved'],   // no key in this build: never the KLIPY tab
        [true, false, false, null, 'klipy'],      // first open: show the notice once
        [true, false, true, null, 'saved'],       // "Not now" answered: open on Saved
        [true, true, true, null, 'klipy'],
        [true, false, true, 'klipy', 'klipy'],    // session memory wins
    ] as const)('initialGifTab(configured=%s, enabled=%s, dismissed=%s, last=%s) → %s', (configured, enabled, noticeDismissed, last, tab) => {
        expect(initialGifTab({ configured, enabled, noticeDismissed, last })).toBe(tab);
    });
});
