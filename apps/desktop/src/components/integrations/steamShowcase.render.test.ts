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
vi.mock('../../hooks/useIntegrations', async (orig) => ({ ...(await orig<object>()), useArt: () => null }));
vi.mock('../../hooks/useProfileRelations', async (orig) => ({
    ...(await orig<object>()),
    useSteamCard: (id: string | null) => { steam.asked.push(id); return id ? steam.card : null; },
}));
vi.mock('../../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: () => null, evictAvatar: () => {}, avatarUrlMime: () => null, peekAvatarUrl: () => null,
}));

import { SteamHighlight, SteamShowcase } from './SteamShowcase';
import { readSteamActivity, steamPrivacyText, type SteamActivity } from '../../utils/integrations/api';
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

    it('private game details: names the exact Steam setting for the owner, says only "private" to others', () => {
        render(h(SteamShowcase, { activity: activity({ games_private: true }), token: 't', isSelf: true }));
        expect(host.querySelector('[data-testid="steam-privacy-hint"]')!.textContent).toContain('Game details: Public');
        expect(text()).not.toContain('Most played');
        render(h(SteamShowcase, { activity: activity({ games_private: true }), token: 't' }));
        expect(host.querySelector('[data-testid="steam-privacy-hint"]')!.textContent).toBe('Their Steam game details are private.');
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

    it('nothing playing: the most played game; private: the hint (owner) / just the level', () => {
        render(h(SteamHighlight, { activity: activity({ now_playing: null }), token: 't' }));
        expect(text()).toContain('Dota 2');
        render(h(SteamHighlight, { activity: activity({ private: true }), token: 't', isSelf: true }));
        expect(text()).toContain('Level 42');
        expect(text()).toContain('Steam profile is private');
        render(h(SteamHighlight, { activity: activity({ games_private: true, now_playing: null }), token: 't' }));
        expect(text()).toContain('Game details are private on Steam');
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
