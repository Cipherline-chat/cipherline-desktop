import { describe, it, expect, beforeAll } from 'vitest';

/**
 * buildBackupPlan used to serialise the whole vault to text, read it back and
 * JSON.parse it before splitting it into records, and then serialise the whole
 * history ONE more time just to fingerprint it — three synchronous passes over
 * every message on the UI thread (measured: ~0.5 s at 20k messages, ~3.7 s at
 * 100k, each pass one uninterrupted task). It now consumes the vault object
 * directly and fingerprints from the per-record hashes it computes anyway.
 *
 * These pin why that is safe: the records (what is actually written, byte for
 * byte) are identical with or without the round trip, and the fingerprint
 * still moves exactly when content does.
 */
beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, electronAPI: undefined });
});

const { splitVaultForRecords, specsFromVault, fingerprintFromSpecs, fingerprintPlan } = await import('./backupRecords');

function vault() {
    return {
        version: 4, userId: 'u1', deviceId: 'd1', topics: [{ id: 'c1' }],
        history: {
            c1: [
                { id: 'm1', content: { type: 'text', text: 'hi' }, timestamp: '2026-01-02T00:00:00.000Z', reactions: undefined },
                { id: 'm2', content: { type: 'attachment', attachment_id: 'a1', byte_size: 10 }, timestamp: '2026-02-02T00:00:00.000Z' },
            ],
        },
        channelHistory: { ch1: [{ id: 'k1', content: { type: 'text', text: 'yo' }, timestamp: '2026-02-03T00:00:00.000Z' }] },
        voiceSettings: undefined,
        gifFavorites: [], gifKeys: {}, gifLedger: {}, avatarKeys: {}, kv: { a: '1' }, appPrefs: {},
    } as unknown as Parameters<typeof splitVaultForRecords>[0];
}

async function recordBytes(v: Parameters<typeof splitVaultForRecords>[0]) {
    const { meta, history, channelHistory } = splitVaultForRecords(v);
    const specs = await specsFromVault({ meta, history, channelHistory, gifIds: ['g1'], attachmentIds: ['a1'] });
    const out: Record<string, string> = {};
    for (const s of specs) {
        const b = await s.load();
        out[s.id] = `${s.hash}:${b ? new TextDecoder().decode(b) : 'blob'}`;
    }
    return { out, specs };
}

describe('backup plan without the vault JSON round trip', () => {
    it('produces byte-identical records and the same fingerprint as the old stringify→parse path', async () => {
        const direct = await recordBytes(vault());
        const roundTripped = await recordBytes(JSON.parse(JSON.stringify(vault())));
        expect(direct.out).toEqual(roundTripped.out);
        expect(await fingerprintFromSpecs(direct.specs)).toBe(await fingerprintFromSpecs(roundTripped.specs));
    });

    it('fingerprint is order-insensitive and moves when any record changes or appears', async () => {
        const { specs } = await recordBytes(vault());
        const fp = await fingerprintFromSpecs(specs);
        expect(await fingerprintFromSpecs([...specs].reverse())).toBe(fp);
        const edited = specs.map(s => (s.id.startsWith('dm:') ? { ...s, hash: '0'.repeat(64) } : s));
        expect(await fingerprintFromSpecs(edited)).not.toBe(fp);
        expect(await fingerprintFromSpecs([...specs, { id: 'att:new', hash: specs[specs.length - 1].hash }])).not.toBe(fp);
    });

    it('fingerprintPlan (vault pieces) agrees with the record-based fingerprint buildBackupPlan uses', async () => {
        const { meta, history, channelHistory } = splitVaultForRecords(vault());
        const specs = await specsFromVault({ meta, history, channelHistory, gifIds: ['g1'], attachmentIds: ['a1'] });
        expect(await fingerprintPlan({ meta, history, channelHistory, gifIds: ['g1'], attachmentIds: ['a1'] }))
            .toBe(await fingerprintFromSpecs(specs));
    });
});
