import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { senderDisplayName, isOwnMessage, type SenderNameContext } from './senderDisplayName';

const ctx = (over: Partial<SenderNameContext> = {}): SenderNameContext => ({
    inServerChannel: false,
    nicknames: { alice: 'Al' },
    userIdToUsername: { alice: 'alice', me: 'bob' },
    deviceToUsername: { 'dev-x': 'mallory', 'dev-alice': 'alice' },
    myUserId: 'me', myUsername: 'bob', myDeviceIds: new Set(['my-dev']),
    ...over,
});

describe('senderDisplayName', () => {
    it('nickname only inside a server channel', () => {
        expect(senderDisplayName({ sender_user_id: 'alice' }, ctx({ inServerChannel: true }))).toBe('Al');
        expect(senderDisplayName({ sender_user_id: 'alice' }, ctx())).toBe('alice');
    });
    it('F4: a user id wins over a device id the sender chose', () => {
        expect(senderDisplayName({ sender_user_id: 'alice', sender_device_id: 'dev-x' }, ctx())).toBe('alice');
        // A user id we cannot name does NOT fall back to the device claim.
        expect(senderDisplayName({ sender_user_id: 'stranger', sender_device_id: 'dev-x' }, ctx())).toBe('Unknown User');
    });
    it('device fallback only when there is no user id; own messages read as you', () => {
        expect(senderDisplayName({ sender_device_id: 'dev-alice' }, ctx())).toBe('alice');
        expect(senderDisplayName({ sender_device_id: 'my-dev' }, ctx({ deviceToUsername: {} }))).toBe('bob');
        expect(senderDisplayName({ sender_user_id: 'me' }, ctx({ userIdToUsername: {} }))).toBe('bob');
        expect(isOwnMessage({ sender_user_id: 'me', sender_device_id: 'dev-x' }, ctx())).toBe(true);
    });
    it('an empty nickname falls through to the username', () => {
        expect(senderDisplayName({ sender_user_id: 'alice' }, ctx({ inServerChannel: true, nicknames: { alice: '' } }))).toBe('alice');
    });
});

// Owner, 2026-11-16: "I want replies to look like mobile also. where they show
// who sent the original message rather than just the content".
describe('ChatPane reply quote shows the original author', () => {
    const src = readFileSync(resolve(__dirname, '../components/ChatPane.tsx'), 'utf8');
    it('header and quote resolve names through the same helper and context', () => {
        expect(src).toContain('const resolvedName = senderDisplayName(msg, nameCtx);');
        expect(src).toContain('const replyWho = replyTarget ? senderDisplayName(replyTarget, nameCtx) : null;');
    });
    it('the quote renders the author line above the snippet', () => {
        expect(src).toMatch(/data-testid="reply-quote"[\s\S]{0,700}?\{replyWho && \([\s\S]{0,200}?data-testid="reply-quote-author"[\s\S]{0,200}?\{replyWho\}[\s\S]{0,200}?\{replyLine\}/);
    });
});
