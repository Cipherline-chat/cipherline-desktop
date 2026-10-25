// @vitest-environment jsdom
/**
 * Profile v3: the PREVIEW (ProfilePopoutCard - quick, never long, everything
 * else one click away) and the FULL profile (ProfileFullView - tabs, keyboard,
 * Escape, the showcase in the owner's order, mutuals, achievements,
 * integrations). Ported from the retired one-card test where the behaviour
 * still applies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reduced = vi.hoisted(() => ({ on: false }));
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: q.includes('reduce') ? reduced.on : false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});
const ach = vi.hoisted(() => ({ data: null as null | { unlocked: Array<{ id: string; month: string }> }, calls: [] as Array<string | null> }));
vi.mock('../../hooks/useUserAchievements', () => ({
    useUserAchievements: (id: string | null) => { ach.calls.push(id); return { data: id ? ach.data : null, loading: false, error: false, reload: () => {} }; },
    useAchievementProgress: () => null,
}));
vi.mock('../../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: () => null, evictAvatar: () => {}, avatarUrlMime: () => null, peekAvatarUrl: () => null,
}));

import { ProfilePopoutCard } from './ProfilePopoutCard';
import { ProfileFullView } from './ProfileFullView';
import type { ProfileCardData } from './profileCardData';
import { ACHIEVEMENTS } from '../../utils/achievements/catalog';
import { __resetEscapeStackForTests } from '../../utils/escapeStack';

const h = React.createElement as (...a: any[]) => React.ReactElement;
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

const bare: ProfileCardData = {
    name: 'jonas', discriminator: 31, theme: null, decoration: null, effect: null,
    blocks: ['steam', 'games', 'links'], topAchievements: [], games: [], links: [], interests: [],
    achievementCount: 0, mostPlayed: [],
};
const maxed: ProfileCardData = {
    ...bare, name: 'Dawson', isPro: true, proSince: '2025-02', level: 9,
    badges: [{ badge_id: 'b1', icon: 'star', color: 'gold', label: 'Founder', sort_order: 0 }],
    bio: 'Building the quiet internet.', bioFriendsOnly: true, timeZone: 'America/Toronto', localTimeFriendsOnly: true, friendsSince: '2024-10',
    theme: { primary: '#ffc94d', accent: '#ff6b5e' }, decoration: 'keys-crown', effect: 'plankton',
    blocks: ['achievements', 'links', 'games', 'interests', 'steam', 'most_played'], topAchievements: ['voice-500h', 'streak-100', 'eggs-30'],
    steam: { steamId: '76561197960287930', personaName: 'gaben', avatar: null }, games: ['Hollow Knight', 'Celeste'], gamesFriendsOnly: true,
    links: [{ platform: 'github', handle: 'dawson' }], linksFriendsOnly: true, interests: ['chess', 'coffee'], myInterests: ['chess'],
    achievementCount: 14, mostPlayed: [{ game: 'Hades', minutes: 300 }],
};
const mutuals = {
    friends: [{ user_id: 'f1', username: 'ana', discriminator: 7, avatar_url: null }],
    servers: [{ server_id: 's1', name: 'Neon Guild' }, { server_id: 's2', name: 'Design' }],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    __resetEscapeStackForTests();
    reduced.on = false;
    ach.data = null; ach.calls = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const q = (sel: string) => host.querySelector(sel);
const qa = (sel: string) => [...host.querySelectorAll(sel)];
const popout = (data: ProfileCardData | null, extra: Record<string, unknown> = {}) =>
    act(() => root.render(h(ProfilePopoutCard, { userId: 'u1', token: 't', isSelf: false, data, avatarId: null, bannerId: null, ...extra })));
const full = (data: ProfileCardData | null, extra: Record<string, unknown> = {}) =>
    act(() => root.render(h(ProfileFullView, { userId: 'u1', token: 't', isSelf: false, data, profile: null, avatarId: null, bannerId: null, onClose: () => {}, ...extra })));

describe('the preview popover', () => {
    it('a bare profile is a clean card: no highlight, no mutuals line, no facts', () => {
        popout(bare);
        expect(q('[data-testid^="profile-highlight"]')).toBeNull();
        expect(q('[data-testid="profile-mutuals"]')).toBeNull();
        expect(q('.ppo-facts')).toBeNull();
    });

    it('stays short: ONE highlight from the showcase (in the owner\'s order), never the sections themselves', () => {
        popout(maxed, { mutuals });
        expect(qa('[data-testid^="profile-highlight"]')).toHaveLength(1);
        expect(q('[data-testid="profile-highlight-achievements"]')).not.toBeNull();
        for (const t of ['profile-steam', 'profile-links', 'most-played-panel', 'achievements-summary']) expect(q(`[data-testid="${t}"]`)).toBeNull();
    });

    it('every way into the full profile goes there, on the right tab', () => {
        const openFull = vi.fn();
        popout(maxed, { mutuals, onOpenFull: openFull });
        act(() => (q('.ppo-avatar-btn') as HTMLButtonElement).click());
        expect(openFull).toHaveBeenLastCalledWith('overview');
        act(() => (q('.ppo-name-btn') as HTMLButtonElement).click());
        expect(openFull).toHaveBeenLastCalledWith('overview');
        act(() => (q('[data-testid="profile-mutuals"]') as HTMLButtonElement).click());
        expect(openFull).toHaveBeenLastCalledWith('friends');
        expect(q('[data-testid="profile-mutuals"]')!.textContent).toBe('1 mutual friend · 2 mutual servers');
        act(() => (q('[data-testid="profile-highlight-achievements"]') as HTMLButtonElement).click());
        expect(openFull).toHaveBeenLastCalledWith('achievements');
        act(() => (q('[data-testid="profile-level"]') as HTMLButtonElement).click());
        expect(openFull).toHaveBeenLastCalledWith('achievements');
    });

    it('your own card has no mutuals; friends-only fields carry the lock', () => {
        popout(maxed, { isSelf: true, mutuals });
        expect(q('[data-testid="profile-mutuals"]')).toBeNull();
        expect(q('[data-testid="profile-bio"] .pcd-lock')).not.toBeNull();
        expect(q('[data-field="local_time"] .pcd-lock')).not.toBeNull();
    });

    it('the effect loops (continuous while the window is in front), and the entrance plays once', () => {
        vi.useFakeTimers();
        try {
            popout(maxed);
            expect(q('.pc-fx')!.getAttribute('data-loop')).toBe('true');
            expect(q('.ppo')!.getAttribute('data-enter')).toBe('true');
            act(() => { vi.advanceTimersByTime(10_000); });
            expect(q('.pc-fx')!.getAttribute('data-phase')).toBe('play');
            expect(q('.ppo')!.hasAttribute('data-enter')).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it('reduced motion: the effect rests and nothing enters', () => {
        reduced.on = true;
        popout(maxed);
        expect(q('.pc-fx')!.getAttribute('data-phase')).toBe('rest');
        expect(q('.pc-fx')!.hasAttribute('data-loop')).toBe(false);
        expect(q('.ppo')!.hasAttribute('data-enter')).toBe(false);
    });

    it('a picture of the actions (the Settings preview) is inert', () => {
        popout(maxed, { actions: h('button', null, 'Message'), actionsInert: true });
        expect(q('.ppo-actions')!.hasAttribute('inert')).toBe(true);
    });
});

describe('the full profile', () => {
    it('tabs: Overview, Achievements, Mutual friends, Mutual servers, Integrations - with counts', () => {
        full(maxed, { mutuals, connections: [{ platform: 'github', name: 'dawson' }] });
        expect(qa('[role="tab"]').map((t) => t.textContent)).toEqual(['Overview', 'Achievements14', 'Mutual friends1', 'Mutual servers2', 'Integrations1']);
    });

    it('your own profile: no mutual tabs, Integrations always (to connect accounts)', () => {
        full(bare, { isSelf: true });
        expect(qa('[role="tab"]').map((t) => t.textContent)).toEqual(['Overview', 'Achievements0', 'Integrations']);
    });

    it('Overview draws the owner\'s showcase in their order, all of it (no fold), plus the rail', () => {
        full(maxed, { mutuals, activities: [{ kind: 'listening', title: 'Song', detail: 'Artist', source: 'spotify' }] });
        const order = qa('.pfp-main > section').map((s) => s.getAttribute('data-testid'));
        expect(order).toEqual([null, 'achievements-summary', 'profile-links', 'profile-widgets', 'profile-interests', 'profile-steam', 'most-played-panel']);
        expect(q('.pfp-rail [data-testid="profile-activity"]')!.textContent).toContain('Listening to');
        expect(q('[data-testid="friends-since"]')).not.toBeNull();
    });

    it('arrow keys move between tabs; mutual rows open that person / that server', () => {
        const openUser = vi.fn(); const openServer = vi.fn();
        full(maxed, { mutuals, onOpenUser: openUser, onOpenServer: openServer });
        const tabs = () => qa('[role="tab"]') as HTMLButtonElement[];
        act(() => tabs()[0].focus());
        act(() => { tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
        expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tabs()[1]);
        act(() => (q('[data-testid="profile-full-tab-friends"]') as HTMLButtonElement).click());
        act(() => (q('.pcd-row') as HTMLButtonElement).click());
        expect(openUser).toHaveBeenCalledWith('f1', expect.any(Object));
        act(() => (q('[data-testid="profile-full-tab-servers"]') as HTMLButtonElement).click());
        act(() => (qa('.pcd-row')[1] as HTMLButtonElement).click());
        expect(openServer).toHaveBeenCalledWith('s2');
    });

    it('Achievements tab: the unlocked grid, Unlocked / Locked, no Back button (it is a tab, not a sheet)', () => {
        ach.data = { unlocked: [{ id: 'voice-100h', month: '2026-01' }, { id: 'night-shift', month: '2026-02' }] };
        full(maxed, { initialTab: 'achievements' });
        expect(q('[data-testid="achievements-back"]')).toBeNull();
        expect(qa('.pcd-grid > li')).toHaveLength(2);
        act(() => (q('[data-testid="achievements-filter-locked"]') as HTMLButtonElement).click());
        expect(qa('.pcd-grid > li')).toHaveLength(ACHIEVEMENTS.length - 2);
    });

    it('"View all" on Overview opens the Achievements tab; the full list is only fetched when shown', () => {
        full({ ...maxed, topAchievements: ['voice-500h'] });
        expect(ach.calls.every((c) => c === null)).toBe(true);
        act(() => (q('[data-testid="achievements-view-all"]') as HTMLButtonElement).click());
        expect(q('[data-testid="profile-full-panel-achievements"]')).not.toBeNull();
        expect(ach.calls.at(-1)).toBe('u1');
    });

    it('Escape closes it; the close button does too; Tab stays inside', () => {
        const onClose = vi.fn();
        full(maxed, { onClose, mutuals });
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(onClose).toHaveBeenCalledTimes(1);
        act(() => (q('[data-testid="profile-full-close"]') as HTMLButtonElement).click());
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(q('[role="dialog"]')!.getAttribute('aria-modal')).toBe('true');
    });

    it('the verified Steam block opens Steam through the link opener', () => {
        const open = vi.fn();
        full(maxed, { onOpenLink: open });
        act(() => (q('.pcd-steam') as HTMLButtonElement).click());
        expect(open).toHaveBeenLastCalledWith({ platform: 'steam', handle: '76561197960287930' });
    });

    it('shared interests are highlighted for someone else', () => {
        full(maxed);
        expect(q('[data-shared="true"]')!.textContent).toContain('Chess');
    });
});

describe('styles', () => {
    const frames = (css: string) => {
        const out: string[] = [];
        for (let at = css.indexOf('@keyframes'); at >= 0; at = css.indexOf('@keyframes', at + 1)) {
            let i = css.indexOf('{', at), depth = 0;
            for (; i < css.length; i++) { if (css[i] === '{') depth++; else if (css[i] === '}' && --depth === 0) break; }
            out.push(css.slice(at, i + 1));
        }
        return out;
    };
    it.each(['../../styles/profile-v3.css', '../../styles/profile-card.css', '../../styles/profile-motion.css'])('%s: transform/opacity only, reduced motion stops it, no transition: all', (f) => {
        const css = read(f);
        for (const k of frames(css)) expect(k.replace(/@keyframes\s+[\w-]+/, '')).not.toMatch(/(?:^|[\s;{])(width|height|top|left|right|bottom|margin|padding|filter|box-shadow|stroke-dashoffset)\s*:/);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/);
        expect(css).not.toMatch(/transition:\s*all/);
    });
    it('profile cosmetics pause only with the WINDOW (not after input idleness), and the pause beats the loop shorthand', () => {
        const css = read('../../styles/profile-motion.css');
        expect(css).toMatch(/:root\[data-cl-motion="idle"\]:not\(\[data-cl-window="inactive"\]\) \.pc-fx > i \{ animation-play-state: running; \}/);
        expect(css).toMatch(/:root\[data-cl-window="inactive"\] \.pc-fx > i \{ animation-play-state: paused !important; \}/);
    });
});
