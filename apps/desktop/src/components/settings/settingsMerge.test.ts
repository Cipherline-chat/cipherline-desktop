// @vitest-environment jsdom
/**
 * Settings > Activity & Style (Connections + Personalize, merged 2026-10-28)
 * and Steam moved under Profile:
 *  - the nav, the pane list and the search index agree on the new pane id;
 *  - every old pane id still lands somewhere sensible (aliases), including a
 *    stored / unknown value;
 *  - search finds the moved settings in their NEW home, and Steam ONLY under Profile;
 *  - the merged pane renders both groups with no Steam in it, and the Steam card
 *    renders (connect / verified + stats switch) and is reachable by the
 *    "Connect accounts" deep link even while its Profile tab is hidden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const api = {
        isAccountReady: () => true,
        whenAccountReady: () => Promise.resolve(),
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});
const auth = vi.hoisted(() => ({ user: { user_id: 'u-me', username: 'me', steam: null as null | { steam_id: string } }, token: 'tok', userId: 'u-me', refreshProfile: async () => {} }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ push: vi.fn() }) }));
const get = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => get(...a), put: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn(), isAxiosError: () => false } }));

// The render tests import the real panes (and their whole module graphs) on first use: slow on a loaded box.
vi.setConfig({ testTimeout: 120_000 });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const { PANE_IDS, PANE_ALIASES, resolveSettingsTarget, isPaneId } = await import('./paneAliases');
const { SETTINGS_INDEX, searchSettingsIndex } = await import('./settingsSearchIndex');
const { findSettingTarget } = await import('./revealSetting');

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const navIds = () => [...read('DepthGauge.tsx').matchAll(/\{ id: '([a-zA-Z]+)',\s+label:/g)].map(m => m[1]);

describe('pane ids: nav, pane list, search index agree', () => {
    it('the gauge lists exactly PANE_IDS, in order, with Activity & Style second in the Surface zone', () => {
        expect(navIds()).toEqual([...PANE_IDS]);
        const nav = read('DepthGauge.tsx');
        const surface = nav.slice(nav.indexOf("name: 'Surface'"), nav.indexOf("name: 'Twilight'"));
        expect([...surface.matchAll(/\{ id: '[a-zA-Z]+',\s+label: '([^']+)'/g)].map(m => m[1])).toEqual(['Profile', 'Activity & Style', 'Appearance']);
    });
    it('Connections and Personalize are gone from the nav, the pane switch and the index', () => {
        expect(navIds()).not.toContain('connections');
        expect(navIds()).not.toContain('personalize');
        const screen = read('SettingsScreen.tsx');
        expect(screen).not.toMatch(/pane === '(connections|personalize)'/);
        expect(screen).toContain("pane === 'activityStyle' && <ActivityStylePane />");
        expect(screen).toContain('resolveSettingsTarget(initialTab)');
        expect(Object.keys(SETTINGS_INDEX).sort()).toEqual([...PANE_IDS].sort());
    });
});

describe('old pane ids are aliases', () => {
    it('connections -> Activity & Style', () => {
        expect(resolveSettingsTarget('connections')).toEqual({ pane: 'activityStyle' });
    });
    it('personalize -> Activity & Style, revealing My Emojis', () => {
        expect(resolveSettingsTarget('personalize')).toEqual({ pane: 'activityStyle', setting: 'My Emojis' });
    });
    it('steam -> Profile, revealing the Steam card', () => {
        expect(resolveSettingsTarget('steam')).toEqual({ pane: 'profile', setting: 'Steam account' });
    });
    it('a current id passes through untouched; Game Activity is NOT swallowed by the new section', () => {
        for (const id of PANE_IDS) expect(resolveSettingsTarget(id)).toEqual({ pane: id });
        expect(resolveSettingsTarget('activity')).toEqual({ pane: 'activity' });
    });
    it('missing, unknown or prototype-ish values open Profile', () => {
        for (const v of [undefined, null, '', 'nope', 'toString', '__proto__', 'Connections']) {
            expect(resolveSettingsTarget(v)).toEqual({ pane: 'profile' });
        }
    });
    it('every alias lands on a real pane, and no alias shadows a real pane id', () => {
        for (const [alias, t] of Object.entries(PANE_ALIASES)) {
            expect(isPaneId(t.pane), alias).toBe(true);
            expect(isPaneId(alias), alias).toBe(false);
        }
    });
    it('every alias setting is a search-index label of its target pane (so the reveal has something to find)', () => {
        for (const t of Object.values(PANE_ALIASES)) {
            if (t.setting) expect(SETTINGS_INDEX[t.pane].map(e => e.label)).toContain(t.setting);
        }
    });
    it('call sites: the emoji picker asks for personalize, "Connect accounts" for steam', () => {
        expect(read('../EmojiPickerEmptyState.tsx')).toContain("requestOpenSettings('personalize')");
        expect(read('../profile/ProfileIntegrationsSection.tsx')).toContain("CONNECT_ACCOUNTS_PANE = 'steam'");
    });
});

describe('search finds moved settings in their new home', () => {
    it('Steam is found ONLY under Profile', () => {
        for (const q of ['steam', 'connect steam', 'steam level', 'recently played']) {
            const hits = searchSettingsIndex(q);
            expect(Object.keys(hits), q).toEqual(['profile']);
        }
        expect(searchSettingsIndex('steam').profile).toEqual(expect.arrayContaining(['Steam account', 'Show Steam stats on my profile']));
    });
    it('listening, watching, Spotify, most played, emojis, ring and entrance sound are under Activity & Style', () => {
        const expectIn = (q: string, label: string) => expect(searchSettingsIndex(q).activityStyle, q).toContain(label);
        expectIn('listening', 'Share what I’m listening to');
        expectIn('netflix', 'Also share what I’m watching');
        expectIn('include my browser', 'Include my browser');
        expectIn('playlists', 'Spotify showcase');
        expectIn('most played', 'Show my most played games to friends');
        expectIn('custom emoji', 'My Emojis');
        expectIn('ring color', 'Speaking ring');
        expectIn('join sound', 'Entrance sound');
    });
    it('the old section names still find the new section', () => {
        expect(Object.keys(searchSettingsIndex('personalize'))).toContain('activityStyle');
        expect(Object.keys(searchSettingsIndex('connections'))).toContain('activityStyle');
    });
});

// ── Render ──────────────────────────────────────────────────────────────────

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    get.mockReset();
    get.mockImplementation((url: string) => {
        if (url.endsWith('/integrations/me')) return Promise.resolve({ data: { available: { steam_data: true, spotify_showcase: true }, spotify: [] } });
        if (/\/users\/u-me\/steam$/.test(url)) return Promise.resolve({ data: { steam_id: '76561197960287930', persona_name: 'gabe', avatar: null, stats_hidden: false, activity: null } });
        return Promise.resolve({ data: {} });
    });
});
afterEach(() => { act(() => root.unmount()); host.remove(); auth.user.steam = null; });
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe('ActivityStylePane', () => {
    it('renders the Activity group (listening, Spotify, most played) and the Style group (My Emojis, Calls), and no Steam', async () => {
        const { ActivityStylePane } = await import('./panes/ActivityStylePane');
        auth.user.steam = { steam_id: '76561197960287930' };
        const { NotificationProvider } = await import('../../contexts/NotificationContext');
        act(() => root.render(React.createElement(NotificationProvider, null, React.createElement(ActivityStylePane))));
        await flush();
        const groups = [...host.querySelectorAll('section.as-group')];
        expect(groups.map(g => g.querySelector('h2')!.textContent)).toEqual(['Activity', 'Style']);
        const titles = (g: Element) => [...g.querySelectorAll('.sx-disc-head b')].map(b => b.textContent);
        expect(titles(groups[0])).toEqual(['Listening status', 'Spotify showcase', 'Most played']);
        expect(titles(groups[1])).toEqual(['My Emojis', 'Calls']);
        // each group is a labelled region for assistive tech
        expect(groups[0].getAttribute('aria-labelledby')).toBe('as-activity-h');
        expect(host.querySelector('[data-testid^="steam-"]')).toBeNull();
        expect(host.textContent).not.toMatch(/Connect Steam|Show Steam stats/);
        // no control appears twice
        const toggles = [...host.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(l => /^(Share what|Include my browser|Also share|Show my most played)/.test(l!));
        expect(new Set(toggles).size).toBe(toggles.length);
    });
});

describe('ProfileSteamSection (Settings > Profile > Showcase)', () => {
    it('not linked: the Connect Steam flow, no stats switch', async () => {
        const { ProfileSteamSection } = await import('./panes/ProfileSteamSection');
        act(() => root.render(React.createElement(ProfileSteamSection, { token: 'tok', userId: 'u-me', linked: false, onChanged: vi.fn() })));
        await flush();
        expect(host.querySelector('[data-testid="steam-connect"]')).not.toBeNull();
        expect(host.querySelector('h4')!.textContent).toBe('Steam account');
        expect(host.textContent).not.toMatch(/Show Steam stats on my profile/);
    });
    it('linked, stats available: verified account + the stats switch', async () => {
        const { ProfileSteamSection } = await import('./panes/ProfileSteamSection');
        act(() => root.render(React.createElement(ProfileSteamSection, { token: 'tok', userId: 'u-me', linked: true, onChanged: vi.fn() })));
        await flush();
        expect(host.querySelector('[data-testid="steam-linked"]')!.textContent).toMatch(/gabe.*Verified by Steam/);
        expect(host.querySelector('[aria-label="Show Steam stats on my profile"]')).not.toBeNull();
    });
    it('the "steam" deep link finds the card inside a hidden Profile tab and asks that tab to open', async () => {
        const { ProfileSteamSection } = await import('./panes/ProfileSteamSection');
        act(() => root.render(
            React.createElement('div', { role: 'tabpanel', hidden: true, 'data-reveal-closed': 'true', 'data-testid': 'tab' },
                React.createElement(ProfileSteamSection, { token: 'tok', userId: 'u-me', linked: false, onChanged: vi.fn() })),
        ));
        await flush();
        const found = findSettingTarget(host, PANE_ALIASES.steam.setting!)!;
        expect(found.target.tagName).toBe('H4');
        expect(found.closed.map(e => e.getAttribute('data-testid'))).toContain('tab');
    });
    it('Profile renders it in the Showcase tab; the Showcase Steam row points at it instead of a second Connect button', () => {
        const pane = read('panes/ProfilePane.tsx');
        const showcase = pane.slice(pane.indexOf('<PaneTabPanel id="showcase"'), pane.indexOf('<PaneTabPanel id="privacy"'));
        expect(showcase).toContain('<ProfileSteamSection');
        const extras = read('panes/ProfileExtrasSection.tsx');
        expect(extras).not.toMatch(/<SteamConnect/);
        expect(extras).toContain("revealSetting(root, 'Steam account')");
        expect(read('../integrations/ConnectionsPane.tsx')).not.toMatch(/SteamConnect|SteamStatsSection|steam\/stats/);
    });
});
