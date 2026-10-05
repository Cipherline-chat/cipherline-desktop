import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastReadableMessageId, readReceiptToSend } from './readReceipt';

/**
 * Message integrity §5 (mobile handoff, 2026-09-24): keep
 * `last_read_message_id` in `message:read`, and make sure what it names is a
 * message every one of the user's devices can know. See readReceipt.ts.
 */
const text = (id: string) => ({ id, content: { type: 'text' } });
const A = '0a0a0a0a-1111-4222-8333-444455556666';
const B = '0b0b0b0b-1111-4222-8333-444455556666';
const groupEvent = { id: 'system-1727000000000-k3j2', content: { type: 'system', text: 'Ana added Bo' } };
const placeholder = { id: '8f0c7a8e-1111-4222-8333-444455556666', content: { type: 'system', kind: 'undecryptable' } };

describe('lastReadableMessageId', () => {
    it('names the newest message', () => {
        expect(lastReadableMessageId([text(A), text(B)])).toBe(B);
    });

    it('skips an undecryptable placeholder — its id is this device\'s envelope id, unknown elsewhere', () => {
        expect(lastReadableMessageId([text(A), placeholder])).toBe(A);
    });

    it('skips a local group-event row — its id is not a UUID and the gateway would reject the receipt', () => {
        expect(lastReadableMessageId([text(A), groupEvent, placeholder])).toBe(A);
    });

    it('sends nothing when there is no real message yet', () => {
        expect(lastReadableMessageId([groupEvent, placeholder])).toBeNull();
        expect(lastReadableMessageId([])).toBeNull();
    });

    it('skips a locally minted non-UUID row (the global call banner\'s `global-<ts>` call_key) — the gateway would drop the whole receipt', () => {
        const globalCallKey = { id: `global-${1727000000000}`, content: { type: 'call_key' } };
        expect(lastReadableMessageId([text(A), globalCallKey])).toBe(A);
    });
});

describe('readReceiptToSend — no read without a reader; receipts-off still syncs my devices', () => {
    const base = { lastId: B, lastSentId: A, attended: true, showReadReceipts: true };
    it('sends the classic receipt when a human is looking and receipts are on', () => {
        expect(readReceiptToSend(base)).toEqual({ id: B, selfOnly: false });
    });
    it('sends NOTHING while the window is unfocused or hidden (the phone badge must not clear for an unseen message)', () => {
        expect(readReceiptToSend({ ...base, attended: false })).toBeNull();
    });
    it('receipts OFF: still tells my own devices (self_only), never the other person', () => {
        expect(readReceiptToSend({ ...base, showReadReceipts: false })).toEqual({ id: B, selfOnly: true });
    });
    it('does not resend the same id, and sends nothing with no readable message', () => {
        expect(readReceiptToSend({ ...base, lastSentId: B })).toBeNull();
        expect(readReceiptToSend({ ...base, lastId: null })).toBeNull();
    });
});

describe('the receipt keeps its field, and ChatPane picks the id through the helper', () => {
    const code = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    it('useRealtime sends message:read WITH last_read_message_id (mobile\'s gap detector reads it)', () => {
        const src = code('hooks/useRealtime.ts');
        expect(src).toContain("event: 'message:read'");
        expect(src).toContain('{ conversation_id, last_read_message_id, read_at: Date.now() }');
        expect(src).toContain('{ conversation_id, last_read_message_id, read_at: Date.now(), self_only: true }');
    });

    it('ChatPane derives the id with lastReadableMessageId, not "the last row"', () => {
        const src = code('components/ChatPane.tsx');
        expect(src).toContain('lastReadableMessageId(messages)');
        // ...and decides through readReceiptToSend, which needs an attended window.
        expect(src).toContain('readReceiptToSend({');
        expect(src).toContain('attended: windowAttended');
        expect(src).not.toContain('const lastMsg = messages[messages.length - 1];\n        if (!lastMsg?.id || lastMsg.id === lastSentReceiptRef.current) return;');
    });
});
