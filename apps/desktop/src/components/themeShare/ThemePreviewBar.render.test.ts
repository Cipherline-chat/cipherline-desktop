// @vitest-environment jsdom
/**
 * The theme preview safety bar (ThemePreviewBar.tsx), rendered for real:
 * it lives in a shadow root on its own host under <html> (so no app / theme
 * stylesheet can reach it), shows "Previewing <name>" with a countdown, moves
 * focus to Keep, keeps Tab inside, reverts on Escape / Revert / the timer, and
 * Keep makes the theme stick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});
const kv = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.set(k, v); },
        removeItem: (k: string) => { kv.delete(k); },
        isAccountReady: () => true,
        keys: () => [...kv.keys()],
        whenAccountReady: () => Promise.resolve(),
    },
}));
vi.mock('../../services/ownSlotEnv', () => ({ createOwnSlotEnv: () => ({}) }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ userId: 'user-1', user: null }) }));

import { ThemePreviewBar } from './ThemePreviewBar';
import { PREVIEW_BAR_HOST_TAG, HOST_LOCK, BAR_CSS, computeBarPlacement, secondsLeft } from './themePreviewBarParts';
import {
    PREVIEW_REVERT_MS, __resetThemeForTests, getTheme, getThemePreference, getThemePreview, startBuiltinThemePreview, startThemePreview,
} from '../../theme/engine';
import { CUSTOM_THEME_PRESETS } from '../../theme/customPresets';
import type { CustomThemeDef } from '../../theme/customTheme';
import { THEMES } from '../../theme/themes';

const h = React.createElement;
let container: HTMLDivElement;
let root: Root;
let outside: HTMLButtonElement;

const host = () => document.documentElement.querySelector(PREVIEW_BAR_HOST_TAG) as HTMLElement | null;
const shadow = () => host()!.shadowRoot!;
const bar = () => shadow().querySelector('[data-theme-preview-bar]') as HTMLElement | null;
const keepBtn = () => shadow().querySelector('[data-preview-keep]') as HTMLButtonElement;
const revertBtn = () => shadow().querySelector('[data-preview-revert]') as HTMLButtonElement;
const live = () => shadow().querySelector('[aria-live]')!.textContent;
const key = (target: EventTarget, k: string, shift = false) =>
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, composed: true, cancelable: true })); });

/** Every colour #000000: the theme a user can make (no contrast correction) and could not read. */
const VOID: CustomThemeDef = (() => {
    const base = CUSTOM_THEME_PRESETS[0].def;
    return { ...base, name: 'Void', colors: Object.fromEntries(Object.keys(base.colors).map((k) => [k, '#000000'])) as CustomThemeDef['colors'] };
})();

beforeEach(async () => {
    vi.useFakeTimers();
    __resetThemeForTests();
    kv.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    outside = document.createElement('button');
    outside.textContent = 'Midnight tile';
    document.body.appendChild(outside);
    root = createRoot(container);
    await act(async () => { root.render(h(ThemePreviewBar)); });
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    outside.remove();
    document.head.querySelectorAll('style[data-hostile]').forEach((s) => s.remove());
    vi.useRealTimers();
});

describe('un-themable by construction', () => {
    it('renders into a shadow root on its own host under <html>, outside <body> and the React root', () => {
        const el = host();
        expect(el).not.toBeNull();
        expect(el!.parentElement).toBe(document.documentElement);
        expect(document.body.contains(el)).toBe(false);
        expect(el!.shadowRoot).not.toBeNull();
    });

    it('the host box is locked inline with !important: fixed, max z-index, isolated, opaque', () => {
        const el = host()!;
        for (const [k] of HOST_LOCK) {
            if (k === 'all') continue;
            expect(el.style.getPropertyPriority(k), k).toBe('important');
        }
        expect(el.style.getPropertyValue('position')).toBe('fixed');
        expect(el.style.getPropertyValue('z-index')).toBe('2147483647');
        expect(el.style.getPropertyValue('isolation')).toBe('isolate');
        expect(el.style.getPropertyValue('opacity')).toBe('1');
    });

    it('its stylesheet uses no CSS variable and no relative unit a theme or root font size could move', () => {
        expect(BAR_CSS).not.toMatch(/var\(/);
        expect(BAR_CSS).not.toMatch(/\d(r?em|vw|vh)\b/);
        // The :host rule (the strongest origin for !important) carries the whole lock, not just `all: initial`.
        expect(BAR_CSS).toContain(':host { all: initial !important; display: block !important; position: fixed !important;');
        expect(BAR_CSS).toContain('z-index: 2147483647 !important;');
    });

    it('no document-level selector reaches the bar, even with a hostile global stylesheet and the black-on-black theme', () => {
        const hostile = document.createElement('style');
        hostile.setAttribute('data-hostile', '');
        hostile.textContent = '* { display: none !important; opacity: 0 !important; color: #000 !important; background: #000 !important; font-size: 1px !important; }';
        document.head.appendChild(hostile);
        // Positive control: the hostile sheet really does hide an ordinary element.
        expect(getComputedStyle(outside).display).toBe('none');
        act(() => { startThemePreview(VOID, { source: 'settings' }); });
        expect(getTheme().palette.text).toBe('#000000');
        expect(document.querySelector('[data-theme-preview-bar]')).toBeNull();
        expect([...document.querySelectorAll('*')].some((n) => n.closest?.('[data-theme-preview-bar]'))).toBe(false);
        expect(bar()).not.toBeNull();
        // The host itself: its inline !important lock beats the hostile rule.
        expect(getComputedStyle(host()!).display).toBe('block');
        expect(getComputedStyle(host()!).opacity).toBe('1');
    });
});

describe('behaviour', () => {
    it('shows "Previewing <name>", the countdown, Keep and Revert; focus moves to Keep', () => {
        outside.focus();
        act(() => { startBuiltinThemePreview('midnight', { source: 'settings' }); });
        expect(bar()!.textContent).toContain('Previewing Midnight');
        expect(bar()!.textContent).toContain('Reverting in 15s');
        expect(keepBtn().textContent).toBe('Keep');
        expect(revertBtn().textContent).toBe('Revert');
        expect(bar()!.getAttribute('role')).toBe('alertdialog');
        expect(shadow().activeElement).toBe(keepBtn());
        expect(live()).toContain('Previewing theme Midnight');
        expect(live()).toContain('15 seconds unless you press Keep');
    });

    it('Tab / Shift+Tab cycle Keep and Revert inside the bar', () => {
        act(() => { startBuiltinThemePreview('light', { source: 'settings' }); });
        key(keepBtn(), 'Tab');
        expect(shadow().activeElement).toBe(revertBtn());
        key(revertBtn(), 'Tab');
        expect(shadow().activeElement).toBe(keepBtn());
        key(keepBtn(), 'Tab', true);
        expect(shadow().activeElement).toBe(revertBtn());
    });

    it('counts down on the bar and announces the 10 s mark', () => {
        act(() => { startBuiltinThemePreview('light', { source: 'settings' }); });
        act(() => { vi.advanceTimersByTime(5_000); });
        expect(bar()!.textContent).toContain('Reverting in 10s');
        expect(live()).toBe('10 seconds left to keep Light.');
    });

    it('the timer reverts: bar gone, real theme back, announced, focus back where it was', () => {
        outside.focus();
        act(() => { startThemePreview(VOID, { source: 'settings' }); });
        expect(shadow().activeElement).toBe(keepBtn());
        act(() => { vi.advanceTimersByTime(PREVIEW_REVERT_MS); });
        expect(getThemePreview()).toBeNull();
        expect(getTheme()).toBe(THEMES.dark);
        expect(bar()).toBeNull();
        expect(live()).toBe('Preview ended. Your theme is back.');
        expect(document.activeElement).toBe(outside);
    });

    it('Escape reverts', () => {
        act(() => { startBuiltinThemePreview('hc-light', { source: 'settings' }); });
        key(window, 'Escape');
        expect(getThemePreview()).toBeNull();
        expect(getTheme()).toBe(THEMES.dark);
    });

    it('Revert reverts', () => {
        act(() => { startBuiltinThemePreview('light', { source: 'settings' }); });
        act(() => { revertBtn().click(); });
        expect(getThemePreview()).toBeNull();
        expect(getTheme()).toBe(THEMES.dark);
        expect(getThemePreference()).toBe('dark');
    });

    it('Keep makes it the device theme; the timer no longer reverts it', async () => {
        act(() => { startBuiltinThemePreview('light', { source: 'settings' }); });
        await act(async () => { keepBtn().click(); });
        expect(getThemePreview()).toBeNull();
        expect(getThemePreference()).toBe('light');
        expect(getTheme()).toBe(THEMES.light);
        expect(live()).toBe('Theme kept.');
        act(() => { vi.advanceTimersByTime(PREVIEW_REVERT_MS); });
        expect(getTheme()).toBe(THEMES.light);
    });

    it('picking another theme re-arms the countdown on the bar', () => {
        act(() => { startBuiltinThemePreview('light', { source: 'settings' }); });
        act(() => { vi.advanceTimersByTime(9_000); });
        expect(bar()!.textContent).toContain('Reverting in 6s');
        act(() => { startBuiltinThemePreview('midnight', { source: 'settings' }); });
        act(() => { vi.advanceTimersByTime(300); });
        expect(bar()!.textContent).toContain('Previewing Midnight');
        expect(bar()!.textContent).toContain('Reverting in 15s');
    });

    it('unmounting (sign-out) reverts a preview', async () => {
        act(() => { startBuiltinThemePreview('light', { source: 'settings' }); });
        await act(async () => { root.unmount(); });
        expect(getThemePreview()).toBeNull();
        expect(host()).toBeNull();
        root = createRoot(container);
    });
});

describe('placement', () => {
    it('Settings open: inside the bottom of the nav column, never over the content (theme picker)', () => {
        const nav = { left: 0, right: 272, bottom: 720, width: 272 };
        const p = computeBarPlacement(1000, 720, nav, []);
        expect(p.left).toBe(12);
        expect(p.left + p.width).toBeLessThanOrEqual(nav.right);
        expect(p.bottom).toBe(12);
    });
    it('elsewhere: bottom-left clear of the server rail, above the message box', () => {
        const p = computeBarPlacement(1000, 720, null, [{ top: 640, bottom: 700, width: 600, height: 60 }]);
        expect(p.left).toBe(90);
        expect(p.bottom).toBe(720 - 640 + 16);
        expect(p.left + p.width).toBeLessThanOrEqual(1000);
    });
    it('never off screen, whatever the page measures (a collapsed nav, a composer near the top, a tiny window)', () => {
        for (const p of [
            computeBarPlacement(1000, 720, { left: 0, right: 272, bottom: 40, width: 272 }, []),
            computeBarPlacement(1000, 720, null, [{ top: 20, bottom: 700, width: 600, height: 680 }]),
            computeBarPlacement(300, 200, { left: 200, right: 472, bottom: 200, width: 272 }, []),
        ]) {
            expect(p.bottom).toBeGreaterThanOrEqual(12);
            expect(p.bottom).toBeLessThanOrEqual(Math.max(12, 720 - 160));
            expect(p.left).toBeGreaterThanOrEqual(8);
        }
        const tiny = computeBarPlacement(300, 200, { left: 200, right: 472, bottom: 200, width: 272 }, []);
        expect(tiny.left + tiny.width).toBeLessThanOrEqual(300 - 8);
    });
    it('the countdown never shows a negative number', () => {
        expect(secondsLeft(1000, 5000)).toBe(0);
        expect(secondsLeft(15_000, 0)).toBe(15);
        expect(secondsLeft(15_000, 1)).toBe(15);
        expect(secondsLeft(15_000, 14_001)).toBe(1);
    });
});
