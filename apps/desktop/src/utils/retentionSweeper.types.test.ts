import { describe, it, expect } from 'vitest';
import { clampFutureTimestamp, retentionRuleFor, sweepRetention } from './retentionSweeper';
import { attachmentRetentionMs, messageRetentionMs, type StoragePolicy } from '../hooks/useRetentionPolicy';

/**
 * Per-content-type retention, plus the arithmetic at the edges.
 *
 * The sweeper used to delete only text / klipy_gif / system / call_event /
 * attachment and "keep everything else untouched". That allow-list silently
 * exempted `server_invite` (which the UI shows a "Deletes in N days" countdown
 * on), `safety_number`, and `call_key` — the DM call bar, whose row also holds
 * the call's media key. Control rows (edit / delete / reaction / …) are still
 * kept on purpose.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const policy = (over: Partial<StoragePolicy> = {}): StoragePolicy => ({
    messageRetention: '1wk',
    attachmentRetention: '1wk',
    savedMessageIds: [],
    unsavedMessageIds: [],
    savedAttachmentIds: [],
    unsavedAttachmentIds: [],
    unsavedMessageTimestamps: {},
    unsavedAttachmentTimestamps: {},
    ...over,
} as StoragePolicy);

const row = (id: string, type: string, ageMs: number, extra: Record<string, unknown> = {}) => ({
    id,
    timestamp: NOW - ageMs,
    content: { type, ...extra },
});

describe('retentionRuleFor', () => {
    it('sends every visible non-file row to the message window', () => {
        for (const t of ['text', 'klipy_gif', 'system', 'call_event', 'call_key', 'server_invite', 'safety_number', 'some_future_type']) {
            expect(retentionRuleFor(t)).toBe('message');
        }
    });
    it('keeps control rows and rows with no readable type', () => {
        for (const t of ['edit', 'delete', 'reaction', 'pin', 'profile_update', 'group_update', 'channel_key', 'channel_message']) {
            expect(retentionRuleFor(t)).toBe('keep');
        }
        expect(retentionRuleFor(undefined)).toBe('keep');
        expect(retentionRuleFor('')).toBe('keep');
    });
    it('sends attachments to the attachment window', () => {
        expect(retentionRuleFor('attachment')).toBe('attachment');
    });
});

describe('sweepRetention — every visible row type expires', () => {
    const OLD = 8 * DAY;       // 1wk window
    const types: Array<[string, Record<string, unknown>]> = [
        ['text', { text: 'hi' }],
        ['klipy_gif', {}],
        ['system', { text: 'x joined' }],
        ['call_event', { event: 'ended' }],
        ['call_key', { call_id: 'c1', e2ee_key_b64: 'KEYMATERIAL' }],
        ['server_invite', { code: 'abc' }],
        ['safety_number', { code: 'X'.repeat(40) }],
    ];

    for (const [type, extra] of types) {
        it(`${type}: dropped past the window, kept inside it, tombstoned`, () => {
            const state = { c: [row('old', type, OLD, extra), row('fresh', type, HOUR, extra)] };
            const out = sweepRetention(state, policy(), NOW);
            expect(out.prunedState.c.map(m => m.id)).toEqual(['fresh']);
            expect(out.purgedMessageIds).toEqual({ c: ['old'] });
        });

        it(`${type}: a saved one survives, an explicitly unsaved one gets the 24h grace, a pinned one survives`, () => {
            const old = row('m', type, OLD, extra);
            // saved
            expect(sweepRetention({ c: [old] }, policy({ savedMessageIds: ['m'] }), NOW).prunedState.c).toHaveLength(1);
            // pinned
            expect(sweepRetention({ c: [old] }, policy(), NOW, { c: new Set(['m']) }).prunedState.c).toHaveLength(1);
            // unsaved 1h ago: still inside the 24h grace
            const graceful = policy({ unsavedMessageIds: ['m'], unsavedMessageTimestamps: { m: NOW - HOUR } });
            expect(sweepRetention({ c: [old] }, graceful, NOW).prunedState.c).toHaveLength(1);
            // unsaved 25h ago: grace over, past the window -> gone
            const expired = policy({ unsavedMessageIds: ['m'], unsavedMessageTimestamps: { m: NOW - 25 * HOUR } });
            expect(sweepRetention({ c: [old] }, expired, NOW).prunedState.c).toHaveLength(0);
        });
    }

    it('a call_key row takes its media key with it', () => {
        const out = sweepRetention({ c: [row('k', 'call_key', OLD, { e2ee_key_b64: 'KEYMATERIAL' })] }, policy(), NOW);
        expect(JSON.stringify(out.prunedState)).not.toContain('KEYMATERIAL');
    });

    it('never touches control rows, however old', () => {
        const ctl = ['edit', 'delete', 'reaction', 'pin', 'profile_update', 'group_update', 'channel_key', 'channel_message']
            .map((t, i) => row(`ctl${i}`, t, 400 * DAY));
        const out = sweepRetention({ c: ctl }, policy(), NOW);
        expect(out.prunedState.c).toHaveLength(ctl.length);
        expect(out.purgedMessageIds).toEqual({});
    });

    it('never touches a row with no readable type', () => {
        const odd = [{ id: 'a', timestamp: NOW - 400 * DAY }, { id: 'b', timestamp: NOW - 400 * DAY, content: {} }];
        expect(sweepRetention({ c: odd }, policy(), NOW).prunedState.c).toHaveLength(2);
    });
});

describe('sweepRetention — boundaries', () => {
    it('keeps a message 1 ms inside the window and drops one exactly on it', () => {
        const W = messageRetentionMs('1wk');
        const state = { c: [row('inside', 'text', W - 1), row('edge', 'text', W)] };
        const out = sweepRetention(state, policy(), NOW);
        expect(out.prunedState.c.map(m => m.id)).toEqual(['inside']);
    });

    it('window arithmetic: a "month" is 30 days, a year 365, 6mo 182, 3mo 91', () => {
        expect(messageRetentionMs('1mo')).toBe(30 * DAY);
        expect(messageRetentionMs('1y')).toBe(365 * DAY);
        expect(messageRetentionMs('6mo')).toBe(182 * DAY);
        expect(messageRetentionMs('3mo')).toBe(91 * DAY);
        expect(attachmentRetentionMs('24h')).toBe(DAY);
    });

    it('a window this build does not know deletes NOTHING (it used to delete everything)', () => {
        const weird = policy({ messageRetention: '2y' as never, attachmentRetention: '5min' as never });
        const state = {
            c: [row('t', 'text', 900 * DAY), row('a', 'attachment', 900 * DAY, { attachment_id: 'att' })],
        };
        const out = sweepRetention(state, weird, NOW);
        expect(out.prunedState.c).toHaveLength(2);
        expect(out.attachmentsToDelete).toEqual([]);
    });

    it('a pending row is protected for 24h, then follows the normal rule', () => {
        const fresh = { ...row('p1', 'text', 2 * HOUR), _pending: true };
        const stale = { ...row('p2', 'text', 8 * DAY), _pending: true };
        const out = sweepRetention({ c: [fresh, stale] }, policy(), NOW);
        expect(out.prunedState.c.map(m => m.id)).toEqual(['p1']);
    });

    it('"never" keeps everything, attachments included', () => {
        const p = policy({ messageRetention: 'never', attachmentRetention: 'never' });
        const state = { c: [row('t', 'text', 900 * DAY), row('a', 'attachment', 900 * DAY, { attachment_id: 'x' })] };
        expect(sweepRetention(state, p, NOW).prunedState).toBe(state);
    });
});

describe('clampFutureTimestamp', () => {
    it('leaves a past or just-now timestamp alone (a late-delivered message is still that old)', () => {
        const past = new Date(NOW - 10 * DAY).toISOString();
        expect(clampFutureTimestamp(past, NOW)).toBe(past);
        const slightlyAhead = new Date(NOW + 2 * 60_000).toISOString();     // within 5 min of skew
        expect(clampFutureTimestamp(slightlyAhead, NOW)).toBe(slightlyAhead);
    });
    it('pulls a far-future timestamp back to the moment of receipt', () => {
        const future = new Date(NOW + 400 * DAY).toISOString();
        expect(clampFutureTimestamp(future, NOW)).toBe(new Date(NOW).toISOString());
    });
    it('treats an unreadable timestamp as "now" rather than propagating NaN', () => {
        expect(clampFutureTimestamp('not a date', NOW)).toBe(new Date(NOW).toISOString());
        expect(clampFutureTimestamp(undefined, NOW)).toBe(new Date(NOW).toISOString());
    });
    it('a clamped far-future message now expires on schedule', () => {
        const ts = clampFutureTimestamp(new Date(NOW + 400 * DAY).toISOString(), NOW - 8 * DAY);
        // received 8 days ago with a forged year-ahead stamp
        const out = sweepRetention({ c: [{ id: 'f', timestamp: ts, content: { type: 'text' } }] }, policy(), NOW);
        expect(out.prunedState.c).toHaveLength(0);
    });
});
