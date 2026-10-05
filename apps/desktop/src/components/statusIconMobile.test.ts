import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusIcon, StatusDot } from './StatusIcon';
import { initialStatusFromSaved } from '../utils/userStatusModel';

// .ts (not .tsx): vitest here only collects *.test.ts, so no JSX.
const h = React.createElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const GLYPH = 'data-testid="status-mobile-glyph"';

describe('the phone glyph in place of the status dot', () => {
    it('renders for a present user who is on mobile, labelled for screen readers', () => {
        const out = html(h(StatusIcon, { status: 'online', onMobile: true, size: 10 }));
        expect(out).toContain(GLYPH);
        expect(out).toContain('aria-label="Online — on mobile"');
    });

    it('keeps the status colour: DND on a phone is a red phone, not a green one', () => {
        expect(html(h(StatusDot, { status: 'dnd', onMobile: true }))).toContain('#FF6B5E');
    });

    it('never for offline, even if the flag were set', () => {
        expect(html(h(StatusIcon, { status: 'offline', onMobile: true }))).not.toContain(GLYPH);
    });

    it('beats the game controller — games are a desktop signal', () => {
        const out = html(h(StatusIcon, { status: 'online', currentGame: 'Chess', onMobile: true }));
        expect(out).toContain(GLYPH);
    });

    it('positive control: without the flag it is the ordinary dot', () => {
        const out = html(h(StatusIcon, { status: 'online' }));
        expect(out).not.toContain(GLYPH);
        expect(out).toContain('border-radius:50%');
    });
});

describe('initialStatusFromSaved — what a restart restores', () => {
    it('keeps Do Not Disturb and Appear Offline (a restart used to make an invisible user visible)', () => {
        expect(initialStatusFromSaved('dnd')).toBe('dnd');
        expect(initialStatusFromSaved('offline')).toBe('offline');
    });

    it('does not restore an automatic away, and defaults to online', () => {
        expect(initialStatusFromSaved('away')).toBe('online');
        expect(initialStatusFromSaved(null)).toBe('online');
        expect(initialStatusFromSaved('garbage')).toBe('online');
    });
});
