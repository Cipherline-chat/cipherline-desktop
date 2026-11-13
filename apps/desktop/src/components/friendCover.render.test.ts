// @vitest-environment jsdom
/**
 * Album covers are for PROFILE views only (the profile popover, the DM panel
 * card, the full profile: ProfileActivityRow via useIntegrationActivity).
 * Every list surface that draws someone's "Listening to / Watching" line -
 * the server member list, the friends list, Friends page rows (all through
 * StatusLine) and the Friends activity panel cards - shows the platform's logo
 * (Spotify, YouTube, ...; else the note / the TV) and never even fetches a
 * cover.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const get = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));
vi.mock('./EncryptedAvatar', () => ({
    EncryptedAvatar: ({ userId }: { userId?: string }) => React.createElement('span', { 'data-avatar': userId }),
}));

import { StatusLine } from './StatusLine';
import { FriendsActivityPanel } from './FriendsActivityPanel';
import { ProfileActivityRow } from './profile/ProfileActivityRow';
import { useIntegrationActivity } from '../hooks/useIntegrationActivity';
import { applyListeningEvent, applyWatchingEvent, listeningStore, type Listening } from '../utils/integrations/listening';
import { setListeningArtToken, __resetListeningArt } from '../utils/integrations/listeningArt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const U = '11111111-1111-4111-8111-111111111111';
const RG = 'mb:rg:6f9f6899-c0d3-311d-ae87-a10ae6bc53a9';
const entry = { status: 'online', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false } as never;
const rec = (o: Partial<Listening> = {}): Listening => ({
    kind: 'listening', source: 'spotify', track: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine', startedAt: Date.now(), durationMs: null, endsAt: Date.now() + 60_000, artRef: RG, ...o,
});
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: JPEG.buffer });
    __resetListeningArt();
    setListeningArtToken('tok');
    if (!URL.createObjectURL) (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:http://localhost/cover-1';
    if (!URL.revokeObjectURL) (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); listeningStore.clear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); listeningStore.clear(); __resetListeningArt(); });

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const coverRequests = () => get.mock.calls.filter((c) => /\/listening\/art$/.test(String(c[0])));

describe('list surfaces: the platform logo, never a cover, and no cover request', () => {
    it('StatusLine (member list, sidebar friends, Friends page rows): Spotify logo for music', async () => {
        listeningStore.set(U, rec());
        act(() => root.render(h(StatusLine, { entry, userId: U })));
        await settle();
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('[data-testid="status-line-cover"]')).toBeNull();
        expect(host.querySelector('svg[data-logo="Spotify"]')).not.toBeNull();
        expect(host.textContent).toBe('Listening to Teardrop');
        expect(coverRequests()).toHaveLength(0);
    });

    it('StatusLine: YouTube logo for a video; the music note / TV when the source has no logo', async () => {
        listeningStore.set(U, rec({ kind: 'watching', source: 'youtube', artRef: null, track: 'A video', album: null }));
        act(() => root.render(h(StatusLine, { entry, userId: U })));
        await settle();
        expect(host.querySelector('svg[data-logo="YouTube"]')).not.toBeNull();
        listeningStore.set(U, rec({ source: 'other', track: 'Local file' }));
        await settle();
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('svg')).not.toBeNull();
        expect(coverRequests()).toHaveLength(0);
    });

    it('Friends activity panel cards: the logo, no cover, no request', async () => {
        listeningStore.set(U, rec());
        act(() => root.render(h(FriendsActivityPanel, {
            token: 't', friends: [{ user_id: U, username: 'Zara' }], blockedIds: new Set<string>(), loading: false,
            friendStatuses: { [U]: { status: 'online', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false } as never },
            presence: {}, entries: [], voiceParticipants: {}, huddleCalls: {}, channels: [], servers: [], localCallSession: null,
            onOpenProfile: vi.fn(), now: Date.now(),
        })));
        await settle();
        const card = host.querySelector('.fa-card[data-kind="listening"]');
        expect(card).not.toBeNull();
        expect(card!.querySelector('img')).toBeNull();
        expect(card!.querySelector('.fa-art--cover')).toBeNull();
        expect(card!.querySelector('svg[data-logo="Spotify"]')).not.toBeNull();
        expect(coverRequests()).toHaveLength(0);
    });
});

describe('friends\' lines update live with the app in the background (nothing waits for focus)', () => {
    it('a friend:watching / friend:listening event re-renders a status line while the window is unfocused and hidden', async () => {
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
        const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        try {
            act(() => root.render(h(StatusLine, { entry, userId: U })));
            await settle();
            expect(host.textContent).toBe('');
            const now = Date.now();
            act(() => applyWatchingEvent({ user_id: U, now, watching: { kind: 'watching', source: 'youtube', track: 'A video', artist: 'A channel', album: null, started_at: now, duration_ms: null, ends_at: now + 60_000 } }, null));
            expect(host.textContent).toBe('Watching A video');
            act(() => applyWatchingEvent({ user_id: U, now, watching: null }, null));
            act(() => applyListeningEvent({ user_id: U, now, listening: { source: 'spotify', track: 'Teardrop', artist: 'Massive Attack', album: null, started_at: now, duration_ms: null, ends_at: now + 60_000 } }, null));
            expect(host.textContent).toBe('Listening to Teardrop');
        } finally {
            focus.mockRestore();
            vis.mockRestore();
        }
    });
});

describe('profile views: the cover, fetched only once one is open', () => {
    const Profile: React.FC<{ userId: string }> = ({ userId }) => {
        const activities = useIntegrationActivity({ userId, token: 'tok', steamId: null, liveGame: null, offline: false });
        return h(ProfileActivityRow, { activities, variant: 'full' });
    };

    it('a friend\'s profile shows the server-picked cover, fetched through our API', async () => {
        listeningStore.set(U, rec());
        act(() => root.render(h(Profile, { userId: U })));
        await settle();
        expect(coverRequests()).toHaveLength(1);
        expect(String(coverRequests()[0][0])).toMatch(new RegExp(`/friends/${U}/listening/art$`));
        const img = host.querySelector('.pfa-art img') as HTMLImageElement | null;
        expect(img?.getAttribute('src')).toMatch(/^blob:/);
    });

    it('your own profile shows the cover your device read (nothing fetched)', async () => {
        listeningStore.set(U, rec({ artRef: null, art: 'data:image/jpeg;base64,/9j/4AAQ' }));
        act(() => root.render(h(Profile, { userId: U })));
        await settle();
        expect((host.querySelector('.pfa-art img') as HTMLImageElement | null)?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/4AAQ');
        expect(coverRequests()).toHaveLength(0);
    });
});
