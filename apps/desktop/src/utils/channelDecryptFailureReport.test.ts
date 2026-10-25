import { describe, it, expect, vi, beforeEach } from 'vitest';

const reportBeta = vi.fn();
vi.mock('./betaDiagnostics/reporter', () => ({ reportBeta: (...a: unknown[]) => reportBeta(...a) }));

import { classifyChannelDecryptFailure, resetReportedChannelFailures } from './channelDecryptFailure';

/**
 * Beta diagnostics counted ATTEMPTS, not messages. A cached "couldn't decrypt"
 * placeholder is re-decrypted whenever its page is re-read, a key lands or a
 * reconcile runs, and each attempt filed another key_decrypt_failed. Measured
 * 2026-10-17: one member had ~220 channel messages in reach yet reported 723
 * failures in a single 10-minute window and 5,436 in a morning; another,
 * 667 across ten events — all `key_missing`, a handful of messages.
 */

const missing = new Error('[E2EE] Channel key for channel c epoch 7 not in local store');

beforeEach(() => {
    reportBeta.mockClear();
    resetReportedChannelFailures();
});

describe('key_decrypt_failed is reported once per message', () => {
    it('re-decrypting the same placeholder does not file again (was: once per attempt)', () => {
        for (let i = 0; i < 25; i++) classifyChannelDecryptFailure(missing, { epoch: 7, messageId: 'm1' });
        expect(reportBeta).toHaveBeenCalledTimes(1);
        expect(reportBeta).toHaveBeenCalledWith('key_decrypt_failed', { scope: 'channel', reason: 'key_missing' });
    });

    it('control: different messages each count once', () => {
        for (const id of ['m1', 'm2', 'm3', 'm1', 'm2']) classifyChannelDecryptFailure(missing, { epoch: 7, messageId: id });
        expect(reportBeta).toHaveBeenCalledTimes(3);
    });

    it('a message whose failure CHANGES kind is a new fact and is reported again', () => {
        classifyChannelDecryptFailure(missing, { messageId: 'm1' });
        classifyChannelDecryptFailure(new Error('Unsupported state or unable to authenticate data'), { messageId: 'm1' });
        expect(reportBeta.mock.calls.map(c => (c[1] as { reason: string }).reason)).toEqual(['key_missing', 'key_mismatch']);
    });

    it('control: a caller with no id keeps the old behaviour (every call reports)', () => {
        classifyChannelDecryptFailure(missing, { epoch: 7 });
        classifyChannelDecryptFailure(missing, { epoch: 7 });
        expect(reportBeta).toHaveBeenCalledTimes(2);
    });

    it('history_restricted is by design and never reported', () => {
        classifyChannelDecryptFailure(missing, { epoch: 3, latestKnownEpoch: 9, canReadHistory: false, messageId: 'm1' });
        expect(reportBeta).not.toHaveBeenCalled();
    });

    it('the classification itself is unchanged by de-duplication', () => {
        expect(classifyChannelDecryptFailure(missing, { messageId: 'm9' })).toBe('key_missing');
        expect(classifyChannelDecryptFailure(missing, { messageId: 'm9' })).toBe('key_missing');
    });

    it('resetting (sign-out) lets the same id report again', () => {
        classifyChannelDecryptFailure(missing, { messageId: 'm1' });
        resetReportedChannelFailures();
        classifyChannelDecryptFailure(missing, { messageId: 'm1' });
        expect(reportBeta).toHaveBeenCalledTimes(2);
    });
});

describe('wiring', () => {
    it('both Dashboard decrypt-failure sites pass the message id', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
        expect(src).toContain('messageId: evt.message_id }');
        expect(src).toContain('messageId: m.id }');
    });
});
