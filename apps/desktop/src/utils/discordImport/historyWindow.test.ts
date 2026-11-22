/**
 * The history window rule (owner 2026-11-22: "only import 1k messages instead
 * of the 5k"): per channel, the LARGER of the last 1,000 messages and the last
 * 30 days, at most 25,000. One rule, everywhere: the shared caps, main's reader
 * and the wizard's words.
 */
import { describe, it, expect } from 'vitest';
import { IMPORT_CAPS } from '@cipherline/shared';
import { HISTORY_WINDOW_SUMMARY, historyTruncatedNote } from './historyWindow';
import { HISTORY_MAX_MESSAGES, HISTORY_MIN_MESSAGES, HISTORY_WINDOW_MS } from '../../../electron/discord-import/history';

describe('the window: larger of the last 1,000 messages or 30 days, at most 25,000 per channel', () => {
    it('shared caps', () => {
        expect(IMPORT_CAPS.messagesPerChannelWindow).toBe(1000);
        expect(IMPORT_CAPS.windowDays).toBe(30);
        expect(IMPORT_CAPS.messagesPerChannelCeiling).toBe(25_000);
    });
    it('main reads by the same numbers', () => {
        expect(HISTORY_MIN_MESSAGES).toBe(IMPORT_CAPS.messagesPerChannelWindow);
        expect(HISTORY_MAX_MESSAGES).toBe(IMPORT_CAPS.messagesPerChannelCeiling);
        expect(HISTORY_WINDOW_MS).toBe(IMPORT_CAPS.windowDays * 86_400_000);
    });
    it('the preview / consent words say it', () => {
        expect(HISTORY_WINDOW_SUMMARY).toContain('the last 1,000 messages or everything from the last 30 days, whichever is more');
        expect(HISTORY_WINDOW_SUMMARY).toContain('at most 25,000 per channel');
        expect(HISTORY_WINDOW_SUMMARY).not.toMatch(/(^|[^\d])5,000/);
    });
    it('the report says why older messages stayed', () => {
        expect(historyTruncatedNote({ truncated: false })).toBe('');
        expect(historyTruncatedNote({ truncated: true })).toBe(' (older messages beyond 30 days and the last 1,000 were left on Discord)');
        expect(historyTruncatedNote({ truncated: true, ceilingHit: true })).toMatch(/more than 25,000 recent messages; the newest 25,000 came over/);
    });
});
