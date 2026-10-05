import { describe, it, expect } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeStatusDot } from './HomeStatusDot';
import { resolvePresenceWithMobile as homePresenceFor } from '../utils/activeNow';
import type { UserStatus } from '../utils/userStatusModel';

// .ts (not .tsx): vitest here only collects *.test.ts, so no JSX.
const h = React.createElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const GLYPH = 'data-testid="status-mobile-glyph"';

/**
 * The Home deck's avatar dots showed no phone icon (and the conversation rows
 * were green whatever the status). They now all go through HomeStatusDot,
 * whose on-mobile form is the shared StatusDot glyph.
 */
describe('HomeStatusDot', () => {
    it('renders the shared phone glyph for someone present only on their phone', () => {
        const out = html(h(HomeStatusDot, { status: 'online', onMobile: true }));
        expect(out).toContain(GLYPH);
        expect(out).toContain('hd-dot--mobile');
    });

    it('keeps the status colour on the phone (DND = red phone)', () => {
        expect(html(h(HomeStatusDot, { status: 'dnd', onMobile: true }))).toContain('#FF6B5E');
    });

    it('positive control: without the bit it is the ordinary deck dot, in the status colour', () => {
        const out = html(h(HomeStatusDot, { status: 'dnd' }));
        expect(out).not.toContain(GLYPH);
        expect(out).toContain('var(--cl-flash)');
    });

    it('never a phone for offline', () => {
        expect(html(h(HomeStatusDot, { status: 'offline', onMobile: true }))).not.toContain(GLYPH);
    });
});

describe('resolvePresenceWithMobile — a DM partner on the deck', () => {
    const fs = (status: UserStatus, on_mobile?: boolean) => ({
        u: { status, custom_status_text: null, custom_status_emoji: null, current_game: null, on_mobile },
    });

    it('uses the live status (DND stays DND — the rows used to be green regardless)', () => {
        expect(homePresenceFor('u', fs('dnd'), { u: true })).toEqual({ status: 'dnd', onMobile: false });
    });

    it('carries on_mobile', () => {
        expect(homePresenceFor('u', fs('online', true), {})).toEqual({ status: 'online', onMobile: true });
    });

    it('falls back to the presence poll, and never reports on-mobile for someone offline', () => {
        expect(homePresenceFor('u', undefined, { u: true })).toEqual({ status: 'online', onMobile: false });
        expect(homePresenceFor('u', fs('offline', true), {})).toEqual({ status: 'offline', onMobile: false });
    });
});

describe('HomePanel wiring', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'HomePanel.tsx'), 'utf8');

    it('draws no dot of its own any more — every avatar dot is a HomeStatusDot', () => {
        expect(src).not.toMatch(/className="hd-dot"/);
        expect((src.match(/<HomeStatusDot\b/g) ?? []).length).toBe(3); // conversations, friends, pick-back-up cards
    });

    it('passes the on-mobile bit at every call site', () => {
        const sites = src.match(/<HomeStatusDot[^>]*\/>/g) ?? [];
        expect(sites.length).toBe(3);
        for (const s of sites) expect(s).toMatch(/onMobile=\{/);
    });
});
