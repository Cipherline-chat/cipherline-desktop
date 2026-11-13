// @vitest-environment jsdom
/**
 * The onboarding Profile step's "How friends see you" card is the NEW profile
 * preview (profile/ProfilePopoutCard) fed by the onboarding draft, not the old
 * minimal card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});
vi.mock('../../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: () => null, evictAvatar: () => {}, avatarUrlMime: () => null, peekAvatarUrl: () => null,
}));

import { ProfileCardPreview, type ProfileCardPreviewProps } from './ProfileCardPreview';

const h = React.createElement as (...a: any[]) => React.ReactElement;

const base: ProfileCardPreviewProps = {
    userId: 'u1', token: 't', name: null, discriminator: null, bio: '',
    avatarSrc: null, bannerSrc: null, avatarId: null, bannerId: null,
    reducedMotion: true, paused: false, onPickAvatar: () => {}, onPickBanner: () => {},
};

let host: HTMLDivElement;
let root: Root;
const render = (p: Partial<ProfileCardPreviewProps> = {}) => act(() => { root.render(h(ProfileCardPreview, { ...base, ...p })); });
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('ProfileCardPreview (onboarding)', () => {
    it('draws the new profile card (ppo), not the old frame', () => {
        render();
        expect(host.querySelector('.ppo')).not.toBeNull();
        expect(host.querySelector('[data-testid="ob-profile-card"]')).not.toBeNull();
        expect(host.querySelector('.obpc-banner, .obpc-l')).toBeNull();
        expect(host.textContent).toContain('How friends see you');
    });

    it('shows the placeholder name until a valid name settles, then name#tag', () => {
        render();
        expect(host.querySelector('.ppo-name')?.textContent).toBe('Your name');
        expect(host.querySelector('[data-ob-card]')?.getAttribute('data-name-empty')).toBe('true');
        expect(host.querySelector('.ppo-tag')).toBeNull();
        render({ name: 'Zalais', discriminator: 4821 });
        expect(host.querySelector('.ppo-name')?.textContent).toContain('Zalais');
        expect(host.querySelector('.ppo-tag')?.textContent).toBe('#4821');
        expect(host.querySelector('[data-ob-card]')?.getAttribute('data-name-empty')).toBeNull();
    });

    it('shows the trimmed bio only when there is one', () => {
        render({ name: 'Zalais', bio: '   ' });
        expect(host.querySelector('[data-testid="profile-bio"]')).toBeNull();
        render({ name: 'Zalais', bio: '  night owl  ' });
        expect(host.querySelector('[data-testid="profile-bio"]')?.textContent).toBe('night owl');
    });

    it('shows Online and the Pro pill only when the trial started', () => {
        render({ name: 'Zalais', isPro: false });
        expect(host.textContent).toContain('Online');
        const noPro = host.querySelector('.ppo-badges')?.children.length ?? 0;
        render({ name: 'Zalais', isPro: true });
        expect((host.querySelector('.ppo-badges')?.children.length ?? 0)).toBeGreaterThan(noPro);
    });

    it('uses the local avatar preview and opens the pickers from the avatar and the banner', () => {
        const onPickAvatar = vi.fn(); const onPickBanner = vi.fn();
        render({ name: 'Zalais', avatarSrc: 'blob:local-avatar', onPickAvatar, onPickBanner });
        expect(host.querySelector('.ppo-avatar-btn img')?.getAttribute('src')).toBe('blob:local-avatar');
        act(() => { (host.querySelector('.ppo-avatar-btn') as HTMLButtonElement).click(); });
        act(() => { (host.querySelector('[data-testid="ppo-banner-pick"]') as HTMLButtonElement).click(); });
        expect(onPickAvatar).toHaveBeenCalledTimes(1);
        expect(onPickBanner).toHaveBeenCalledTimes(1);
    });

    it('labels the pickers by whether an image is already set', () => {
        render({ name: 'Zalais' });
        expect(host.querySelector('[data-testid="ppo-banner-pick"]')?.getAttribute('aria-label')).toBe('Add a banner');
        expect(host.querySelector('.ppo-avatar-btn')?.getAttribute('aria-label')).toBe('Add a profile photo');
        render({ name: 'Zalais', bannerSrc: 'blob:b', avatarSrc: 'blob:a' });
        expect(host.querySelector('[data-testid="ppo-banner-pick"]')?.getAttribute('aria-label')).toBe('Change banner');
        expect(host.querySelector('.ppo-avatar-btn')?.getAttribute('aria-label')).toBe('Change profile photo');
    });

    it('keeps the Message button as a picture: inert and hidden from assistive tech', () => {
        render({ name: 'Zalais' });
        const actions = host.querySelector('.ppo-actions') as HTMLElement;
        expect(actions.hasAttribute('inert')).toBe(true);
        expect(actions.getAttribute('aria-hidden')).toBe('true');
    });
});
