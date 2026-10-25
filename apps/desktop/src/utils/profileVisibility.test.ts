// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    resolveVisibility, detectPreset, presetPatch, fieldPatch, applyVisibilityPatch, visibleFor,
    formatLocalTime, isValidTimeZone, isFriendsOnly, PRESET_FIELDS, VISIBILITY_FIELDS,
} from './profileVisibility';
import { ProfileCardFacts, ProfileCardAbout } from '../components/ProfileCardParts';

const h = React.createElement;

describe('preset <-> fields', () => {
    it.each([
        [{}, 'public'],
        [undefined, 'public'],
        [{ preset: 'public' }, 'public'],
        [{ preset: 'friends_more' }, 'friends_more'],
        [{ preset: 'private' }, 'private'],
        // overrides that happen to equal another preset are NOT custom
        [{ preset: 'private', fields: { bio: 'everyone', banner: 'everyone' } }, 'friends_more'],
        [{ fields: { local_time: 'friends', widgets: 'friends', links: 'friends' } }, 'friends_more'],
        [{ fields: { local_time: 'friends', widgets: 'friends' } }, 'custom'],
        // genuinely matches none
        [{ fields: { bio: 'friends' } }, 'custom'],
        [{ preset: 'friends_more', fields: { bio: 'friends' } }, 'custom'],
        [{ preset: 'private', fields: { local_time: 'everyone' } }, 'custom'],
    ])('%j -> %s', (stored, expected) => {
        expect(detectPreset(stored)).toBe(expected);
    });

    it('preset table matches the owner decision', () => {
        expect(PRESET_FIELDS.friends_more).toEqual({ bio: 'everyone', banner: 'everyone', local_time: 'friends', widgets: 'friends', links: 'friends' });
        expect(VISIBILITY_FIELDS).toEqual(['bio', 'banner', 'local_time', 'widgets', 'links']);
        expect(Object.values(PRESET_FIELDS.private).every((a) => a === 'friends')).toBe(true);
        expect(Object.values(PRESET_FIELDS.public).every((a) => a === 'everyone')).toBe(true);
    });

    it('garbage never widens: unknown audience reads as friends', () => {
        expect(resolveVisibility({ fields: { bio: 'anyone' } }).bio).toBe('friends');
    });
});

describe('applyVisibilityPatch (mirrors the server canonicalisation)', () => {
    it('preset replaces everything', () => {
        expect(applyVisibilityPatch({ fields: { bio: 'friends' } }, presetPatch('private'))).toEqual({ preset: 'private' });
        expect(applyVisibilityPatch({ preset: 'private' }, presetPatch('public'))).toEqual({});
    });
    it('a toggle on Public that matches no preset becomes Custom; toggling back clears it', () => {
        const a = applyVisibilityPatch({}, fieldPatch('bio', 'friends'));
        expect(a).toEqual({ fields: { bio: 'friends' } });
        expect(detectPreset(a)).toBe('custom');
        const b = applyVisibilityPatch(a, fieldPatch('bio', 'everyone'));
        expect(b).toEqual({});
        expect(detectPreset(b)).toBe('public');
    });
    it('toggling the three friends_more fields from Public lands exactly on Friends see more', () => {
        let v = applyVisibilityPatch({}, fieldPatch('local_time', 'friends'));
        expect(detectPreset(v)).toBe('custom');
        v = applyVisibilityPatch(v, fieldPatch('widgets', 'friends'));
        expect(detectPreset(v)).toBe('custom');
        v = applyVisibilityPatch(v, fieldPatch('links', 'friends'));
        expect(detectPreset(v)).toBe('friends_more');
    });
});

describe('visibleFor (View as)', () => {
    it('everyone sees only public fields; a friend sees all', () => {
        const stored = { preset: 'friends_more' as const };
        expect(visibleFor(stored, 'everyone')).toEqual({ bio: true, banner: true, local_time: false, widgets: false, links: false });
        expect(Object.values(visibleFor(stored, 'friend')).every(Boolean)).toBe(true);
        expect(VISIBILITY_FIELDS).toHaveLength(5);
    });
});

describe('links field (same table as widgets)', () => {
    it.each([
        ['public', 'everyone'], ['friends_more', 'friends'], ['private', 'friends'],
    ] as const)('%s preset -> links %s', (preset, aud) => {
        expect(resolveVisibility({ preset }).links).toBe(aud);
    });
    it('a stranger does not see links under Friends see more / Private; a friend does', () => {
        for (const preset of ['friends_more', 'private'] as const) {
            expect(visibleFor({ preset }, 'everyone').links).toBe(false);
            expect(visibleFor({ preset }, 'friend').links).toBe(true);
        }
        expect(visibleFor({}, 'everyone').links).toBe(true);
    });
    it('overrides narrow or widen only links; garbage narrows; pronouns is no longer a field', () => {
        expect(resolveVisibility({ fields: { links: 'friends' } })).toMatchObject({ links: 'friends', widgets: 'everyone' });
        expect(resolveVisibility({ preset: 'private', fields: { links: 'everyone' } })).toMatchObject({ links: 'everyone', widgets: 'friends' });
        expect(resolveVisibility({ fields: { links: 'anyone' } }).links).toBe('friends');
        expect(resolveVisibility({ fields: { pronouns: 'friends' } })).not.toHaveProperty('pronouns');
        expect(applyVisibilityPatch({}, { fields: { pronouns: 'friends' } as never })).toEqual({});
    });
});

describe('widgets field (same gate as bio)', () => {
    it.each([
        ['public', 'everyone'], ['friends_more', 'friends'], ['private', 'friends'],
    ] as const)('%s preset -> widgets %s', (preset, aud) => {
        expect(resolveVisibility({ preset }).widgets).toBe(aud);
    });
    it('a stranger does not see widgets under Friends see more / Private; a friend does', () => {
        for (const preset of ['friends_more', 'private'] as const) {
            expect(visibleFor({ preset }, 'everyone').widgets).toBe(false);
            expect(visibleFor({ preset }, 'friend').widgets).toBe(true);
        }
        expect(visibleFor({}, 'everyone').widgets).toBe(true);
    });
    it('a per-field override narrows or widens only widgets; garbage narrows', () => {
        expect(resolveVisibility({ fields: { widgets: 'friends' } })).toMatchObject({ widgets: 'friends', bio: 'everyone' });
        expect(resolveVisibility({ preset: 'private', fields: { widgets: 'everyone' } })).toMatchObject({ widgets: 'everyone', bio: 'friends' });
        expect(resolveVisibility({ fields: { widgets: 'anyone' } }).widgets).toBe('friends');
    });
});

describe('time zone', () => {
    it('validates IANA zones', () => {
        expect(isValidTimeZone('Europe/Paris')).toBe(true);
        expect(isValidTimeZone('Mars/Olympus')).toBe(false);
        expect(isValidTimeZone('')).toBe(false);
    });
    it('formats local time on-device from the zone', () => {
        const now = new Date('2026-10-23T15:42:00Z');
        const out = formatLocalTime('UTC', now)!;
        expect(out).toMatch(/local time$/);
        expect(out).toMatch(/3:42/);
        expect(formatLocalTime('Asia/Kolkata', now)).toMatch(/9:12/);
        expect(formatLocalTime('nope', now)).toBeNull();
        expect(formatLocalTime(null, now)).toBeNull();
    });
});

describe('lock rendering', () => {
    const html = (el: React.ReactElement) => renderToStaticMarkup(el);
    it('locks local time only when it is listed in friends_only_fields', () => {
        const out = html(h(ProfileCardFacts, { timeZone: 'UTC', friendsOnlyFields: ['local_time'] }));
        expect(out).toContain('title="Friends only"');
        expect(out).toContain('local time');
        expect(out).not.toContain('pronouns');
    });
    it('no lock for a stranger view (empty/absent list) and nothing renders when the zone is hidden or invalid', () => {
        expect(html(h(ProfileCardFacts, { timeZone: 'UTC', friendsOnlyFields: [] }))).not.toContain('Friends only');
        expect(html(h(ProfileCardFacts, { timeZone: null, friendsOnlyFields: ['local_time'] }))).toBe('');
        expect(html(h(ProfileCardFacts, { timeZone: 'Bad/Zone' }))).toBe('');
    });
    it('bio lock follows the flag', () => {
        expect(html(h(ProfileCardAbout, { bio: 'hi', friendsOnly: true }))).toContain('Friends only');
        expect(html(h(ProfileCardAbout, { bio: 'hi' }))).not.toContain('Friends only');
        expect(isFriendsOnly(['bio'], 'bio')).toBe(true);
        expect(isFriendsOnly(undefined, 'bio')).toBe(false);
    });
});
