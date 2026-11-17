// @vitest-environment jsdom
/**
 * The Steam showcase surfaces (2026-10-26): the full panel, the one-row
 * highlight on the profile preview and the overview block, and the privacy
 * hints that name the exact Steam setting. Data in the shape the API sends
 * (readSteamActivity over a recorded-shape fixture).
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
const steam = vi.hoisted(() => ({ card: null as unknown, asked: [] as Array<string | null> }));
vi.mock('../../hooks/useIntegrations', async (orig) => ({ ...(await orig<object>()), useArt: () => null, useUserIntegrations: () => ({ spotify: [] }) }));
const refresh = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../../hooks/useProfileRelations', async (orig) => ({
    ...(await orig<object>()),
    refreshSteamCard: refresh,
    useSteamCard: (id: string | null) => { steam.asked.push(id); return id ? steam.card : null; },
}));
vi.mock('../../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: () => null, evictAvatar: () => {}, avatarUrlMime: () => null, peekAvatarUrl: () => null,
}));

import { SteamHighlight, SteamPrivateNotice, SteamShowcase } from './SteamShowcase';
import { ProfileIntegrationsPanels } from './ProfileIntegrationsPanels';
import { readSteamActivity, steamHasShowcaseStats, steamNeedsOwnerNotice, steamPrivacyText, type SteamActivity } from '../../utils/integrations/api';
import { ProfilePopoutCard } from '../profile/ProfilePopoutCard';
import type { ProfileCardData } from '../profile/profileCardData';

const h = React.createElement as (...a: any[]) => React.ReactElement;

export const WIRE = {
    private: false, games_private: false, level: 42,
    xp: { into_level: 145, level_span: 300, to_next: 155 }, badge_count: 37, member_since: '2012-03',
    game_count: 312, total_minutes: 110_400,
    top_games: [
        { app_id: 570, name: 'Dota 2', minutes_total: 60_000, art: { capsule: 'steam:570:capsule', header: null, portrait: null, icon: null } },
        { app_id: 730, name: 'Counter-Strike 2', minutes_total: 21_000, art: { capsule: 'steam:730:capsule', header: null, portrait: null, icon: null } },
        { app_id: 1086940, name: "Baldur's Gate 3", minutes_total: 9_600, art: { capsule: 'steam:1086940:capsule', header: null, portrait: null, icon: null } },
    ],
    now_playing: { app_id: 1086940, name: "Baldur's Gate 3", art: { capsule: 'steam:1086940:capsule', header: null, portrait: null, icon: null } },
    recent: [
        { app_id: 1086940, name: "Baldur's Gate 3", minutes_2w: 840, minutes_total: 9_600, art: { capsule: 'steam:1086940:capsule', header: null, portrait: null, icon: null } },
        { app_id: 570, name: 'Dota 2', minutes_2w: 95, minutes_total: 60_000, art: { capsule: 'steam:570:capsule', header: null, portrait: null, icon: null } },
    ],
    achievements: {
        app_id: 1086940, game: "Baldur's Gate 3", unlocked: 23, total: 54,
        recent: [
            { name: 'Descent From Avernus', description: 'Complete Act One.', unlocked_on: '2026-10-21', icon: null },
            { name: 'The Gnome Ascendant', description: 'Free the gnome.', unlocked_on: '2026-10-19', icon: null },
        ],
    },
};
const activity = (o: object = {}): SteamActivity => readSteamActivity({ ...WIRE, ...o })!;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); steam.asked = []; });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (el: React.ReactElement) => act(() => root.render(el));
const text = () => host.textContent ?? '';

describe('SteamShowcase (full panel)', () => {
    it('identity, level + XP to the next level, the headline numbers, playing now, most played, two weeks, achievements', () => {
        render(h(SteamShowcase, { activity: activity(), token: 't', personaName: 'Gaben', avatar: null }));
        const t = text();
        expect(t).toContain('Gaben');
        expect(t).toContain('Member since Mar 2012');
        expect(t).toContain('155 XP to 43');
        expect(host.querySelector('[data-stat="games"]')!.textContent).toBe('312games');
        expect(host.querySelector('[data-stat="hours"]')!.textContent).toBe('1,840hours played');
        expect(host.querySelector('[data-stat="badges"]')!.textContent).toBe('37badges');
        expect(host.querySelector('[data-stat="years"]')!.textContent).toMatch(/^1\dyears on Steam$/);
        expect(host.querySelector('[data-testid="steam-now-playing"]')!.textContent).toContain("Baldur's Gate 3");
        expect(t).toContain('Most played');
        expect(t).toContain('1,000 h'); // Dota 2, all time
        expect(t).toContain('Last two weeks');
        expect(host.querySelector('[data-testid="steam-achievements"]')!.textContent).toContain('23 / 54');
        expect(t).toContain('Descent From Avernus');
        expect(host.querySelector('[data-testid="steam-privacy-hint"]')).toBeNull();
    });

    it('private game details: names the exact Steam setting for the owner, says nothing to others', () => {
        render(h(SteamShowcase, { activity: activity({ games_private: true }), token: 't', isSelf: true }));
        expect(host.querySelector('[data-testid="steam-privacy-hint"]')!.textContent).toContain('Game details: Public');
        expect(text()).not.toContain('Most played');
        render(h(SteamShowcase, { activity: activity({ games_private: true }), token: 't' }));
        expect(host.querySelector('[data-testid="steam-privacy-hint"]')).toBeNull();
        expect(text()).not.toMatch(/private/i);
    });

    it('private profile and hidden playtime hints', () => {
        expect(steamPrivacyText(activity({ private: true }), true)).toContain('set My profile to Public and Game details to Public');
        expect(steamPrivacyText(activity({ total_minutes: 0 }), true)).toContain('Always keep my total playtime private');
        expect(steamPrivacyText(activity({ total_minutes: 0 }), false)).toBeNull();
        expect(steamPrivacyText(activity(), true)).toBeNull();
    });
});

describe('SteamHighlight (one row)', () => {
    it('level, playing now, games / hours / years', () => {
        render(h(SteamHighlight, { activity: activity(), token: 't', onOpen: () => {} }));
        const row = host.querySelector('[data-testid="steam-highlight"]')!;
        expect(row.tagName).toBe('BUTTON');
        expect(row.textContent).toContain('Playing');
        expect(row.textContent).toContain("Baldur's Gate 3");
        expect(row.textContent).toMatch(/312 games · 1,840 h · 1\d yrs/);
        expect(row.querySelector('.ig-lvl')!.textContent).toBe('42');
    });

    it('nothing playing: the most played game; private: just the level, no "private" text', () => {
        render(h(SteamHighlight, { activity: activity({ now_playing: null }), token: 't' }));
        expect(text()).toContain('Dota 2');
        render(h(SteamHighlight, { activity: activity({ private: true }), token: 't', isSelf: true }));
        expect(text()).toContain('Level 42');
        expect(text()).not.toMatch(/private/i);
        render(h(SteamHighlight, { activity: activity({ games_private: true, now_playing: null }), token: 't' }));
        expect(text()).toContain('Level 42');
        expect(text()).not.toMatch(/private/i);
    });
});

describe('the profile preview carries the Steam highlight', () => {
    const data = (o: Partial<ProfileCardData> = {}): ProfileCardData => ({
        name: 'Gabe', discriminator: 1, theme: null, decoration: null, effect: null,
        blocks: ['links'], topAchievements: [], games: [], links: [], interests: [], achievementCount: null, mostPlayed: [],
        steam: { steamId: '76561197960287930', personaName: 'Gaben', avatar: null }, ...o,
    });
    const card = (o: object = {}) => ({ steam_id: '76561197960287930', persona_name: 'Gaben', avatar: null, activity: activity(), ...o });

    it('shown for a verified Steam with stats, even when the owner\'s showcase has no Steam block; opens the Integrations tab', () => {
        steam.card = card();
        const onOpenFull = vi.fn();
        render(h(ProfilePopoutCard, { userId: 'u1', token: 't', isSelf: false, data: data(), avatarId: null, bannerId: null, onOpenFull }));
        const row = host.querySelector('[data-testid="steam-highlight"]') as HTMLButtonElement;
        expect(row).not.toBeNull();
        act(() => row.click());
        expect(onOpenFull).toHaveBeenCalledWith('integrations');
    });

    it('not fetched without a visible Steam link; not shown on your own card while you hide your stats', () => {
        steam.card = card();
        render(h(ProfilePopoutCard, { userId: 'u1', token: 't', isSelf: false, data: data({ steam: null }), avatarId: null, bannerId: null }));
        expect(host.querySelector('[data-testid="steam-highlight"]')).toBeNull();
        expect(steam.asked.every((x) => x === null)).toBe(true);
        steam.card = card({ statsHidden: true });
        render(h(ProfilePopoutCard, { userId: 'me', token: 't', isSelf: true, data: data(), avatarId: null, bannerId: null }));
        expect(host.querySelector('[data-testid="steam-highlight"]')).toBeNull();
    });
});

// Private Steam (2026-11-16): no showcase card for viewers (just the verified Steam row); the owner gets a how-to.
const PRIVATE_WIRE = { private: true, games_private: false, level: 0, xp: { into_level: 0, level_span: 100, to_next: 100 }, badge_count: null, member_since: null, game_count: null, total_minutes: null, top_games: [], now_playing: null, recent: [], achievements: null };
const privateActivity = (o: object = {}): SteamActivity => readSteamActivity({ ...PRIVATE_WIRE, ...o })!;

describe('steamHasShowcaseStats (the show/hide rule)', () => {
    it('private profile: never, even with a level or a member-since month', () => {
        expect(steamHasShowcaseStats(privateActivity())).toBe(false);
        expect(steamHasShowcaseStats(privateActivity({ level: 12, member_since: '2015-01' }))).toBe(false);
    });
    it('public profile, private game details: only a real public stat counts (level > 0, badges > 0, playing now)', () => {
        const gp = { games_private: true, level: 0, badge_count: null, member_since: '2020-05', game_count: null, total_minutes: null, top_games: [], recent: [], now_playing: null, achievements: null };
        expect(steamHasShowcaseStats(activity({ ...gp }))).toBe(false); // member-since alone is not a stat
        expect(steamHasShowcaseStats(activity({ ...gp, level: 7 }))).toBe(true);
        expect(steamHasShowcaseStats(activity({ ...gp, badge_count: 3 }))).toBe(true);
        expect(steamHasShowcaseStats(activity({ ...gp, now_playing: WIRE.now_playing }))).toBe(true);
        expect(steamNeedsOwnerNotice(activity({ ...gp }))).toBe(true);
        expect(steamNeedsOwnerNotice(activity({ ...gp, level: 7 }))).toBe(false);
    });
    it('fully public profile: unchanged', () => {
        expect(steamHasShowcaseStats(activity())).toBe(true);
        expect(steamNeedsOwnerNotice(activity())).toBe(false);
    });
});

describe('private Steam on a profile', () => {
    const data = (): ProfileCardData => ({
        name: 'Gabe', discriminator: 1, theme: null, decoration: null, effect: null,
        blocks: ['links'], topAchievements: [], games: [], links: [], interests: [], achievementCount: null, mostPlayed: [],
        steam: { steamId: '76561197960287930', personaName: 'Gaben', avatar: null },
    });
    const card = (a: SteamActivity) => ({ steam_id: '76561197960287930', persona_name: 'Gaben', avatar: null, activity: a });

    it('viewer: no Steam card, no "0" level, no "<1 years", no hint; the verified Steam chip stays', () => {
        steam.card = card(privateActivity());
        render(h(ProfilePopoutCard, { userId: 'u1', token: 't', isSelf: false, data: data(), avatarId: null, bannerId: null }));
        expect(host.querySelector('[data-testid="steam-highlight"]')).toBeNull();
        render(h(ProfileIntegrationsPanels, { userId: 'u1', isSelf: false, token: 't', steamId: '76561197960287930' }));
        expect(host.innerHTML).toBe('');
        expect(text()).not.toContain('private');
        expect(host.querySelector('[data-testid="steam-showcase"]')).toBeNull();
    });
    it('a public profile with private game details but a real level still shows the card', () => {
        steam.card = card(activity({ games_private: true, level: 9, member_since: '2020-05', game_count: null, total_minutes: null, top_games: [], recent: [], now_playing: null, achievements: null }));
        render(h(ProfileIntegrationsPanels, { userId: 'u1', isSelf: false, token: 't', steamId: '76561197960287930' }));
        expect(host.querySelector('[data-testid="steam-showcase"]')).not.toBeNull();
    });
    it('level 0 draws no level ring', () => {
        render(h(SteamShowcase, { activity: activity({ level: 0, xp: { into_level: 0, level_span: 100, to_next: 100 } }), token: 't' }));
        expect(host.querySelector('.ig-lvl')).toBeNull();
        expect(text()).not.toContain('XP to');
    });
    it('owner (own profile Integrations tab): the notice instead of the card', () => {
        steam.card = card(privateActivity());
        render(h(ProfileIntegrationsPanels, { userId: 'me', isSelf: true, token: 't', steamId: '76561197960287930' }));
        expect(host.querySelector('[data-testid="steam-showcase"]')).toBeNull();
        expect(host.querySelector('[data-testid="steam-private-notice"]')).not.toBeNull();
    });
});

describe('SteamPrivateNotice (owner)', () => {
    it('says what viewers see, names the Steam settings and the cache delay; Check again re-reads', async () => {
        const again = vi.fn(() => Promise.resolve());
        render(h(SteamPrivateNotice, { activity: privateActivity(), onCheckAgain: again }));
        const t = text();
        expect(t).toContain('Your Steam profile is private.');
        expect(t).toContain("won't show on your Cipherline profile");
        expect(t).toContain('verified Steam account');
        expect(t).toContain('Edit Profile > Privacy Settings');
        expect(t).toContain('My profile');
        expect(t).toContain('Game details');
        expect(t).toContain('up to 6 hours');
        await act(async () => { (host.querySelector('[data-testid="steam-check-again"]') as HTMLButtonElement).click(); });
        expect(again).toHaveBeenCalledTimes(1);
    });
    it('game-details-only wording; no button without a handler', () => {
        render(h(SteamPrivateNotice, { activity: activity({ games_private: true }) }));
        expect(text()).toContain('Your Steam game details are private.');
        expect(host.querySelector('[data-testid="steam-check-again"]')).toBeNull();
    });
});
