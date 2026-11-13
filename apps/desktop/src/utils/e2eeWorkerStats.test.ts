import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { dataPacketErrorFromMessage, attachDataPacketErrorLog, annexBStatsFromMessage, AudioLagFolder, AUDIO_LAG_FOLD_MS, AUDIO_LAG_NOTABLE_MS } from './e2eeWorkerStats';
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

describe('e2ee_audio_lag folding (2026-11-10: 41-51 jitter windows filled each report)', () => {
    const win = (maxMs: number, extra: Partial<{ dropped: number; rebases: number }> = {}) => ({ dir: 'recv', frames: 500, dropped: 0, rebases: 0, maxMs, ...extra });

    it('stays silent for a minute of ordinary jitter (120-350 ms, nothing dropped)', () => {
        const f = new AudioLagFolder();
        for (let i = 0; i < 6; i++) expect(f.add(win(150 + i * 30), i * 10_000)).toBeNull();
        expect(f.add(win(200), AUDIO_LAG_FOLD_MS)).toBeNull();
    });

    it('reports a fold whose worst window reached the notable lag, with the windows counted', () => {
        const f = new AudioLagFolder();
        for (let i = 0; i < 5; i++) f.add(win(i === 2 ? AUDIO_LAG_NOTABLE_MS + 115 : 180), i * 10_000);
        expect(f.add(win(190), AUDIO_LAG_FOLD_MS)).toEqual({ dir: 'recv', windows: 6, frames: 3000, dropped: 0, maxMs: 515, rebases: 0 });
    });

    it('reports a drop or a re-base at once, whatever the lag', () => {
        const f = new AudioLagFolder();
        expect(f.add(win(130, { dropped: 4 }), 1000)).toMatchObject({ dropped: 4, windows: 1 });
        expect(f.add(win(130, { rebases: 1 }), 2000)).toMatchObject({ rebases: 1 });
    });

    it('folds the two directions separately', () => {
        const f = new AudioLagFolder();
        f.add({ ...win(500), dir: 'send' }, 0);
        expect(f.add(win(150), 5000)).toBeNull();
        expect(f.add({ ...win(150), dir: 'send' }, AUDIO_LAG_FOLD_MS)).toMatchObject({ dir: 'send', maxMs: 500, windows: 2 });
    });
});
