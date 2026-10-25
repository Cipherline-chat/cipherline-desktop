import { describe, it, expect } from 'vitest';
import { compareVersions, decideWhatsNew, formatReleaseDate, notesForVersion, WHATS_NEW_SEEN_KEY } from './whatsNew';
import type { ReleaseNotes, WhatsNewData } from './changelogParse';
import { classifyKvKey } from '../services/backupRegistry';

const notes = (version: string): ReleaseNotes => ({ version, date: '2026-10-14', groups: [{ title: null, items: [{ title: null, text: 'A thing.' }] }] });
const data = (...versions: string[]): WhatsNewData => ({ releases: Object.fromEntries(versions.map(v => [v, notes(v)])), unreleased: null });

describe('compareVersions', () => {
    it('orders numerically, not as text', () => {
        expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
        expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
        expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
        expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    });
    it('puts a release above its own pre-releases, and pre-releases in order', () => {
        expect(compareVersions('1.0.23', '1.0.23-staging.9')).toBe(1);
        expect(compareVersions('1.0.23-staging.9', '1.0.23')).toBe(-1);
        expect(compareVersions('1.0.23-staging.10', '1.0.23-staging.9')).toBe(1);
        expect(compareVersions('1.0.23-staging.2', '1.0.22')).toBe(1);
    });
    it('returns null for junk', () => {
        expect(compareVersions('abc', '1.0.0')).toBeNull();
        expect(compareVersions('1.0.0', '')).toBeNull();
    });
});

describe('decideWhatsNew', () => {
    const d = data('1.0.23', '1.0.24-staging.3');

    it('first install (nothing recorded): records silently, shows nothing', () => {
        expect(decideWhatsNew('1.0.23', null, d)).toEqual({ action: 'record' });
        expect(decideWhatsNew('1.0.23', '', d)).toEqual({ action: 'record' });
        expect(decideWhatsNew('1.0.23', 'garbage', d)).toEqual({ action: 'record' });
    });
    it('the first launch after an update with notes: shows them', () => {
        const r = decideWhatsNew('1.0.23', '1.0.22', d);
        expect(r.action).toBe('show');
        expect(r.action === 'show' && r.notes.version).toBe('1.0.23');
    });
    it('never twice for the same version', () => {
        expect(decideWhatsNew('1.0.23', '1.0.23', d)).toEqual({ action: 'none' });
    });
    it('an update with no notes written: records, shows nothing', () => {
        expect(decideWhatsNew('1.0.25', '1.0.23', d)).toEqual({ action: 'record' });
    });
    it('a downgrade shows nothing', () => {
        expect(decideWhatsNew('1.0.23', '1.0.30', d)).toEqual({ action: 'record' });
    });
    it('skipping versions shows the notes for the version you landed on', () => {
        const r = decideWhatsNew('1.0.23', '1.0.19', d);
        expect(r.action).toBe('show');
    });
    it('a staging pre-release shows only when its exact build has notes', () => {
        expect(decideWhatsNew('1.0.24-staging.4', '1.0.24-staging.3', d)).toEqual({ action: 'record' });
        expect(decideWhatsNew('1.0.24-staging.3', '1.0.23', d).action).toBe('show');
        // the notes of the plain release do not leak onto its staging builds
        expect(decideWhatsNew('1.0.23-staging.1', '1.0.22', d)).toEqual({ action: 'record' });
    });
    it('an unparseable running version does nothing at all', () => {
        expect(decideWhatsNew('0.0.0-dev', '1.0.0', d).action).toBe('record'); // older than recorded
        expect(decideWhatsNew('dev', '1.0.0', d)).toEqual({ action: 'none' });
    });
    it('ignores the [Unreleased] draft', () => {
        const withDraft: WhatsNewData = { releases: {}, unreleased: notes('Unreleased') };
        expect(decideWhatsNew('1.0.23', '1.0.22', withDraft)).toEqual({ action: 'record' });
    });
});

describe('notesForVersion', () => {
    it('is this version\'s notes, else the draft, else null', () => {
        const withDraft: WhatsNewData = { releases: { '1.0.23': notes('1.0.23') }, unreleased: notes('Unreleased') };
        expect(notesForVersion('1.0.23', withDraft)?.version).toBe('1.0.23');
        expect(notesForVersion('1.0.99', withDraft)?.version).toBe('Unreleased');
        expect(notesForVersion('1.0.99', data())).toBeNull();
    });
});

describe('formatReleaseDate', () => {
    it('formats an ISO date, in UTC, and tolerates anything else', () => {
        expect(formatReleaseDate('2026-10-14', 'en-US')).toBe('October 14, 2026');
        expect(formatReleaseDate(null)).toBeNull();
        expect(formatReleaseDate('soon')).toBeNull();
    });
});

describe('the seen-version record', () => {
    it('is classified as excluded from backups (it describes this install)', () => {
        expect(classifyKvKey(WHATS_NEW_SEEN_KEY, 'user-1')).toBe('exclude');
    });
});
