// @vitest-environment jsdom
/**
 * The profile's "Playing <game>" row, end to end through useIntegrationActivity:
 * your own game paints its executable icon right away and upgrades in place;
 * a friend's game gets its store picture by NAME from the catalogue; the
 * "on <store>" label and the link say only what is true.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

const get = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));

import { ProfileActivityRow } from './profile/ProfileActivityRow';
import { useIntegrationActivity } from '../hooks/useIntegrationActivity';
import { gameArtCache, loadOwnGameArt } from '../utils/gameArt';
import secureLocalStore from '../utils/secureLocalStore';
import { listeningStore } from '../utils/integrations/listening';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const U = '11111111-1111-4111-8111-111111111111';
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const COVER = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////';

const Probe: React.FC<{ game: string | null; isSelf: boolean }> = ({ game, isSelf }) => {
    const acts = useIntegrationActivity({ userId: U, token: 'tok', steamId: null, liveGame: game, isSelf, offline: false });
    return h(ProfileActivityRow, { activities: acts, variant: 'full' });
};

let root: Root;
let host: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const artRequests = () => get.mock.calls.map(c => String((c[1] as { params?: { ref?: string } } | undefined)?.params?.ref ?? '')).filter(Boolean);

beforeAll(async () => { await secureLocalStore.hydrate(); });
beforeEach(() => {
    get.mockReset();
    get.mockImplementation(async (url: string, cfg?: { params?: { ref?: string } }) => {
        if (/integrations\/art$/.test(String(url))) return { data: { data: cfg?.params?.ref?.endsWith(':portrait') ? COVER : COVER } };
        throw Object.assign(new Error('404'), { response: { status: 404 } });
    });
    gameArtCache.clear();
    listeningStore.clear();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); delete (window as unknown as { electronAPI?: unknown }).electronAPI; });

describe('ProfileActivityRow: game art', () => {
    it('an executable icon is contained (data-shape=icon); a store picture fills the box', () => {
        const icon = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'full', activities: [{ kind: 'playing', title: 'Game', source: 'game', art: ICON, artShape: 'icon' }] }));
        expect(icon).toContain('data-shape="icon"');
        expect(icon).toContain(`src="${ICON}"`);
        const cover = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'full', activities: [{ kind: 'playing', title: 'Game', source: 'game', art: COVER, artShape: 'cover' }] }));
        expect(cover).toContain('data-shape="cover"');
    });

    it('a picture that is not an image data URL is dropped for the controller (same gate as every other row)', () => {
        const out = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'full', activities: [{ kind: 'playing', title: 'Game', source: 'game', art: 'javascript:alert(1)', artShape: 'icon' }] }));
        expect(out).not.toContain('<img');
    });

    it('Minecraft with no picture draws the cube, not the controller', () => {
        const out = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'full', activities: [{ kind: 'playing', title: 'Minecraft', source: 'game', glyph: 'block' }] }));
        expect(out).toContain('viewBox="0 0 24 24"');
        expect(out).not.toContain('<img');
    });

    it('no url, no link: a game with nothing to point at is a plain row, not a button', () => {
        const out = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'full', activities: [{ kind: 'playing', title: 'Homebrew', source: 'game' }] }));
        expect(out).not.toContain('<button');
        expect(out).not.toContain('data-testid="profile-activity-ext"');
    });
});

describe('your own game', () => {
    it('shows the executable icon as soon as main answers, then the Steam picture in the same box', async () => {
        (window as unknown as { electronAPI: unknown }).electronAPI = {
            getCurrentGameArt: async () => ({ name: 'BeamNG.drive', icon: ICON, store: 'steam', appId: 284160 }),
        };
        await loadOwnGameArt('BeamNG.drive');
        act(() => root.render(h(Probe, { game: 'BeamNG.drive', isSelf: true })));
        // Frame one: the icon (before the proxy has answered).
        expect(host.querySelector('.pfa-art img')?.getAttribute('src')).toBe(ICON);
        expect(host.querySelector('.pfa-art')?.getAttribute('data-shape')).toBe('icon');
        await settle();
        // Upgraded in place.
        expect(host.querySelector('.pfa-art img')?.getAttribute('src')).toBe(COVER);
        expect(host.querySelector('.pfa-art')?.getAttribute('data-shape')).toBe('cover');
        expect(host.querySelectorAll('.pfa-row')).toHaveLength(1);
        expect(host.textContent).toContain('on Steam');
        expect(host.querySelector('button.pfa-row')?.getAttribute('aria-label')).toContain('Open BeamNG.drive on Steam');
        // Asked our proxy by the app id main found in the Steam library: no wait for Steam's "now playing".
        expect(artRequests()[0]).toBe('steam:284160:portrait');
    });

    it('remembers the final picture: after a restart the first frame is already the store picture', async () => {
        gameArtCache.put('BeamNG.drive', { icon: ICON, cover: COVER, store: 'steam', appId: 284160 });
        get.mockImplementation(() => new Promise(() => { /* the network never answers */ }));
        act(() => root.render(h(Probe, { game: 'BeamNG.drive', isSelf: true })));
        expect(host.querySelector('.pfa-art img')?.getAttribute('src')).toBe(COVER);
    });
});

describe('a friend’s game', () => {
    it('Steam title: picture by name from the catalogue, link to its Steam page, no claim about where they own it', async () => {
        act(() => root.render(h(Probe, { game: 'Elden Ring', isSelf: false })));
        // Frame one: the controller (nothing known yet), same box.
        expect(host.querySelector('.pfa-art img')).toBeNull();
        await settle();
        expect(host.querySelector('.pfa-art img')?.getAttribute('src')).toBe(COVER);
        expect(host.textContent).not.toContain('on Steam');
        expect(host.querySelector('button.pfa-row')?.getAttribute('aria-label')).toContain('Open Elden Ring on Steam');
        expect(artRequests()[0]).toBe('steam:1245620:portrait');
    });

    it('a Valve game says "on Steam"; a Riot game says Riot and links to its site, with no picture request', async () => {
        act(() => root.render(h(Probe, { game: 'Counter-Strike 2', isSelf: false })));
        await settle();
        expect(host.textContent).toContain('on Steam');
        act(() => root.render(h(Probe, { game: 'VALORANT', isSelf: false })));
        await settle();
        expect(host.textContent).toContain('on Riot Games');
        expect(host.querySelector('button.pfa-row')?.getAttribute('aria-label')).toContain('VALORANT’s website');
        expect(artRequests().filter(r => /VALORANT/i.test(r))).toHaveLength(0);
    });

    it('an unknown game: the name alone, no request, no link, never asks main (that is YOUR computer)', async () => {
        const getCurrentGameArt = vi.fn(async () => null);
        (window as unknown as { electronAPI: unknown }).electronAPI = { getCurrentGameArt };
        act(() => root.render(h(Probe, { game: 'Obscure Thing', isSelf: false })));
        await settle();
        expect(host.textContent).toContain('Obscure Thing');
        expect(host.querySelector('button')).toBeNull();
        expect(host.querySelector('img')).toBeNull();
        expect(get).not.toHaveBeenCalled();
        expect(getCurrentGameArt).not.toHaveBeenCalled();
    });

    it('Minecraft: the cube and the publisher site; a friend’s row never carries an executable icon of their own', async () => {
        act(() => root.render(h(Probe, { game: 'Minecraft', isSelf: false })));
        await settle();
        expect(host.querySelector('.pfa-art svg')).not.toBeNull();
        expect(host.querySelector('button.pfa-row')?.getAttribute('aria-label')).toContain('Minecraft’s website');
        expect(get).not.toHaveBeenCalled();
    });
});
