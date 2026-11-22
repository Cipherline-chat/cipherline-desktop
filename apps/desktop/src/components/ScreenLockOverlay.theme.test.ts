// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrastRatio, AA_TEXT, AA_UI } from '../theme/contrast';
import { DARK_THEME, HC_LIGHT_THEME, LIGHT_THEME, MIDNIGHT_THEME, PALETTE_TOKENS, type PaletteToken, type Theme } from '../theme/themes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Screen Lock in the light-scheme themes (owner, 2026-11-22: "the lock screen
 * on light mode needs to be redone"). Before: Light painted Dark's navy sea
 * (an inline literal gradient + the dark-only dot field) under ink text, so
 * the title was ~1.1:1 and the translucent cream panel went muddy grey.
 *
 * Pinned here:
 *   - which backdrop mounts: the dot field in dark-scheme themes only, the
 *     light art in light-scheme themes (and the field never starts there);
 *   - screen-lock.css's light rules use theme tokens only, and every pair the
 *     light lock paints passes AA (High contrast light: 7:1 text);
 *   - reduced motion stills the new art.
 * The real-app look is in docs/worklog/shots/screen-lock-light/.
 */
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ logout: vi.fn() }) }));
// The field is a worker + OffscreenCanvas (absent in jsdom): stand in a marker for "it was mounted".
vi.mock('./LockScreenField', () => ({ default: () => React.createElement('canvas', { 'data-field': '' }) }));
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { default: ScreenLockOverlay } = await import('./ScreenLockOverlay');
const { applyTheme } = await import('../theme/engine');

const lockStub = () => ({
    settings: { pinLength: 6, enabled: true, verifier: null, timeoutMinutes: 5, lockOnOsLock: true },
    isLocked: true, attempts: 0, lockedOutUntil: null,
    lockNow: vi.fn(), unlock: vi.fn(async () => false), setPin: vi.fn(), changePin: vi.fn(), disable: vi.fn(),
    forgotPinReset: vi.fn(), setTimeoutMinutes: vi.fn(), setLockOnOsLock: vi.fn(),
}) as unknown as Parameters<typeof ScreenLockOverlay>[0]['screenLock'];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    act(() => applyTheme(DARK_THEME));
});
const mount = () => act(() => { root.render(React.createElement(ScreenLockOverlay, { screenLock: lockStub() })); });
const lock = () => document.querySelector('[data-screen-lock]') as HTMLElement;

describe('Screen Lock backdrop per theme kind', () => {
    it.each([['Dark', DARK_THEME], ['Midnight', MIDNIGHT_THEME]] as const)('%s: the dot field, no light art', (_n, theme) => {
        act(() => applyTheme(theme));
        mount();
        expect(lock().classList.contains('sl-root')).toBe(true);
        expect(lock().querySelector('[data-field]')).not.toBeNull();
        expect(lock().querySelector('.sl-art')).toBeNull();
    });

    it.each([['Light', LIGHT_THEME], ['High contrast light', HC_LIGHT_THEME]] as const)('%s: the light art, and the dark dot field never mounts', (_n, theme) => {
        act(() => applyTheme(theme));
        mount();
        expect(lock().querySelector('[data-field]')).toBeNull();
        const art = lock().querySelector('.sl-art');
        expect(art).not.toBeNull();
        expect(art!.getAttribute('aria-hidden')).toBe('true');
        expect(art!.querySelectorAll('.sl-art-dot').length).toBeGreaterThan(0);
        // Never `is-live` (that is the dark field's gradient).
        expect(lock().classList.contains('is-live')).toBe(false);
    });

    it('switching theme while locked swaps the backdrop (Dark -> Light -> Dark)', () => {
        act(() => applyTheme(DARK_THEME));
        mount();
        expect(lock().querySelector('[data-field]')).not.toBeNull();
        act(() => applyTheme(LIGHT_THEME));
        expect(lock().querySelector('[data-field]')).toBeNull();
        expect(lock().querySelector('.sl-art')).not.toBeNull();
        act(() => applyTheme(DARK_THEME));
        expect(lock().querySelector('[data-field]')).not.toBeNull();
        expect(lock().querySelector('.sl-art')).toBeNull();
    });

    it('the padlock reads its colours from --sl-* variables with the Dark values as fallback', () => {
        // Source, not the DOM: jsdom drops `stop-color` from inline styles (Chromium keeps it).
        const src = readFileSync(resolve(__dirname, 'ScreenLockOverlay.tsx'), 'utf8');
        for (const v of ['var(--sl-top, #5CF0DC)', 'var(--sl-bottom, #14B8A4)', 'var(--sl-shackle, #A7F3EA)',
            'var(--sl-bad-top, #FF8A85)', 'var(--sl-bad-bottom, #E5484D)', 'var(--sl-bad-shackle, #FF8A85)']) {
            expect(src).toContain(v);
        }
        mount();
        const html = lock().querySelector('.sl-lock')!.innerHTML;
        expect(html).toContain('stroke: var(--sl-shackle, #A7F3EA)');
        expect(html).toContain('fill: var(--cl-keys-ink)');
        // Dark's keyhole ink and the Keys ink token are the same colour, so Dark is unchanged.
        expect(DARK_THEME.palette['keys-ink']).toBe('#0B0F1E');
    });
});

describe('screen-lock.css light rules', () => {
    const css = readFileSync(resolve(__dirname, '../styles/screen-lock.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const lightRules = [...css.matchAll(/([^{}]*data-scheme="light"[^{}]*)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));

    it('exist for the backdrop, the padlock, the panel and the PIN slots', () => {
        const sels = lightRules.map(r => r.sel).join('\n');
        for (const s of ['.sl-root', '.sl-lock', '.sl-lock-glow', '.sl-panel', '.sl-forgot']) expect(sels).toContain(s);
        const panel = lightRules.find(r => r.sel === ':root[data-scheme="light"] .sl-panel')!.body;
        for (const v of ['--slot-bg', '--slot-edge', '--slot-cursor', '--slot-error-edge']) expect(panel).toContain(v);
    });

    it('use theme tokens only: no hex / rgb() / hsl() literal in any light-scheme rule', () => {
        expect(lightRules.length).toBeGreaterThan(8);
        for (const r of lightRules) {
            expect(r.body, r.sel).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
            expect(r.body, r.sel).not.toMatch(/\b(?:rgba?|hsla?)\(\s*(?!var\()/);
        }
    });

    it('reduced motion stills the light art too', () => {
        const rm = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
        expect(rm).toMatch(/\.sl-art-dot[^{]*\{?[^}]*animation: none/);
        expect(rm).toMatch(/\.sl-lock-glow/);
    });
});

/** The pairs the light lock paints: [what, foreground token, background token, minimum]. */
const hex = (t: Theme, k: PaletteToken) => t.palette[k];
describe('light lock contrast (theme data)', () => {
    const check = (t: Theme, text: number) => {
        const pairs: [string, PaletteToken, PaletteToken, number][] = [
            ['title on the page', 'text', 'abyss', text],
            ['title on the sand foot', 'text', 'sink', text],
            ['subtitle on the page', 'faint', 'abyss', text],
            ['subtitle on the sand foot', 'faint', 'sink', text],
            ['status / attempts on the card', 'faint', 'deep', text],
            ['wrong PIN / cooldown on the card', 'flash-text', 'deep', text],
            ['forgot link on the card', 'muted', 'deep', text],
            ['confirm copy on the card', 'muted', 'deep', text],
            ['PIN slot edge on the card', 'border-strong', 'deep', AA_UI],
            ['PIN cursor on the card', 'lume-text', 'deep', AA_UI],
            ['wrong-PIN slot edge on the card', 'flash-text', 'deep', AA_UI],
            ['entered-digit dot on its slot', 'text', 'deep', AA_UI],
            ['padlock shackle on the page', t.contrast === 'high' ? 'lume-text' : 'lume-ui', 'abyss', AA_UI],
        ];
        for (const [what, fg, bg, min] of pairs) {
            expect(PALETTE_TOKENS).toContain(fg);
            expect(contrastRatio(hex(t, fg), hex(t, bg)), `${t.name}: ${what}`).toBeGreaterThanOrEqual(min);
        }
    };
    it('Light: WCAG AA (4.5:1 text, 3:1 UI)', () => check(LIGHT_THEME, AA_TEXT));
    it('High contrast light: 7:1 text, 3:1 UI', () => check(HC_LIGHT_THEME, 7));
});
