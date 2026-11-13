// @vitest-environment jsdom
/**
 * "Watching <title>" with the TV, wherever a friend's listening status shows:
 * the line under a name (StatusLine: friends list, member list, DM list,
 * Home, profile presence) and the profile's activity row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusLine } from './StatusLine';
import { ProfileActivityRow } from './profile/ProfileActivityRow';
import { listeningStore, type Listening } from '../utils/integrations/listening';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const U = '11111111-1111-4111-8111-111111111111';
const entry = { status: 'online', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false } as never;
const rec = (o: Partial<Listening> = {}): Listening => ({
    kind: 'watching', source: 'youtube', track: 'A video', artist: 'A channel', album: null, startedAt: Date.now(), durationMs: null, endsAt: Date.now() + 60_000, ...o,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); listeningStore.clear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); listeningStore.clear(); });

describe('StatusLine', () => {
    it('a friend watching in a browser: "Watching <title>", the TV icon, the channel in the tooltip', () => {
        listeningStore.set(U, rec({ source: 'browser' }));
        act(() => root.render(h(StatusLine, { entry, userId: U })));
        const el = host.querySelector('[data-testid="status-line-listening"]')!;
        expect(el.textContent).toBe('Watching A video');
        expect(el.getAttribute('title')).toBe('Watching A video — A channel');
        expect(el.querySelector('svg[data-icon="watching"]')).not.toBeNull();
    });

    it('a friend listening: unchanged ("Listening to", the note)', () => {
        listeningStore.set(U, rec({ kind: 'listening', source: 'spotify', track: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' }));
        act(() => root.render(h(StatusLine, { entry, userId: U })));
        const el = host.querySelector('[data-testid="status-line-listening"]')!;
        expect(el.textContent).toBe('Listening to Teardrop');
        expect(el.querySelector('svg[data-icon="watching"]')).toBeNull();
    });
});

describe('ProfileActivityRow', () => {
    // Owner, 2026-10-27: platform logos replace the generic glyphs; the TV stays for an unknown app / browser.
    it('watching: "Watching", the platform\'s logo (YouTube), the channel as detail', () => {
        const out = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'full', activities: [{ kind: 'watching', title: 'A video', detail: 'A channel · YouTube', source: 'youtube' }] }));
        expect(out).toContain('Watching');
        expect(out).toContain('A channel · YouTube');
        expect(out).toContain('data-logo="YouTube"');
        expect(out).not.toContain('Listening to');
    });

    it('watching in an unknown browser tab / VLC: the TV', () => {
        for (const source of ['browser', 'other']) {
            const out = renderToStaticMarkup(h(ProfileActivityRow, { variant: 'full', activities: [{ kind: 'watching', title: 'A video', detail: 'A channel', source }] }));
            expect(out).toContain('data-icon="watching"');
            expect(out).not.toContain('data-logo');
        }
    });
});
