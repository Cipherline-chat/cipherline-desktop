import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { dataPacketErrorFromMessage, attachDataPacketErrorLog, annexBStatsFromMessage } from './e2eeWorkerStats';
import { getCallEvents, clearCallEvents } from './callEventLog';

describe('data-packet E2EE failures (annotations ride these)', () => {
    beforeEach(() => clearCallEvents());

    it('recognises the worker message livekit-client posts for a failed decryptDataRequest', () => {
        // Shape of livekit-client 2.18.8's e2ee worker `decryptDataRequest`
        // catch branch: { kind: 'error', data: { error, participantIdentity, uuid } }.
        const msg = { kind: 'error', data: { error: new Error('InvalidKey: Decryption failed: OperationError'), participantIdentity: 'alice', uuid: '0f0e' } };
        expect(dataPacketErrorFromMessage(msg)).toBe('invalid_key');
        expect(dataPacketErrorFromMessage({ kind: 'error', data: { error: new Error('MissingKey: missing key at index 0 for participant alice'), uuid: 'x' } })).toBe('missing_key');
    });

    it('the shape above is what the shipped worker actually posts (source pin)', () => {
        const req = createRequire(import.meta.url);
        // The ESM build — the one `import 'livekit-client/e2ee-worker'` in
        // workers/e2eeWorker.ts bundles.
        const worker = readFileSync(join(dirname(req.resolve('livekit-client')), 'livekit-client.e2ee.worker.mjs'), 'utf8');
        const i = worker.indexOf("case 'decryptDataRequest'");
        expect(i).toBeGreaterThan(0);
        const branch = worker.slice(i, i + 2500);
        expect(branch).toMatch(/kind: 'error'/);
        expect(branch).toMatch(/uuid: data\.uuid/);
    });

    it('ignores frame errors (no uuid), stats messages and junk', () => {
        expect(dataPacketErrorFromMessage({ kind: 'error', data: { error: new Error('InvalidKey: x') } })).toBeNull();
        expect(dataPacketErrorFromMessage({ kind: 'cl:annexb-stats', data: { frames: 1 } })).toBeNull();
        expect(dataPacketErrorFromMessage({ kind: 'decryptDataResponse', data: { uuid: 'u' } })).toBeNull();
        expect(dataPacketErrorFromMessage(null)).toBeNull();
        expect(annexBStatsFromMessage({ kind: 'error', data: { uuid: 'u' } })).toBeNull();
    });

    it('logs e2ee_data_error with the reason enum only — never the identity', () => {
        let handler: ((ev: MessageEvent) => void) | null = null;
        attachDataPacketErrorLog({ addEventListener: (_t: string, h: (ev: MessageEvent) => void) => { handler = h; } } as unknown as Pick<Worker, 'addEventListener'>);
        handler!({ data: { kind: 'error', data: { error: new Error('InvalidKey: Decryption failed'), participantIdentity: 'alice', uuid: 'u1' } } } as MessageEvent);
        const ev = getCallEvents().filter(e => e.kind === 'e2ee_data_error');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ reason: 'invalid_key' });
        expect(JSON.stringify(ev)).not.toContain('alice');
    });
});
