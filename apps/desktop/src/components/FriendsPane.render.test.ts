// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
    // jsdom has no matchMedia; the kit's button physics reads it at import.
    if (typeof window !== 'undefined' && !window.matchMedia) {
        Object.defineProperty(window, 'matchMedia', {
            value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
        });
    }
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ token: 'tok', deviceId: 'dev' }) }));

import FriendsPane from './FriendsPane';

/**
 * The Friends layout, rendered (the wiring test pins the rest at source level).
 * Pins what the redesign is FOR: people grouped by presence with honest
 * counts, the status line saying something useful, row actions that are real
 * named buttons, and a pending request's expiry shown only in its last week.
 */
const h = React.createElement as (...a: unknown[]) => React.ReactElement;
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const friend = (id: string, username: string) => ({
    friend_table_id: `ft-${id}`, user_id: id, username, discriminator: 12, avatar_url: null, avatar_decoration: null, badges: [],
});
const payload = {
    accepted: [friend('u-b', 'bea'), friend('u-a', 'ash'), friend('u-c', 'cyd'), friend('u-d', 'dov')],
    pending_incoming: [{ friend_table_id: 'p1', requester_id: 'u-r', username: 'ren', discriminator: 3, avatar_url: null, requested_at: ago(27) }],
    pending_outgoing: [{ friend_table_id: 'p2', recipient_id: 'u-s', username: 'sam', discriminator: 4, avatar_url: null, requested_at: ago(2) }],
    blocked: [],
};
const statuses = {
    'u-a': { status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: 'Hades' },
    'u-b': { status: 'away', custom_status_text: null, custom_status_emoji: null, current_game: null },
    'u-c': { status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: null, on_mobile: true },
    // u-d has no entry at all: it must land in Offline, like its grey dot says.
};
const noop = () => {};
const render = (over: Record<string, unknown> = {}) => renderToStaticMarkup(h(FriendsPane, {
    onStartChat: noop, friends: payload, friendsStatus: 'ready', onRefresh: () => Promise.resolve(),
    onStartCall: noop, friendStatuses: statuses, ...over,
}));

describe('FriendsPane — All friends layout', () => {
    const out = render();

    it('groups by presence with counts, and sorts names within a group', () => {
        expect(out).toMatch(/<h2[^>]*>Online<\/h2><span class="fp-n"[^>]*>3<\/span>/);
        expect(out).toMatch(/<h2[^>]*>Offline<\/h2><span class="fp-n"[^>]*>1<\/span>/);
        const order = ['ash', 'bea', 'cyd', 'dov'].map(n => out.indexOf(`class="fp-name">${n}<`));
        expect(order.every(i => i > -1)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        // the offline friend is in the offline group, styled as such
        expect(out.slice(out.indexOf('>Offline<'))).toContain('class="fp-name">dov<');
        expect(out).toMatch(/fp-row fp-row--offline[^"]*"[^>]*data-friend-row="u-d"|data-friend-row="u-d"[^>]*class="fp-row fp-row--offline/);
    });

    it('the header says how many are online', () => {
        expect(out).toMatch(/<b>3<\/b> online of 4 friends/);
    });

    it('the status line falls back to something useful: game, presence label, "On mobile"', () => {
        expect(out).toContain('Playing Hades');
        expect(out).toContain('>Idle<');
        expect(out).toContain('>On mobile<');
    });

    it('rows are focusable list items, and their actions are named buttons', () => {
        expect(out).toMatch(/role="listitem" tabindex="0"[^>]*data-friend-row="u-a"/);
        expect(out).toContain('aria-label="Message"');
        expect(out).toContain('aria-label="Call"');
        expect(out).toContain('aria-label="More"');
    });

    it('incoming requests surface on the All tab with a way to review them', () => {
        expect(out).toContain('1 friend request');
        expect(out).toContain('ren wants to be friends');
    });

    it('no Call button when the host gives no call action', () => {
        expect(render({ onStartCall: undefined })).not.toContain('aria-label="Call"');
    });
});

describe('FriendsPane — never-loaded states', () => {
    it('loading shows a skeleton and announces it, never the "no friends" empty state', () => {
        const out = render({ friends: null, friendsStatus: 'loading' });
        expect(out).toContain('fp-skel');
        expect(out).toContain('Loading your friends');
        expect(out).not.toContain('Your circle is quiet');
    });
    it('a failed first load offers a retry', () => {
        const out = render({ friends: null, friendsStatus: 'error' });
        expect(out).toContain('Couldn&#x27;t load your friends');
        expect(out).toContain('Try again');
    });
});

describe('FriendsPane — the halo looks the way the friend set it up', () => {
    // useId differs per render tree: compare with the per-instance ids stripped.
    const norm = (s: string) => s.replace(/pcd[A-Za-z0-9_-]*/g, 'U').replace(/:r[0-9a-z]+:/g, 'R');
    const row = (over: Record<string, unknown>) => {
        const html = render({ friends: { ...payload, accepted: [{ ...friend('u-a', 'ash'), avatar_decoration: 'lume-ring', ...over }] } });
        const at = html.indexOf('data-friend-row="u-a"');
        return norm(html.slice(at, html.indexOf('fp-text', at)));
    };
    const THEME = { primary: '#112233', accent: '#ff5599' };

    it('draws the decoration at all (positive control)', () => {
        expect(row({})).toContain('data-decoration="lume-ring"');
    });
    it('a different halo colour is a different picture', () => {
        const stock = row({});
        const violet = row({ cosmetic_options: { d: { h: 280 } } });
        const green = row({ cosmetic_options: { d: { h: 120 } } });
        expect(violet).not.toBe(stock);
        expect(green).not.toBe(stock);
        expect(green).not.toBe(violet);
        // Same row twice compares equal, so the differences above are the colour, not the id noise.
        expect(row({ cosmetic_options: { d: { h: 280 } } })).toBe(violet);
    });
    it('"Match theme": the friend\'s theme tints a halo that has no colour of its own', () => {
        expect(row({ profile_theme: THEME })).not.toBe(row({}));
    });
    it('a hue beats the theme, as on the card', () => {
        expect(row({ profile_theme: THEME, cosmetic_options: { d: { h: 280 } } })).toBe(row({ cosmetic_options: { d: { h: 280 } } }));
    });
});
