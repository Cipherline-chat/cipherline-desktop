import { describe, it, expect, beforeEach } from 'vitest';
import { record, snapshot, counts, clear, extractE2eeCode, formatReport } from './deliveryDiagnostics';

describe('extractE2eeCode', () => {
    it('extracts the bracketed code from a prefixed message', () => {
        expect(extractE2eeCode('[E2EE:NO_RECIPIENT_ENTRY] No recipient entry for device abc')).toBe('NO_RECIPIENT_ENTRY');
    });

    it('falls back to UNKNOWN for an unprefixed message', () => {
        expect(extractE2eeCode('Network request failed')).toBe('UNKNOWN');
    });

    it('handles an Electron IPC-wrapped message', () => {
        const wrapped = "Error invoking remote method 'crypto:decrypt-message': Error: [E2EE:REPLAY] Replay detected — duplicate ephemeral key";
        expect(extractE2eeCode(wrapped)).toBe('REPLAY');
    });
});

describe('deliveryDiagnostics ring buffer', () => {
    beforeEach(() => clear());

    it('records an entry with kind, code, ctx, and message', () => {
        record('message_decrypt', new Error('[E2EE:NO_RECIPIENT_ENTRY] boom'), { envelope_id: 'e1', conversation_id: 'c1' });
        const [entry] = snapshot();
        expect(entry.kind).toBe('message_decrypt');
        expect(entry.code).toBe('NO_RECIPIENT_ENTRY');
        expect(entry.ctx).toEqual({ envelope_id: 'e1', conversation_id: 'c1' });
        expect(entry.message).toContain('boom');
    });

    it('accepts a non-Error thrown value', () => {
        record('channel_key_decrypt', 'a plain string throw', {});
        expect(snapshot()[0].message).toBe('a plain string throw');
        expect(snapshot()[0].code).toBe('UNKNOWN');
    });

    it('snapshot returns newest-first', () => {
        record('message_decrypt', new Error('[E2EE:REPLAY] first'), {});
        record('message_decrypt', new Error('[E2EE:SIG_INVALID] second'), {});
        const snap = snapshot();
        expect(snap[0].message).toContain('second');
        expect(snap[1].message).toContain('first');
    });

    it('caps at 200 entries, dropping the oldest', () => {
        for (let i = 0; i < 205; i++) {
            record('message_decrypt', new Error(`[E2EE:REPLAY] entry-${i}`), { i });
        }
        const snap = snapshot();
        expect(snap.length).toBe(200);
        // Newest-first: entry-204 should be present, entry-0..4 should have been evicted.
        expect(snap[0].message).toContain('entry-204');
        expect(snap.some(e => e.message.includes('entry-0)'))).toBe(false);
    });

    it('counts aggregates by kind:code', () => {
        record('message_decrypt', new Error('[E2EE:REPLAY] a'), {});
        record('message_decrypt', new Error('[E2EE:REPLAY] b'), {});
        record('channel_key_decrypt', new Error('[E2EE:SIG_INVALID] c'), {});
        expect(counts()).toEqual({
            'message_decrypt:REPLAY': 2,
            'channel_key_decrypt:SIG_INVALID': 1,
        });
    });

    it('clear empties the buffer', () => {
        record('message_decrypt', new Error('[E2EE:REPLAY] x'), {});
        clear();
        expect(snapshot()).toEqual([]);
        expect(counts()).toEqual({});
    });

    it('formatReport handles an empty buffer', () => {
        expect(formatReport()).toBe('No delivery failures recorded this session.');
    });

    it('formatReport includes a summary and per-entry detail', () => {
        record('message_decrypt', new Error('[E2EE:NO_RECIPIENT_ENTRY] boom'), { envelope_id: 'e1' });
        const report = formatReport();
        expect(report).toContain('message_decrypt:NO_RECIPIENT_ENTRY: 1');
        expect(report).toContain('envelope_id=e1');
        expect(report).toContain('boom');
    });

    it('formatReport omits undefined ctx values', () => {
        record('message_decrypt', new Error('[E2EE:REPLAY] x'), { envelope_id: 'e1', epoch: undefined });
        expect(formatReport()).not.toContain('epoch=undefined');
    });
});
