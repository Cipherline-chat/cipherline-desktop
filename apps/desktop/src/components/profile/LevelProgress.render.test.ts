// @vitest-environment jsdom
/**
 * Pressing someone's level opens their achievement progress (owner 2026-11-13):
 * the full profile's Achievements tab, topped by the level, its points and a
 * bar to the next level; then their unlocked and locked achievements (secret
 * locked ones stay secret), the easter-egg COUNT only, and no per-achievement
 * progress numbers for anyone but yourself.
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
const ach = vi.hoisted(() => ({
    data: null as null | { unlocked: Array<{ id: string; month: string }> },
    progress: null as null | Record<string, { current: number; target: number }>,
}));
vi.mock('../../hooks/useUserAchievements', () => ({
    useUserAchievements: (id: string | null) => ({ data: id ? ach.data : null, loading: false, error: false, reload: () => {} }),
    useAchievementProgress: () => ach.progress,
}));
vi.mock('../../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: () => null, evictAvatar: () => {}, avatarUrlMime: () => null, peekAvatarUrl: () => null,
}));

import { ProfileFullView } from './ProfileFullView';
import { ProfilePopoutCard } from './ProfilePopoutCard';
import { buildProfileCardData } from './buildProfileCardData';
import type { ProfileCardData } from './profileCardData';
import { ACHIEVEMENTS } from '../../utils/achievements/catalog';
import { EGG_IDS } from '../../utils/eggProgress';
import { __resetEscapeStackForTests } from '../../utils/escapeStack';

const h = React.createElement as (...a: any[]) => React.ReactElement;
const eggBadge = (count: number) => ({ badge_id: 'egg-hunter', icon: 'egg-tier-1', color: 'cyan', label: `Egg hunter · Tide Pooler · ${count} easter eggs found`, sort_order: 1000, count });

// A mid-level user: voice-500h (silver 3) + streak-100 (silver 3) + msgs-10 (bronze 1) + night-shift (secret silver 3) = 10, + 2... eggs below
// the badge threshold are unknown to viewers; the server's level_points carries them: 12 -> level 3, "12 of 16".
const UNLOCKED = [
    { id: 'voice-500h', month: '2026-03' }, { id: 'streak-100', month: '2026-05' }, { id: 'msgs-10', month: '2026-01' }, { id: 'night-shift', month: '2026-06' },
];
const mira: ProfileCardData = {
    name: 'mira', discriminator: 4, theme: null, decoration: null, effect: null,
    blocks: ['achievements'], topAchievements: [], games: [], links: [], interests: [],
    achievementCount: UNLOCKED.length, mostPlayed: [], level: 3, levelPoints: 12,
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    __resetEscapeStackForTests();
    ach.data = { unlocked: UNLOCKED };
    ach.progress = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const q = (sel: string) => host.querySelector(sel);
const qa = (sel: string) => [...host.querySelectorAll(sel)];
const full = (data: ProfileCardData | null, extra: Record<string, unknown> = {}) =>
    act(() => root.render(h(ProfileFullView, { userId: 'u1', token: 't', isSelf: false, data, profile: null, avatarId: null, bannerId: null, onClose: () => {}, ...extra })));
const level = () => q('[data-testid="profile-level"]') as HTMLButtonElement | null;
const press = (el: Element) => act(() => (el as HTMLButtonElement).click());

describe('opening someone\'s level', () => {
    it('the level is a real button (so Enter / Space activate it) that opens the Achievements tab and focuses the level section', () => {
        full(mira);
        expect(q('[data-testid="profile-full-panel-overview"]')).not.toBeNull();
        expect(level()!.tagName).toBe('BUTTON');
        expect(level()!.getAttribute('type')).toBe('button');
        expect(level()!.getAttribute('aria-label')).toBe('Profile level 3 of 10. Show achievement progress');
        expect(q('[data-testid="level-progress"]')).toBeNull();
        press(level()!);
        expect(q('[data-testid="profile-full-panel-achievements"]')).not.toBeNull();
        expect(document.activeElement).toBe(q('[data-testid="level-progress"]'));
    });

    it('shows level, points and the bar to the next level', () => {
        full(mira);
        press(level()!);
        expect(q('.plp-title')!.textContent).toBe('Level 3');
        expect(q('[data-testid="level-progress-line"]')!.textContent).toBe('12 of 16 points to level 4');
        expect(q('[data-testid="level-progress-togo"]')!.textContent).toBe('4 points to go');
        const bar = q('[data-testid="level-progress-bar"]')!;
        expect(bar.getAttribute('aria-valuenow')).toBe('12');
        expect(bar.getAttribute('aria-valuemax')).toBe('16');
        expect((bar.querySelector('i') as HTMLElement).style.transform).toBe('scaleX(0.75)');
        expect(q('.plp-src')!.textContent).toContain('4 achievements');
    });

    it('level 0 (a couple of bronze) aims at the 3-point level 1', () => {
        ach.data = { unlocked: [{ id: 'msgs-10', month: '2026-01' }] };
        full({ ...mira, level: 0, levelPoints: 1, achievementCount: 1 }, { initialTab: 'achievements' });
        expect(q('[data-testid="level-progress-line"]')!.textContent).toBe('1 of 3 points to level 1');
    });

    it('max level: "Max", a full bar, the total, nothing "to go"', () => {
        full({ ...mira, level: 10, levelPoints: 117 });
        press(level()!);
        expect(q('[data-testid="level-progress"]')!.getAttribute('data-max')).toBe('true');
        expect(q('.plp-max')!.textContent).toBe('Max');
        expect(q('[data-testid="level-progress-line"]')!.textContent).toBe('Max level · 117 points');
        expect(q('[data-testid="level-progress-togo"]')).toBeNull();
        expect((q('[data-testid="level-progress-bar"] i') as HTMLElement).style.transform).toBe('scaleX(1)');
    });

    it('a level from easter eggs alone still opens somewhere (the tab exists without achievements)', () => {
        ach.data = { unlocked: [] };
        full({ ...mira, level: 2, levelPoints: 5, achievementCount: 0, badges: [eggBadge(5)] });
        press(level()!);
        expect(q('[data-testid="profile-full-panel-achievements"]')).not.toBeNull();
        expect(q('[data-testid="level-progress-line"]')!.textContent).toBe('5 of 9 points to level 3');
    });

    it('positive control: without a level the tab is absent and the Achievements tab is not offered', () => {
        ach.data = { unlocked: [] };
        full({ ...mira, level: 0, levelPoints: 0, achievementCount: 0 });
        expect(level()).toBeNull();
        expect(q('[data-testid="profile-full-tab-achievements"]')).toBeNull();
    });
});

describe('what the viewer sees of the achievements', () => {
    it('unlocked: title, description, tier and month', () => {
        full(mira, { initialTab: 'achievements' });
        expect(qa('.pcd-grid > li').map((li) => li.getAttribute('data-testid'))).toEqual(
            expect.arrayContaining(['achievement-voice-500h', 'achievement-streak-100', 'achievement-msgs-10', 'achievement-night-shift']));
        expect(qa('.pcd-grid > li')).toHaveLength(4);
        act(() => { (q('[data-testid="achievement-voice-500h"] button') as HTMLButtonElement).focus(); });
        const detail = q('[data-testid="achievement-detail"]')!.textContent!;
        const def = ACHIEVEMENTS.find((a) => a.id === 'voice-500h')!;
        expect(detail).toContain(def.name);
        expect(detail).toContain(def.description);
        expect(detail).toContain('Silver');
        expect(detail).toMatch(/Unlocked Mar(ch)? 2026/);
        // A secret one they HAVE unlocked is shown by name.
        act(() => { (q('[data-testid="achievement-night-shift"] button') as HTMLButtonElement).focus(); });
        expect(q('[data-testid="achievement-detail"]')!.textContent).toContain('Night Shift');
    });

    it('locked: title + description + tier; secret locked ones stay "Secret achievement"', () => {
        full(mira, { initialTab: 'achievements' });
        press(q('[data-testid="achievements-filter-locked"]')!);
        expect(qa('.pcd-grid > li')).toHaveLength(ACHIEVEMENTS.length - UNLOCKED.length);
        const lockedPublic = ACHIEVEMENTS.find((a) => !a.secret && !UNLOCKED.some((u) => u.id === a.id))!;
        act(() => { (q(`[data-testid="achievement-${lockedPublic.id}"] button`) as HTMLButtonElement).focus(); });
        const d = q('[data-testid="achievement-detail"]')!.textContent!;
        expect(d).toContain(lockedPublic.name);
        expect(d).toContain(lockedPublic.description);
        expect(d).toMatch(/(Bronze|Silver|Gold) · Locked/);
        const secret = ACHIEVEMENTS.find((a) => a.secret && !UNLOCKED.some((u) => u.id === a.id))!;
        const btn = q(`[data-testid="achievement-${secret.id}"] button`) as HTMLButtonElement;
        expect(btn.getAttribute('aria-label')).toBe('Secret achievement, locked');
        act(() => btn.focus());
        const s = q('[data-testid="achievement-detail"]')!.textContent!;
        expect(s).toContain('Secret achievement');
        expect(s).not.toContain(secret.name);
        expect(s).not.toContain(secret.description);
        expect(host.textContent).not.toContain(secret.name);
    });

    it('no per-achievement progress numbers for someone else, even if this device has its own counters', () => {
        ach.progress = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, { current: 37, target: 100 }]));
        full(mira, { initialTab: 'achievements' });
        press(q('[data-testid="achievements-filter-locked"]')!);
        for (const b of qa('.pcd-grid-btn')) { act(() => (b as HTMLButtonElement).focus()); expect(q('[data-testid="achievement-detail"]')!.textContent).not.toMatch(/37/); }
        expect(q('.pcd-detail .pcd-prog')).toBeNull();
        expect(q('.pam-prog')).toBeNull();
    });

    it('positive control: on your OWN profile the local progress does show', () => {
        ach.progress = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, { current: 37, target: 100 }]));
        full(mira, { initialTab: 'achievements', isSelf: true });
        press(q('[data-testid="achievements-filter-locked"]')!);
        expect(q('[data-testid="achievement-detail"]')!.textContent).toMatch(/37/);
    });

    it('easter eggs: only the count from the Egg hunter badge, never which eggs', () => {
        full({ ...mira, badges: [eggBadge(4)] }, { initialTab: 'achievements' });
        expect(q('[data-testid="level-progress-eggs"]')!.textContent).toBe('4 easter eggs found');
        const text = host.textContent!;
        for (const id of EGG_IDS) expect(text).not.toContain(id);
    });

    it('no Egg hunter badge (fewer than 3 found, or none): nothing said about eggs', () => {
        full(mira, { initialTab: 'achievements' });
        expect(q('[data-testid="level-progress-eggs"]')).toBeNull();
        expect(host.textContent).not.toMatch(/easter eggs? found/);
    });
});

describe('visibility', () => {
    it('a level the server did not share: nothing to press, and the tab says it is not shared', () => {
        full({ ...mira, level: undefined, levelPoints: null });
        expect(level()).toBeNull();
        press(q('[data-testid="profile-full-tab-achievements"]')!);
        const sec = q('[data-testid="level-progress"]')!;
        expect(sec.getAttribute('data-state')).toBe('hidden');
        expect(sec.textContent).toContain('Level not shared');
        expect(sec.textContent).toContain('mira doesn’t share their level with you.');
        expect(q('[data-testid="level-progress-bar"]')).toBeNull();
    });

    it('older server (no level_points): estimated from the public list when it agrees with the level, else the level only', () => {
        // voice-500h 3 + streak-100 3 + msgs-10 1 + night-shift 3 = 10 -> level 3 agrees.
        full({ ...mira, levelPoints: null }, { initialTab: 'achievements' });
        expect(q('[data-testid="level-progress-line"]')!.textContent).toBe('10 of 16 points to level 4');
        act(() => root.unmount());
        root = createRoot(host);
        full({ ...mira, level: 5, levelPoints: null }, { initialTab: 'achievements' });
        expect(q('[data-testid="level-progress-line"]')!.textContent).toBe('Level 5 of 10');
        expect(q('[data-testid="level-progress-togo"]')).toBeNull();
    });

    it('buildProfileCardData reads level_points; a non-number is unknown', () => {
        const base = { user_id: 'u1', username: 'mira', discriminator: 4, level: 3, achievement_count: 4 } as any;
        const ctx = { isOwn: false, anniversary: 0, myInterests: null, mostPlayed: [], verified: false };
        expect(buildProfileCardData({ ...base, level_points: 12 }, ctx).levelPoints).toBe(12);
        expect(buildProfileCardData({ ...base, level_points: '12' }, ctx).levelPoints).toBeNull();
        expect(buildProfileCardData(base, ctx).levelPoints).toBeNull();
    });
});

describe('the preview card', () => {
    it('pressing the level opens the full profile on the Achievements tab', () => {
        const openFull = vi.fn();
        act(() => root.render(h(ProfilePopoutCard, { userId: 'u1', token: 't', isSelf: false, data: mira, avatarId: null, bannerId: null, onOpenFull: openFull })));
        press(level()!);
        expect(openFull).toHaveBeenCalledWith('achievements');
    });
});
