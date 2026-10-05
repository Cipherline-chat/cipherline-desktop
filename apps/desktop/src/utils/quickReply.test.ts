/**
 * Tests for the notification quick-reply logic.
 *
 * These cover the decisions that made a toast reply silently vanish — target
 * routing (the channel case was dropped entirely), text normalization, and
 * error description. The OS notification API itself is not exercised: inline
 * toast reply is a darwin/win32 feature and this suite runs on Linux CI, so the
 * platform half is verified by inspection, not here. See quickReply.ts.
 */

import { describe, it, expect } from 'vitest';
import {
    resolveQuickReplyTarget,
    normalizeQuickReplyText,
    buildQuickReplyContent,
    newClientMsgId,
    describeQuickReplyError,
} from './quickReply';
import { MAX_TEXT_MESSAGE_LENGTH } from '../constants';

describe('resolveQuickReplyTarget', () => {
    const conversations = [
        { id: 'conv-1' },
        { conversation_id: 'conv-2' },      // the other API shape
        { id: 'conv-3', conversation_id: 'conv-3' },
    ];
    const serverChannels = {
        'srv-a': [{ channel_id: 'chan-1' }, { channel_id: 'chan-2' }],
        'srv-b': [{ channel_id: 'chan-3' }],
    };

    it('routes a conversation keyed by `id` to the DM path', () => {
        expect(resolveQuickReplyTarget('conv-1', conversations, serverChannels))
            .toEqual({ kind: 'dm', conversationId: 'conv-1' });
    });

    it('routes a conversation keyed by `conversation_id` to the DM path', () => {
        // Both shapes appear in the client's conversation list; missing this one
        // would drop replies for an arbitrary subset of conversations.
        expect(resolveQuickReplyTarget('conv-2', conversations, serverChannels))
            .toEqual({ kind: 'dm', conversationId: 'conv-2' });
    });

    it('routes a server channel to the channel path, carrying its server id', () => {
        // The regression: channel toasts advertise a reply field, but the old
        // resolver only searched conversations and bailed, so every channel
        // reply was silently discarded.
        expect(resolveQuickReplyTarget('chan-3', conversations, serverChannels))
            .toEqual({ kind: 'channel', channelId: 'chan-3', serverId: 'srv-b' });
    });

    it('finds a channel in any loaded server, not just the first', () => {
        expect(resolveQuickReplyTarget('chan-2', conversations, serverChannels))
            .toEqual({ kind: 'channel', channelId: 'chan-2', serverId: 'srv-a' });
    });

    it('prefers a conversation when an id somehow appears in both', () => {
        const collide = { 'srv-a': [{ channel_id: 'conv-1' }] };
        expect(resolveQuickReplyTarget('conv-1', conversations, collide).kind).toBe('dm');
    });

    it('reports unknown rather than falling through, so the caller can re-resolve', () => {
        // This is the cold-start / Action-Center-reply case: the toast is real,
        // the list just has not hydrated. Naming it is what lets the caller
        // refresh instead of dropping the reply.
        expect(resolveQuickReplyTarget('nope', conversations, serverChannels))
            .toEqual({ kind: 'unknown', id: 'nope' });
    });

    it('treats an empty conversation list as unknown, not as an error', () => {
        expect(resolveQuickReplyTarget('conv-1', [], {}))
            .toEqual({ kind: 'unknown', id: 'conv-1' });
    });

    it('handles an empty id', () => {
        expect(resolveQuickReplyTarget('', conversations, serverChannels).kind).toBe('unknown');
    });

    it('tolerates a server whose channel list is missing', () => {
        const sparse = { 'srv-a': undefined as any };
        expect(() => resolveQuickReplyTarget('x', conversations, sparse)).not.toThrow();
    });
});

describe('normalizeQuickReplyText', () => {
    it('accepts ordinary text', () => {
        expect(normalizeQuickReplyText('hello')).toEqual({ ok: true, text: 'hello' });
    });

    it('trims surrounding whitespace', () => {
        // Windows toast input can carry the trailing newline from the Enter
        // that submitted it.
        expect(normalizeQuickReplyText('  hi there\n')).toEqual({ ok: true, text: 'hi there' });
    });

    it('preserves interior whitespace and newlines', () => {
        expect(normalizeQuickReplyText(' a\nb ')).toEqual({ ok: true, text: 'a\nb' });
    });

    it('rejects an empty string', () => {
        expect(normalizeQuickReplyText('')).toEqual({ ok: false, reason: 'empty' });
    });

    it('rejects a whitespace-only reply', () => {
        expect(normalizeQuickReplyText('   \t\n  ')).toEqual({ ok: false, reason: 'empty' });
    });

    it('rejects a non-string (defensive: the value crosses an IPC boundary)', () => {
        expect(normalizeQuickReplyText(undefined)).toEqual({ ok: false, reason: 'empty' });
        expect(normalizeQuickReplyText(null)).toEqual({ ok: false, reason: 'empty' });
        expect(normalizeQuickReplyText(42)).toEqual({ ok: false, reason: 'empty' });
    });

    it('accepts text exactly at the cap', () => {
        const at = 'x'.repeat(MAX_TEXT_MESSAGE_LENGTH);
        expect(normalizeQuickReplyText(at)).toEqual({ ok: true, text: at });
    });

    it('refuses text one character over the cap rather than truncating it', () => {
        // Silently clipping would be worse than refusing: the user would believe
        // they sent something they did not.
        const over = 'x'.repeat(MAX_TEXT_MESSAGE_LENGTH + 1);
        expect(normalizeQuickReplyText(over))
            .toEqual({ ok: false, reason: 'too_long', limit: MAX_TEXT_MESSAGE_LENGTH });
    });

    it('measures the cap after trimming', () => {
        const padded = `  ${'x'.repeat(MAX_TEXT_MESSAGE_LENGTH)}  `;
        expect(normalizeQuickReplyText(padded).ok).toBe(true);
    });
});

describe('buildQuickReplyContent', () => {
    it('produces a plain text ClientContent carrying the dedup id', () => {
        expect(buildQuickReplyContent('yo', 'id-1'))
            .toEqual({ client_msg_id: 'id-1', type: 'text', text: 'yo' });
    });

    it('does not attempt mention/emoji wire tokens', () => {
        // A toast reply has no composer token map, so "@dawson" must travel as
        // literal text rather than a half-encoded mention token.
        const c = buildQuickReplyContent('hi @dawson', 'id-2');
        expect(c.text).toBe('hi @dawson');
        expect(c).not.toHaveProperty('mentions');
    });
});

describe('newClientMsgId', () => {
    it('returns distinct non-empty ids', () => {
        const ids = new Set(Array.from({ length: 50 }, () => newClientMsgId()));
        expect(ids.size).toBe(50);
        for (const id of ids) expect(id.length).toBeGreaterThan(0);
    });
});

describe('describeQuickReplyError', () => {
    const withStatus = (status: number, message?: string) =>
        ({ response: { status, data: message ? { message } : {} } });

    it('explains a rate limit', () => {
        expect(describeQuickReplyError(withStatus(429))).toMatch(/too quickly/i);
    });

    it('surfaces the server message on a permission failure', () => {
        expect(describeQuickReplyError(withStatus(403, 'Channel is read-only')))
            .toBe('Channel is read-only');
    });

    it('falls back to a generic permission message when the server sends none', () => {
        expect(describeQuickReplyError(withStatus(403))).toMatch(/permission/i);
    });

    it('explains an expired session', () => {
        expect(describeQuickReplyError(withStatus(401))).toMatch(/sign in/i);
    });

    it('explains a missing channel key, the most likely channel-reply failure', () => {
        expect(describeQuickReplyError(new Error('No channel key for channel abc')))
            .toMatch(/key hasn’t arrived/i);
    });

    it('explains a server error', () => {
        expect(describeQuickReplyError(withStatus(503))).toMatch(/try again/i);
    });

    it('explains being offline', () => {
        expect(describeQuickReplyError({ code: 'ERR_NETWORK', message: 'Network Error' }))
            .toMatch(/offline/i);
    });

    it('always yields a message, never empty, for an unrecognised failure', () => {
        for (const e of [undefined, null, {}, 'boom', new Error('weird')]) {
            expect(describeQuickReplyError(e).length).toBeGreaterThan(0);
        }
    });
});
