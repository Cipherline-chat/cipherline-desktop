import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// AuthContext imports axios, which reads `location` at import time (absent in
// this node environment). StatusPersonalEmoji only needs the signed-out shape.
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ token: null, userId: null }) }));
import { StatusLine, StatusEmoji } from './StatusLine';
import type { FriendStatusEntry } from '../utils/userStatusModel';

// .ts (not .tsx): vitest here only collects *.test.ts, so no JSX.
const h = React.createElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const entry = (over: Partial<FriendStatusEntry>): FriendStatusEntry => ({
    status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: null, ...over,
});

describe('StatusLine — custom status with a game', () => {
    it('shows the custom status with a controller whose tooltip says Playing <game>', () => {
        const out = html(h(StatusLine, { entry: entry({ custom_status_text: 'grinding', custom_status_emoji: '🔥', current_game: 'Marvel Rivals' }) }));
        expect(out).toContain('grinding');
        expect(out).toContain('🔥');
        expect(out).toContain('data-testid="status-line-game"');
        expect(out).toContain('title="Playing Marvel Rivals"');
    });
    it('truncates with the full text as the tooltip', () => {
        const out = html(h(StatusLine, { entry: entry({ custom_status_text: 'a long one', custom_status_emoji: '🍕' }) }));
        expect(out).toContain('truncate');
        expect(out).toContain('title="🍕 a long one"');
    });
    it('no controller when there is no game', () => {
        expect(html(h(StatusLine, { entry: entry({ custom_status_text: 'brb' }) }))).not.toContain('status-line-game');
    });
    it('game only keeps the old "Playing X" line', () => {
        expect(html(h(StatusLine, { entry: entry({ current_game: 'Chess' }) }))).toContain('Playing Chess');
    });
    it('offline or nothing renders the fallback', () => {
        expect(html(h(StatusLine, { entry: entry({ status: 'offline', custom_status_text: 'x' }), fallback: 'Offline' }))).toBe('Offline');
        expect(html(h(StatusLine, { entry: undefined }))).toBe('');
    });
});

describe('StatusEmoji — the slot a personal custom emoji will plug into', () => {
    it('renders unicode; a cl: reference renders nothing until a renderer is supplied', () => {
        expect(html(h(StatusEmoji, { value: '🔥' }))).toContain('🔥');
        expect(html(h(StatusEmoji, { value: 'cl:abc' }))).toBe('');
        expect(html(h(StatusEmoji, { value: 'cl:abc', renderCustom: ref => h('img', { 'data-ref': ref }) }))).toContain('data-ref="abc"');
    });
});
