// @vitest-environment jsdom
/**
 * "Listening to / Watching": platform logos (with the note / TV as the
 * fallback), the row that opens the song / video, and the structure that lets
 * a long title ellipsize (with the full text on hover) on every surface.
 * Layout itself is proven by screenshots (harness/activity-links-*); these pin
 * the markup that layout depends on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusLine } from './StatusLine';
import { ProfileActivityRow } from './profile/ProfileActivityRow';
import { ActivitySourceIcon } from './integrations/PlatformLogo';
import { platformLogo, PLATFORM_LOGOS } from './integrations/platformLogoData';
import { LISTEN_SOURCES, listeningStore, WATCH_SOURCES, type Listening } from '../utils/integrations/listening';
import { activityLink } from '../utils/integrations/activityLinks';

const openExternalLink = vi.hoisted(() => vi.fn(() => ({ ok: true })));
vi.mock('../utils/openExternalLink', () => ({ openExternalLink }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const U = '11111111-1111-4111-8111-111111111111';
const entry = { status: 'online', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false } as never;
const LONG = 'The Wolf of Wall Street (2013) - Official Trailer - Leonardo DiCaprio, Jonah Hill, Margot Robbie - Paramount Pictures HD 4K Remastered';
const rec = (o: Partial<Listening> = {}): Listening => ({
    kind: 'watching', source: 'youtube', track: LONG, artist: 'Paramount Pictures', album: null, startedAt: Date.now(), durationMs: null, endsAt: Date.now() + 60_000, ...o,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); listeningStore.clear(); openExternalLink.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); listeningStore.clear(); });

describe('platform logos', () => {
    const LOGO: Record<string, string | null> = {
        spotify: 'Spotify', apple_music: 'Apple Music', youtube_music: 'YouTube Music', tidal: 'TIDAL', deezer: 'Deezer', soundcloud: 'SoundCloud',
        amazon_music: null, browser: null, other: null,
        youtube: 'YouTube', netflix: 'Netflix', twitch: 'Twitch', crunchyroll: 'Crunchyroll', jellyfin: 'Jellyfin', plex: 'Plex',
        prime_video: null, disney_plus: null, hulu: null,
    };

    it('every source has a decided logo or the fallback (Amazon / Disney+ / Hulu / Prime Video: Simple Icons removed them)', () => {
        for (const s of [...LISTEN_SOURCES, ...WATCH_SOURCES]) {
            expect(s in LOGO, `source ${s} needs a decision`).toBe(true);
            expect(platformLogo(s)?.name ?? null).toBe(LOGO[s]);
        }
        expect(platformLogo('__proto__')).toBeNull();
        expect(platformLogo('constructor')).toBeNull();
        expect(platformLogo(null)).toBeNull();
    });

    it('a logo is a decorative single-path 24x24 mark with a fixed colour; the fallback is the note / TV', () => {
        for (const [, l] of Object.entries(PLATFORM_LOGOS)) {
            expect(l.d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/); // path data only, nothing that could be markup
            expect(l.color).toMatch(/^(#[0-9A-F]{6}|var\(--cl-text, #F4F7FF\))$/);
        }
        const yt = renderToStaticMarkup(h(ActivitySourceIcon, { kind: 'watching', source: 'youtube', size: 14 }));
        expect(yt).toContain('data-logo="YouTube"');
        expect(yt).toContain('aria-hidden="true"');
        expect(yt).toContain('width="14"');
        expect(renderToStaticMarkup(h(ActivitySourceIcon, { kind: 'watching', source: 'browser' }))).toContain('data-icon="watching"');
        expect(renderToStaticMarkup(h(ActivitySourceIcon, { kind: 'watching', source: 'hulu' }))).toContain('data-icon="watching"');
        expect(renderToStaticMarkup(h(ActivitySourceIcon, { kind: 'listening', source: 'amazon_music' }))).not.toContain('data-logo');
        expect(renderToStaticMarkup(h(ActivitySourceIcon, { kind: 'listening', source: 'spotify' }))).toContain('data-logo="Spotify"');
    });

    it('the status line shows the friend\'s platform logo', () => {
        listeningStore.set(U, rec({ kind: 'listening', source: 'deezer', track: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' }));
        act(() => root.render(h(StatusLine, { entry, userId: U })));
        expect(host.querySelector('[data-testid="status-line-listening"] svg[data-logo="Deezer"]')).not.toBeNull();
    });
});

describe('the activity row opens the song / video', () => {
    const act1 = (o: Record<string, unknown> = {}) => ({ kind: 'listening' as const, title: 'Midnight City', detail: 'by M83 on Spotify', source: 'spotify', ...o });

    it('a link row is a button named for where it goes, with an external-link mark; pressing it opens through the validated opener', () => {
        const link = activityLink({ kind: 'listening', source: 'spotify', track: 'Midnight City', artist: 'M83', mediaId: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT' })!;
        act(() => root.render(h(ProfileActivityRow, { variant: 'compact', activities: [act1({ url: link.url, linkLabel: link.label })] })));
        const btn = host.querySelector('button.pfa-row') as HTMLButtonElement;
        expect(btn).not.toBeNull();
        expect(btn.getAttribute('aria-label')).toBe('Open Midnight City on Spotify. Listening to Midnight City · by M83 on Spotify');
        expect(btn.getAttribute('title')).toBe('Open Midnight City on Spotify\nListening to Midnight City · by M83 on Spotify');
        expect(btn.querySelector('[data-testid="profile-activity-ext"]')).not.toBeNull();
        act(() => btn.click());
        expect(openExternalLink).toHaveBeenCalledWith('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    });

    it('keyboard: it is a real <button> (Enter / Space activate it, focus ring from :focus-visible)', () => {
        act(() => root.render(h(ProfileActivityRow, { variant: 'full', activities: [act1({ url: 'https://open.spotify.com/search/x', linkLabel: 'Search Spotify for Midnight City' })] })));
        const btn = host.querySelector('button.pfa-row') as HTMLButtonElement;
        expect(btn.type).toBe('button');
        expect(btn.tabIndex).toBe(0);
    });

    it('no link (VLC, Plex): a plain row, still with the full text on hover', () => {
        act(() => root.render(h(ProfileActivityRow, { variant: 'compact', activities: [act1({ kind: 'watching', title: LONG, detail: 'VLC', source: 'other' })] })));
        expect(host.querySelector('button')).toBeNull();
        expect(host.querySelector('.pfa-row')!.getAttribute('title')).toBe(`Watching ${LONG} · VLC`);
    });
});

describe('long titles ellipsize (structure)', () => {
    it('StatusLine: a block-level flex row (never inline-flex, which sized to the text and clipped without an ellipsis) whose text truncates; full text in the tooltip', () => {
        listeningStore.set(U, rec());
        act(() => root.render(h(StatusLine, { entry, userId: U, className: 'block truncate' })));
        const el = host.querySelector('[data-testid="status-line-listening"]') as HTMLElement;
        const cls = el.className.split(/\s+/);
        expect(cls).toContain('flex');
        expect(cls).not.toContain('inline-flex');
        expect(cls).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
        const text = el.querySelector('span.truncate')!;
        expect(text.className).toContain('min-w-0');
        expect(text.textContent).toBe(`Watching ${LONG}`);
        expect(el.getAttribute('title')).toBe(`Watching ${LONG} — Paramount Pictures · YouTube`);
    });

    it('activity row: the title / line are their own ellipsizing boxes beside a fixed-size icon', () => {
        const out = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'full', activities: [{ kind: 'watching', title: LONG, detail: 'Paramount Pictures · YouTube', source: 'youtube' }] }));
        expect(out).toContain(`class="pfa-title">${LONG.replace(/&/g, '&amp;')}</b>`);
        const compact = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'compact', activities: [{ kind: 'watching', title: LONG, detail: 'x', source: 'youtube' }] }));
        expect(compact).toContain('class="pfa-line"');
    });
});
