/**
 * "Copy messages from Discord" into an existing server: the auto-match and the no-duplicates rule
 * (utils/discordImport/copyMapping.ts). The owner's case: an import left #general_chat and
 * #files_pictures EMPTY; those must be offered, every channel that already got messages must not.
 */
import { describe, it, expect } from 'vitest';
import { autoMatch, copyPlan, copyable, mentionRefs, normalizeChannelName, retarget, rowStatus, sourceKeysOf, type CopySourceChannel } from './copyMapping';
import type { ImportChannelMap } from './history/host';

const K = (c: string) => c.repeat(64);
const SOURCES: CopySourceChannel[] = [
    { num: 1, name: 'general_chat', sourceKey: K('a') },
    { num: 2, name: 'files_pictures', sourceKey: K('b') },
    { num: 3, name: 'rules', sourceKey: K('c') },
    { num: 4, name: 'memes', sourceKey: K('d') },
];
const TARGETS = [
    { channel_id: 'ch-general', name: 'general_chat' },
    { channel_id: 'ch-files', name: 'files-pictures' },
    { channel_id: 'ch-rules', name: '📜 Rules' },
    { channel_id: 'ch-memes', name: 'memes' },
    { channel_id: 'ch-memes2', name: 'Memes' },
];
const quota = { used: 1, limit: 3, window_days: 30 };

describe('normalizeChannelName', () => {
    it('ignores case, separators and a leading # / emoji', () => {
        expect(normalizeChannelName('files_pictures')).toBe('files-pictures');
        expect(normalizeChannelName('Files Pictures')).toBe('files-pictures');
        expect(normalizeChannelName('#files--pictures')).toBe('files-pictures');
        expect(normalizeChannelName('📜 Rules')).toBe('rules');
        expect(normalizeChannelName('général')).toBe('général');
        expect(normalizeChannelName('🎉')).toBe('');
    });
});

describe('autoMatch', () => {
    it('legacy import (no recorded sources): by unique name; an ambiguous name gets no target', () => {
        const rows = autoMatch(SOURCES, TARGETS, null);
        expect(rows.map(r => [r.source.name, r.target, r.matchedBy])).toEqual([
            ['general_chat', 'ch-general', 'name'],
            ['files_pictures', 'ch-files', 'name'],
            ['rules', 'ch-rules', 'name'],
            ['memes', null, null],               // "memes" and "Memes": ambiguous, the admin picks
        ]);
        expect(rows.map(r => r.status.kind)).toEqual(['ready', 'ready', 'ready', 'no-target']);
    });

    it('the previous import\'s mapping wins over the name, even when that channel came over empty', () => {
        const map: ImportChannelMap = {
            channels: [
                { channel_id: 'ch-memes2', imported_rows: 0, from: [{ source: 3, rows: 0 }], unknown_source_rows: 0 },  // memes -> "Memes" last time, nothing came
            ],
            imports: quota, active: null,
        };
        const rows = autoMatch(SOURCES, TARGETS, map);
        expect(rows[3]).toMatchObject({ target: 'ch-memes2', matchedBy: 'previous', status: { kind: 'ready' } });
    });

    it('each existing channel is used once', () => {
        const rows = autoMatch([{ num: 1, name: 'general' }, { num: 2, name: 'General' }], [{ channel_id: 'g', name: 'general' }], null);
        expect(rows.map(r => r.target)).toEqual(['g', null]);
    });
});

describe('the no-duplicates rule', () => {
    it('THE OWNER\'S CASE: channels that already got messages are skipped; the two that came over empty are offered', () => {
        // The first import (before sources were recorded): every channel but #general_chat / #files_pictures got rows.
        const map: ImportChannelMap = {
            channels: [
                { channel_id: 'ch-rules', imported_rows: 40, from: [], unknown_source_rows: 40 },
                { channel_id: 'ch-memes', imported_rows: 900, from: [], unknown_source_rows: 900 },
            ],
            imports: quota, active: null,
        };
        const rows = retarget(autoMatch(SOURCES, TARGETS, map), 4, 'ch-memes', map);
        expect(rows.map(r => [r.source.name, r.status.kind])).toEqual([
            ['general_chat', 'ready'], ['files_pictures', 'ready'], ['rules', 'unknown'], ['memes', 'unknown'],
        ]);
        expect(rows.filter(copyable).map(r => r.target)).toEqual(['ch-general', 'ch-files']);
    });

    it('a Discord channel already copied (recorded source with rows) is skipped wherever it would go', () => {
        const map: ImportChannelMap = {
            channels: [{ channel_id: 'ch-general', imported_rows: 250, from: [{ source: 0, rows: 250 }], unknown_source_rows: 0 }],
            imports: quota, active: null,
        };
        const keys = sourceKeysOf(SOURCES);
        expect(rowStatus(SOURCES[0], 'ch-general', map, keys)).toEqual({ kind: 'copied', rows: 250 });
        expect(rowStatus(SOURCES[0], 'ch-memes', map, keys)).toEqual({ kind: 'copied', rows: 250 });   // not into another channel either
        expect(rowStatus(SOURCES[0], null, map, keys)).toEqual({ kind: 'copied', rows: 250 });
    });

    it('POSITIVE CONTROL: a recorded source with 0 rows (it failed last time) is copyable', () => {
        const map: ImportChannelMap = {
            channels: [{ channel_id: 'ch-files', imported_rows: 0, from: [{ source: 1, rows: 0 }], unknown_source_rows: 0 }],
            imports: quota, active: null,
        };
        expect(rowStatus(SOURCES[1], 'ch-files', map, sourceKeysOf(SOURCES))).toEqual({ kind: 'ready' });
    });

    it('rows from ANOTHER known Discord channel in the target do not block (no duplicate is possible)', () => {
        const map: ImportChannelMap = {
            channels: [{ channel_id: 'ch-general', imported_rows: 10, from: [{ source: 3, rows: 10 }], unknown_source_rows: 0 }],
            imports: quota, active: null,
        };
        expect(rowStatus(SOURCES[0], 'ch-general', map, sourceKeysOf(SOURCES))).toEqual({ kind: 'ready' });
    });

    it('retarget re-applies the rule (moving onto a channel with unknown imported rows skips it)', () => {
        const map: ImportChannelMap = { channels: [{ channel_id: 'ch-rules', imported_rows: 5, from: [], unknown_source_rows: 5 }], imports: quota, active: null };
        let rows = autoMatch(SOURCES.slice(0, 1), TARGETS, map);
        expect(rows[0].status.kind).toBe('ready');
        rows = retarget(rows, 1, 'ch-rules', map);
        expect(rows[0]).toMatchObject({ matchedBy: 'manual', status: { kind: 'unknown', rows: 5 } });
        rows = retarget(rows, 1, null, map);
        expect(rows[0]).toMatchObject({ target: null, status: { kind: 'no-target' } });
    });
});

describe('copyPlan', () => {
    it('only ticked, copyable rows; two Discord channels into one existing channel is a clash', () => {
        let rows = autoMatch(SOURCES, TARGETS, null);
        rows = retarget(rows, 4, 'ch-general', null);
        const all = new Set([1, 2, 3, 4]);
        const p = copyPlan(rows, all);
        expect(p.clash).toEqual(['ch-general']);
        const ok = copyPlan(rows, new Set([1, 2, 3]));
        expect(ok.clash).toEqual([]);
        expect(ok.channels).toEqual([
            { num: 1, name: 'general_chat', channelId: 'ch-general', sourceKey: K('a') },
            { num: 2, name: 'files_pictures', channelId: 'ch-files', sourceKey: K('b') },
            { num: 3, name: 'rules', channelId: 'ch-rules', sourceKey: K('c') },
        ]);
        // A skipped row is never planned even when ticked.
        const map: ImportChannelMap = { channels: [{ channel_id: 'ch-rules', imported_rows: 1, from: [], unknown_source_rows: 1 }], imports: quota, active: null };
        expect(copyPlan(autoMatch(SOURCES, TARGETS, map), all).channels.map(c => c.num)).toEqual([1, 2]);
    });

    it('mentionRefs: every mapped Discord channel, so #mentions link to the existing channel', () => {
        expect(mentionRefs(autoMatch(SOURCES, TARGETS, null))).toEqual({ 'c:1': 'ch-general', 'c:2': 'ch-files', 'c:3': 'ch-rules' });
    });
});
