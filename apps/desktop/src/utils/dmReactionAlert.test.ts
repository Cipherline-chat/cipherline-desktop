import { describe, it, expect } from 'vitest';
import {
    decideDmReactionAlert, reactionAlertKey, rememberAlerted, reactionTargetPreview, reactionToastBody,
    type DmReactionAlertInput,
} from './dmReactionAlert';

const base: DmReactionAlertInput = {
    op: 'add', conversationKind: 'dm', reactorIsMe: false, muted: false, dmOpenAndFocused: false,
    eventMs: 2000, lastReadMs: 1000, alreadyAlerted: false,
};
const d = (o: Partial<DmReactionAlertInput>) => decideDmReactionAlert({ ...base, ...o });
const YES = { affectsUnread: true, notify: true };
const NO = { affectsUnread: false, notify: false };

describe('decideDmReactionAlert', () => {
    it('alerts on a live add from the other person in a DM', () => expect(d({})).toEqual(YES));
    it('alerts when the DM has never been read (no cursor)', () => expect(d({ lastReadMs: undefined })).toEqual(YES));
    it.each(['group', 'channel', 'thread'] as const)('never alerts in a %s', k => expect(d({ conversationKind: k })).toEqual(NO));
    it('never alerts on remove', () => expect(d({ op: 'remove' })).toEqual(NO));
    it('never alerts on my own reaction (any of my devices)', () => expect(d({ reactorIsMe: true })).toEqual(NO));
    it('never alerts on a duplicate', () => expect(d({ alreadyAlerted: true })).toEqual(NO));
    it('never alerts when muted', () => expect(d({ muted: true })).toEqual(NO));
    it('no unread and no toast while the DM is open and focused', () => expect(d({ dmOpenAndFocused: true })).toEqual(NO));
    it('never alerts for a reaction at or before the last-read point', () => {
        expect(d({ eventMs: 1000 })).toEqual(NO);
        expect(d({ eventMs: 999 })).toEqual(NO);
        expect(d({ eventMs: 1001 })).toEqual(YES);
    });
    it('fails closed on an unknown or invalid event time', () => {
        expect(d({ eventMs: undefined })).toEqual(NO);
        expect(d({ eventMs: NaN })).toEqual(NO);
    });
    it('an invalid cursor does not suppress a live reaction', () => expect(d({ lastReadMs: NaN })).toEqual(YES));
    it('affectsUnread and notify never disagree', () => {
        for (const op of ['add', 'remove'] as const)
            for (const kind of ['dm', 'group'] as const)
                for (const reactorIsMe of [true, false])
                    for (const muted of [true, false])
                        for (const open of [true, false])
                            for (const alreadyAlerted of [true, false]) {
                                const r = d({ op, conversationKind: kind, reactorIsMe, muted, dmOpenAndFocused: open, alreadyAlerted });
                                expect(r.affectsUnread).toBe(r.notify);
                            }
    });
});

describe('alerted set', () => {
    it('keys differ by every component', () => {
        const k = reactionAlertKey('c', 'm', '👍', 'u');
        expect(reactionAlertKey('c2', 'm', '👍', 'u')).not.toBe(k);
        expect(reactionAlertKey('c', 'm2', '👍', 'u')).not.toBe(k);
        expect(reactionAlertKey('c', 'm', '❤️', 'u')).not.toBe(k);
        expect(reactionAlertKey('c', 'm', '👍', 'u2')).not.toBe(k);
    });
    it('is bounded, dropping the oldest', () => {
        const s = new Set<string>();
        for (let i = 0; i < 5; i++) rememberAlerted(s, `k${i}`, 3);
        expect([...s]).toEqual(['k2', 'k3', 'k4']);
    });
});

describe('reactionTargetPreview / reactionToastBody', () => {
    it('text target, whitespace-collapsed', () => expect(reactionTargetPreview({ type: 'text', text: 'hi\n  there' })).toBe('hi there'));
    it('truncates long text', () => {
        const p = reactionTargetPreview({ type: 'text', text: 'x'.repeat(500) });
        expect(p.length).toBe(100);
        expect(p.endsWith('…')).toBe(true);
    });
    it('uses message-preview placeholders for non-text', () => {
        expect(reactionTargetPreview({ type: 'attachment' })).toBe('📎 Attachment');
        expect(reactionTargetPreview({ type: 'klipy_gif' })).toBe('GIF');
        expect(reactionTargetPreview({ type: 'poll' })).toBe('message');
    });
    it('unknown target gives empty preview', () => expect(reactionTargetPreview(undefined)).toBe(''));
    it('body format', () => expect(reactionToastBody('👍', 'lunch?', false)).toBe('Reacted 👍 to: “lunch?”'));
    it('body with unknown target', () => expect(reactionToastBody('👍', '', false)).toBe('Reacted 👍 to a message'));
    it('hidden preview', () => expect(reactionToastBody('👍', 'secret', true)).toBe('Reacted to a message'));
    it('custom emoji shown by name', () => expect(reactionToastBody('<:party:abc123>', 'x', false)).toContain(':party:'));
});
