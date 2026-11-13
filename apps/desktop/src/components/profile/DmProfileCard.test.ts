// @vitest-environment jsdom
/**
 * The DM right-hand panel's profile card is the NEW profile card
 * (ProfilePopoutCard via buildProfileCardData), not the old minimal
 * banner + avatar + name block.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: q.includes('reduce'), media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});
const most = vi.hoisted(() => ({ calls: [] as Array<string | null | undefined> }));
vi.mock('../../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: () => null, evictAvatar: () => {}, avatarUrlMime: () => null, peekAvatarUrl: () => null,
}));
vi.mock('../../hooks/useMostPlayed', () => ({
    useMostPlayed: (id: string | null | undefined) => { most.calls.push(id); return { games: [], loading: false }; },
}));
vi.mock('../../hooks/useProfileRelations', () => ({
    useMutuals: () => ({ data: { friends: [{ user_id: 'f1', username: 'ana', discriminator: 7, avatar_url: null }], servers: [{ server_id: 's1', name: 'Neon' }] }, loading: false }),
    useSteamCard: () => null,
    visibleSteamActivity: () => null,
}));
vi.mock('../../hooks/useProfileActivity', () => ({
    useProfileActivity: (a: { liveGame: string | null }) => (a.liveGame ? [{ kind: 'playing', title: a.liveGame, source: 'app' }] : []),
}));
vi.mock('../../utils/keyVerification', () => ({ getVerificationState: () => 'unverified' }));
vi.mock('../../utils/profileMoments', () => ({ anniversaryYearsFor: () => 0 }));
vi.mock('../ProfileCosmetics', () => ({
    AvatarDecoration: ({ children }: { children: React.ReactNode }) => children,
    ProfileEffect: () => null,
}));

import { DmProfileCard } from './DmProfileCard';
import { primeProfile, __resetProfileCache } from '../../utils/profileCache';

const h = React.createElement as (...a: any[]) => React.ReactElement;
const here = dirname(fileURLToPath(import.meta.url));

let host: HTMLDivElement;
let root: Root;
const onOpenFull = vi.fn();
const mount = (p: Partial<React.ComponentProps<typeof DmProfileCard>> = {}) => act(() => {
    root.render(h(DmProfileCard, { userId: 'u2', token: 't', currentUserId: 'me', isFriend: true, onOpenFull, ...p }));
});

beforeEach(() => {
    __resetProfileCache();
    most.calls = [];
    onOpenFull.mockReset();
    primeProfile({
        user_id: 'u2', username: 'Zalais', discriminator: 4821, bio: 'night owl', status: 'online',
        is_pro: true, level: 3, high_five_count: 2, friends_only_fields: ['bio'],
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('DmProfileCard', () => {
    it('is the new profile card: name#tag, presence, bio with its friends-only lock', () => {
        mount({ status: { status: 'online', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null } });
        expect(host.querySelector('[data-testid="dm-profile-card"].ppo')).not.toBeNull();
        expect(host.querySelector('.ppo-name')?.textContent).toContain('Zalais');
        expect(host.querySelector('.ppo-tag')?.textContent).toBe('#4821');
        expect(host.textContent).toContain('Online');
        expect(host.querySelector('[data-testid="profile-bio"]')?.textContent).toContain('night owl');
        expect(host.querySelector('[data-testid="profile-bio"] .pcd-lock')).not.toBeNull();
    });

    it('is the small card: no mutuals, showcase highlight, high five or Open profile', () => {
        primeProfile({
            user_id: 'u2', username: 'Zalais', discriminator: 4821, bio: 'night owl', status: 'online', high_five_count: 2,
            showcase: { blocks: ['achievements', 'interests'], top_achievements: ['msgs-50000'] }, interests: ['music'], achievement_count: 9,
        });
        mount({ isFriend: true });
        expect(host.querySelector('[data-testid="profile-mutuals"]')).toBeNull();
        expect(host.querySelector('.ppo-highlight, [data-testid^="highlight"]')).toBeNull();
        expect(host.textContent).not.toMatch(/Achievements|unlocked/);
        expect(host.querySelector('.pcd-hf, [class*="hf"]')).toBeNull();
        expect(host.querySelector('.ppo-actions')).toBeNull();
        expect(most.calls.every((c) => c == null)).toBe(true);
    });

    it('shows what they are playing right now (the activity row)', () => {
        mount({ status: { status: 'online', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: 'Hollow Knight' } });
        expect(host.textContent).toContain('Hollow Knight');
    });

    it('does not offer the game when they are offline', () => {
        mount({ status: { status: 'offline', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: 'Hollow Knight' } });
        expect(host.textContent).not.toContain('Hollow Knight');
    });

    it('has no "Open profile" button; the avatar and the name open the full profile', () => {
        mount();
        expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Open profile'))).toBe(false);
        act(() => { (host.querySelector('.ppo-avatar-btn') as HTMLButtonElement).click(); });
        act(() => { (host.querySelector('.ppo-name-btn') as HTMLButtonElement).click(); });
        expect(onOpenFull).toHaveBeenCalledTimes(2);
    });

    it('the level badge opens the full profile ON the Achievements tab', () => {
        mount();
        const lvl = host.querySelector('[aria-label*="Show achievement progress"]') as HTMLElement | null;
        expect(lvl).not.toBeNull();
        act(() => { lvl!.click(); });
        expect(onOpenFull).toHaveBeenCalledWith('achievements');
    });

    it('does not replay the entrance when it mounts (it lives in a panel)', () => {
        mount();
        expect(host.querySelector('.ppo')?.getAttribute('data-enter')).toBeNull();
    });
});

describe('Dashboard DM panel wiring', () => {
    const dash = readFileSync(join(here, '../Dashboard.tsx'), 'utf8');
    it('renders DmProfileCard for a DM, keyed by the partner, whose avatar and name go to the full profile', () => {
        expect(dash).toContain('<DmProfileCard');
        expect(dash).toMatch(/key=\{activeChat\.other_user_id\}/);
        expect(dash).toContain('{ full: true, tab }');
    });
    it('no longer draws the old minimal card', () => {
        expect(dash).not.toContain('DMContext: an 84px');
        expect(dash).not.toContain('dmPartnerProfile');
    });
});
