import { describe, it, expect } from 'vitest';
import { correctedUnreadCount } from './channelMentionRecovery';

const ME = 'me';
const THEM = 'them';
const row = (sender: string | null, content: unknown) => ({ sender_user_id: sender, content });
const react = (action: 'add' | 'remove' = 'add') => ({ type: 'reaction', target_id: 't', emoji: 'x', action });
const placeholder = { type: 'system', kind: 'encrypted', data: { reason: 'key_missing', epoch: 3 } };

// The server's GET /servers/:id/unread counts every row past the cursor that is
// not yours, reactions included (they are opaque E2EE rows to it). The owner's
// rule: a reaction in a server channel never lights unread.
describe('correctedUnreadCount (server channel reconcile)', () => {
    it('a channel whose only new rows are other people\'s reactions has 0 unread', () => {
        expect(correctedUnreadCount(2, [row(THEM, react()), row(THEM, react())], ME)).toBe(0);
    });
    it('reaction removals do not count either', () => {
        expect(correctedUnreadCount(1, [row(THEM, react('remove'))], ME)).toBe(0);
    });
    it('edits and delete markers do not count', () => {
        expect(correctedUnreadCount(2, [
            row(THEM, { type: 'edit', target_id: 't', text: 'y' }),
            row(THEM, { type: 'delete', target_id: 't' }),
        ], ME)).toBe(0);
    });
    it('a real message beside a reaction counts once', () => {
        expect(correctedUnreadCount(2, [row(THEM, { type: 'text', text: 'hi' }), row(THEM, react())], ME)).toBe(1);
    });
    it('an undecryptable row still counts as a message', () => {
        expect(correctedUnreadCount(1, [row(THEM, placeholder)], ME)).toBe(1);
    });
    it('your own reaction is not subtracted (the server never counted it)', () => {
        expect(correctedUnreadCount(1, [row(ME, react()), row(THEM, { type: 'text', text: 'hi' })], ME)).toBe(1);
    });
    it('never goes negative and never lowers a count with no action rows', () => {
        expect(correctedUnreadCount(1, [row(THEM, react()), row(THEM, react())], ME)).toBe(0);
        expect(correctedUnreadCount(3, [row(THEM, { type: 'text', text: 'a' })], ME)).toBe(3);
        expect(correctedUnreadCount(3, [], ME)).toBe(3);
    });
});
