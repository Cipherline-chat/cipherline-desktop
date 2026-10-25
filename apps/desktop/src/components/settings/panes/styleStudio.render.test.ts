// @vitest-environment jsdom
/**
 * Settings > Profile > Style: the inline studio. A picked item's options sit
 * in the inspector right beside the preview (no scrolling, no popover); the
 * option controls are built from the catalog's schema; a locked item is only
 * tried on (never PATCHed) and the try-on ends when you move on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});
const patch = vi.hoisted(() => vi.fn(async () => ({ data: {} })));
vi.mock('axios', () => ({ default: { patch: (...a: unknown[]) => patch(...(a as [])), isAxiosError: () => false } }));
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ push: vi.fn() }) }));
vi.mock('../../../hooks/useFoundEggs', () => ({ useFoundEggs: () => new Set<string>() }));
vi.mock('../../../hooks/useUserAchievements', () => ({ useUserAchievements: () => ({ data: { unlocked: [] }, loading: false, error: false, reload: () => {} }) }));
vi.mock('../../../hooks/useEncryptedAvatar', () => ({ useEncryptedAvatar: () => null, evictAvatar: () => {}, avatarUrlMime: () => null, peekAvatarUrl: () => null }));

import { ProfileCosmeticsSection } from './ProfileCosmeticsSection';
import { optionSpecsFor, PEARL_COLOURS } from '../../../utils/profileCosmetics';

const h = React.createElement as (...a: any[]) => React.ReactElement;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    patch.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const q = (sel: string) => host.querySelector(sel);
const qa = (sel: string) => [...host.querySelectorAll(sel)];

const render = (extra: Record<string, unknown> = {}) => {
    const onPreview = vi.fn();
    act(() => root.render(h(ProfileCosmeticsSection, {
        token: 't', level: 4, onSaved: vi.fn(), onPreview,
        saved: { profile_theme: null, avatar_decoration: 'deep-dash', profile_effect: null, cosmetic_options: { d: { s: 3 } } },
        base: { userId: 'u', token: 't', avatarAttachmentId: null },
        ...extra,
    })));
    return onPreview;
};

describe('the Style studio', () => {
    it('opens on Decoration with the applied item and ALL its options in the inspector, built from the schema', () => {
        render();
        expect(q('[data-testid="style-inspector"]')!.textContent).toContain('Deep dash');
        expect(q('[data-testid="style-inspector"]')!.getAttribute('data-state')).toBe('on');
        const labels = qa('.pst-opt-label').map((e) => e.textContent);
        expect(labels).toEqual(optionSpecsFor('decoration', 'deep-dash').map((s) => s.label));
        // pattern not set = its default "Dashes"; speed was saved as 3 = "Quick"
        expect(q('[role="radio"][aria-checked="true"]')).not.toBeNull();
        expect(qa('.ps-seg3 [aria-checked="true"]').map((b) => b.textContent)).toEqual(['Dashes', 'Quick']);
        expect(q('[role="slider"]')!.getAttribute('aria-valuetext')).toBe('Matches your theme');
    });

    it('a knob previews at once (and saves a moment later, as one PATCH key)', () => {
        vi.useFakeTimers();
        try {
            const onPreview = render();
            act(() => (q('.pst-dot[aria-label="Color, 300 degrees"]') as HTMLButtonElement).click());
            expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ decorationOptions: { s: 3, h: 300 } }));
            expect(patch).not.toHaveBeenCalled();
            act(() => { vi.advanceTimersByTime(800); });
            expect(patch).toHaveBeenCalledWith(expect.stringContaining('/auth/profile'), { cosmetic_options: { d: { s: 3, h: 300 } } }, expect.anything());
        } finally { vi.useRealTimers(); }
    });

    it('a locked item is tried on (preview + inspector says how to earn it), never saved; another studio ends it', () => {
        const onPreview = render();
        const locked = q('.pst-tile[data-locked="true"]') as HTMLButtonElement;
        act(() => locked.click());
        expect(patch).not.toHaveBeenCalled();
        expect(q('[data-testid="style-inspector"]')!.getAttribute('data-state')).toBe('locked');
        expect(q('.pst-insp-lock')!.textContent).toMatch(/will not be saved/);
        const tried = onPreview.mock.calls.at(-1)![0].decoration;
        expect(tried).not.toBe('deep-dash');
        act(() => (q('[data-testid="style-tab-effect"]') as HTMLButtonElement).click());
        act(() => (q('[data-testid="style-tab-decoration"]') as HTMLButtonElement).click());
        expect(q('[data-testid="style-inspector"]')!.getAttribute('data-state')).toBe('on');
        expect(onPreview.mock.calls.at(-1)![0].decoration).toBe('deep-dash');
    });

    it('leaving the Style tab ends a try-on', () => {
        const onPreview = render();
        act(() => (q('.pst-tile[data-locked="true"]') as HTMLButtonElement).click());
        render({ active: false, onPreview });
        expect(onPreview.mock.calls.at(-1)![0].decoration).toBe('deep-dash');
    });

    it('colourways and choices come from the schema too: a pearl colour swatch saves its index', () => {
        vi.useFakeTimers();
        try {
            render({ saved: { profile_theme: null, avatar_decoration: 'pearl-string', profile_effect: null, cosmetic_options: null } });
            const swatches = qa('[role="radiogroup"][aria-label="Pearls"] [role="radio"]');
            expect(swatches.map((b) => b.getAttribute('aria-label'))).toEqual(PEARL_COLOURS.map(([l]) => l));
            act(() => (swatches[2] as HTMLButtonElement).click());
            act(() => { vi.advanceTimersByTime(800); });
            expect(patch).toHaveBeenCalledWith(expect.stringContaining('/auth/profile'), { cosmetic_options: { d: { c: 2 } } }, expect.anything());
        } finally { vi.useRealTimers(); }
    });

    it('an unlocked pick saves its one key', () => {
        render();
        act(() => (q('.pst-tile[aria-label="Kelp"]') as HTMLButtonElement).click());
        expect(patch).toHaveBeenCalledWith(expect.any(String), { avatar_decoration: 'kelp' }, expect.anything());
    });

    it('Theme: presets apply, "Custom colors" opens the picker on demand, Match is offered', () => {
        render();
        act(() => (q('[data-testid="style-tab-theme"]') as HTMLButtonElement).click());
        expect(q('[data-testid="custom-colors-panel"]')).toBeNull();
        expect(q('[data-testid="match-banner"]')).not.toBeNull();
        act(() => (q('[data-testid="custom-colors"]') as HTMLButtonElement).click());
        expect(q('[data-testid="custom-colors-panel"] .cp-panel')).not.toBeNull();
        act(() => (q('.pst-preset[aria-label="Lume theme"]') as HTMLButtonElement).click());
        expect(patch).toHaveBeenCalledWith(expect.any(String), { profile_theme: { primary: '#25e0c8', accent: '#0e8f7c' } }, expect.anything());
    });
});
