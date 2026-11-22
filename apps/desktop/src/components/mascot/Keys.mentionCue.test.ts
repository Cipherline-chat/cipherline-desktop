// @vitest-environment jsdom
/**
 * Keys' @mention cue in the Light theme (a coral "@" badge at his shoulder; he
 * stays teal). The logic: mention -> badge, read -> gone, asleep / sad -> none.
 * The theme + motion rules live in keys.css and are pinned by reading it.
 */
import { describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const api = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    return { default: api, secureLocalStore: api };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { Keys, showMentionBadge } = await import('./Keys');
const css = readFileSync(join(resolve(__dirname, '..', '..'), 'styles', 'keys.css'), 'utf8');

type Sig = 'alert' | 'pulse' | 'idle';
function mount(signal: Sig, extra: object = {}) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const draw = (s: Sig) => act(() => {
        root.render(React.createElement(Keys, { size: 96, signal: s, waveOnMount: false, interactive: false, costume: null, ...extra }));
    });
    draw(signal);
    return { host, draw };
}

describe('showMentionBadge', () => {
    it('is on only for an awake, not-sad alert', () => {
        expect(showMentionBadge('alert')).toBe(true);
        expect(showMentionBadge('alert', false, false)).toBe(true);
        expect(showMentionBadge('pulse')).toBe(false);
        expect(showMentionBadge('idle')).toBe(false);
        expect(showMentionBadge(undefined)).toBe(false);
        expect(showMentionBadge('alert', true, false)).toBe(false);
        expect(showMentionBadge('alert', false, true)).toBe(false);
    });
});

describe('Keys @mention badge', () => {
    it('appears on a mention and disappears when it is read', () => {
        const { host, draw } = mount('alert');
        const badge = host.querySelector('.k2-badge');
        expect(badge).not.toBeNull();
        expect(badge!.getAttribute('aria-hidden')).toBe('true');
        expect(badge!.textContent).toBe('@');
        draw('idle');
        expect(host.querySelector('.k2-badge')).toBeNull();
    });
    it('is absent for unreads and for a sad Keys', () => {
        expect(mount('pulse').host.querySelector('.k2-badge')).toBeNull();
        expect(mount('alert', { sad: true }).host.querySelector('.k2-badge')).toBeNull();
    });
    it('uses theme tokens only (no colour literals)', () => {
        const { host } = mount('alert');
        const bits = host.querySelector('.k2-badge')!.outerHTML;
        expect(bits).toContain('var(--cl-danger-text)');
        expect(bits).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    });
});

describe('keys.css badge rules', () => {
    it('hidden by default, shown only in light-scheme themes (Light, High contrast light, light custom)', () => {
        expect(css).toMatch(/\.k2-badge\s*\{\s*display:\s*none/);
        expect(css).toMatch(/:root\[data-scheme="light"\]\s*\.k2-badge\s*\{[^}]*display:\s*inline/);
        expect(css).not.toMatch(/:root\[data-(theme|scheme)="dark"\]\s*\.k2-badge/);
    });
    it('the badge is needed exactly where Keys does not turn amber (light-scheme themes)', async () => {
        const { THEMES, THEME_IDS, DARK_THEME } = await import('../../theme/themes');
        const { deriveCustomTheme, customThemeFromBase } = await import('../../theme/customTheme');
        const amber = DARK_THEME.palette['keys-alert'];
        const all = [...THEME_IDS.map((id) => THEMES[id]), deriveCustomTheme(customThemeFromBase('light'), 'l'), deriveCustomTheme(customThemeFromBase('dark'), 'd')];
        for (const t of all) {
            expect(t.palette['keys-alert'] === amber, `${t.customId ?? t.id}`).toBe(t.scheme === 'dark');
        }
    });
    it('is static under Reduce motion and under Celebrations and effects off', () => {
        const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
        expect(rm.slice(0, rm.indexOf('}') + 1)).toContain('.k2-badge');
        expect(css).toMatch(/:root\[data-effects="off"\]\s*\.k2-badge\s*\{\s*animation:\s*none/);
    });
});
