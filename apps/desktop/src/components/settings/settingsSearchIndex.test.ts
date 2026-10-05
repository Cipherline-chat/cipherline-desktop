import { describe, it, expect } from 'vitest';
import { SETTINGS_INDEX, searchSettingsIndex } from './settingsSearchIndex';

describe('SETTINGS_INDEX', () => {
    it('every pane has at least two indexed settings', () => {
        for (const [pane, entries] of Object.entries(SETTINGS_INDEX)) {
            expect(entries.length, `pane "${pane}" has no searchable entries`).toBeGreaterThanOrEqual(2);
        }
    });

    it('keywords are lowercase (matching lowercases the query, not the index)', () => {
        for (const entries of Object.values(SETTINGS_INDEX)) {
            for (const e of entries) {
                for (const k of e.keywords ?? []) {
                    expect(k).toBe(k.toLowerCase());
                }
            }
        }
    });
});

describe('searchSettingsIndex', () => {
    it('finds settings by visible label, case-insensitively', () => {
        expect(searchSettingsIndex('Start Minimized').appearance).toContain('Start minimized');
        expect(searchSettingsIndex('noise').voice).toContain('Noise suppression');
    });

    it('finds settings by synonym keywords', () => {
        expect(searchSettingsIndex('ptt').keybinds).toContain('Mute keybind');
        expect(searchSettingsIndex('autostart').appearance).toContain('Start with Windows');
        expect(searchSettingsIndex('2fa').profile).toContain('Two-factor authentication');
        expect(searchSettingsIndex('gdpr').danger).toContain('Delete account');
    });

    it('empty or whitespace query matches nothing', () => {
        expect(searchSettingsIndex('')).toEqual({});
        expect(searchSettingsIndex('   ')).toEqual({});
    });

    it('a query can hit multiple panes', () => {
        const hits = searchSettingsIndex('lock');
        expect(Object.keys(hits)).toEqual(expect.arrayContaining(['privacy', 'keybinds']));
    });
});
