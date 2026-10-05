import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { BackupVault } from './crypto';

// Real 600k-iteration PBKDF2 in several tests — under full-suite parallel
// load a single call can occasionally exceed vitest's 5s default from CPU
// contention alone. Same fix as driveBackup.test.ts / backupCrypto.test.ts.
vi.setConfig({ testTimeout: 30_000 });

beforeAll(() => {
    const w = window as any;
    w.crypto = globalThis.crypto;
    w.btoa = globalThis.btoa;
    w.atob = globalThis.atob;
});

const {
    sha256Hex, splitVault, buildBackupPlan, reassembleVault,
    deriveNewBackupKey, recoverBackupKey, encryptManifest, encryptChunk, decryptChunk,
    isIncrementalManifest, chunkFilesToKeep,
} = await import('./incrementalBackup');

function makeVault(overrides: Record<string, unknown> = {}): BackupVault {
    return {
        version: 3,
        userId: 'user-1',
        deviceId: 'device-1',
        privateKey: 'priv',
        publicKey: 'pub',
        topics: [{ id: 'conv-a', type: 'dm' }, { id: 'conv-b', type: 'group' }],
        history: {
            'conv-a': [{ id: 'm1', text: 'hi' }],
            'conv-b': [{ id: 'm2', text: 'yo' }],
        },
        channelHistory: {
            'chan-1': [{ id: 'cm1', text: 'channel msg' }],
        },
        gifFiles: {
            'gif-1': 'YmFzZTY0Z2lm',
        },
        attachmentBlobs: {
            'att-1': 'YmFzZTY0YXR0',
        },
        gifFavorites: ['gif-1'],
        pinnedMessages: { 'conv-a': ['m1'] },
        ...overrides,
    } as unknown as BackupVault;
}

describe('sha256Hex', () => {
    it('matches a known SHA-256 test vector', async () => {
        // SHA-256("abc")
        expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('is deterministic for identical input', async () => {
        const a = await sha256Hex('same content');
        const b = await sha256Hex('same content');
        expect(a).toBe(b);
    });

    it('differs for different input', async () => {
        const a = await sha256Hex('content A');
        const b = await sha256Hex('content B');
        expect(a).not.toBe(b);
    });
});

describe('splitVault', () => {
    it('separates the four keyed maps from everything else (meta)', () => {
        const vault = makeVault();
        const { meta, history, channelHistory, gifFiles, attachmentBlobs } = splitVault(vault);
        expect(history).toEqual(vault.history);
        expect(channelHistory).toEqual(vault.channelHistory);
        expect(gifFiles).toEqual(vault.gifFiles);
        expect(attachmentBlobs).toEqual(vault.attachmentBlobs);
        // meta keeps everything else, including settings-like fields.
        expect(meta.userId).toBe('user-1');
        expect(meta.topics).toEqual(vault.topics);
        expect(meta.pinnedMessages).toEqual(vault.pinnedMessages);
        // meta must NOT carry the keyed maps themselves.
        expect(meta).not.toHaveProperty('history');
        expect(meta).not.toHaveProperty('channelHistory');
        expect(meta).not.toHaveProperty('gifFiles');
        expect(meta).not.toHaveProperty('attachmentBlobs');
    });

    it('defaults absent optional maps to empty objects, never undefined', () => {
        const vault = makeVault({ channelHistory: undefined, gifFiles: undefined, attachmentBlobs: undefined });
        const { channelHistory, gifFiles, attachmentBlobs } = splitVault(vault);
        expect(channelHistory).toEqual({});
        expect(gifFiles).toEqual({});
        expect(attachmentBlobs).toEqual({});
    });
});

describe('buildBackupPlan — the core dedup property', () => {
    it('produces one chunk per conversation/channel/gif/attachment plus one meta chunk', async () => {
        const plan = await buildBackupPlan(makeVault());
        const ids = plan.chunks.map(c => c.id).sort();
        expect(ids).toEqual(['att:att-1', 'ch:chan-1', 'dm:conv-a', 'dm:conv-b', 'gif:gif-1', 'meta'].sort());
    });

    // THE property that makes incremental backups work: identical vault
    // content, built twice independently, must produce identical hashes
    // (and therefore identical filenames) for every chunk — so a
    // destination-aware caller can skip re-writing anything unchanged.
    it('produces IDENTICAL chunk hashes for an unchanged vault across two independent builds', async () => {
        const vault = makeVault();
        const planA = await buildBackupPlan(vault);
        const planB = await buildBackupPlan(makeVault()); // fresh object, same content
        const hashesA = Object.fromEntries(planA.chunks.map(c => [c.id, c.hash]));
        const hashesB = Object.fromEntries(planB.chunks.map(c => [c.id, c.hash]));
        expect(hashesB).toEqual(hashesA);
    });

    it('changing ONE conversation only changes that chunk\'s hash — every other chunk is byte-identical', async () => {
        const before = await buildBackupPlan(makeVault());
        const changed = makeVault({
            history: {
                'conv-a': [{ id: 'm1', text: 'hi' }], // unchanged
                'conv-b': [{ id: 'm2', text: 'yo' }, { id: 'm3', text: 'new message' }], // changed
            },
        });
        const after = await buildBackupPlan(changed);

        const hashOf = (plan: typeof before, id: string) => plan.chunks.find(c => c.id === id)!.hash;

        // Changed chunk: different hash.
        expect(hashOf(after, 'dm:conv-b')).not.toBe(hashOf(before, 'dm:conv-b'));
        // Every OTHER chunk: identical hash — nothing else needs rewriting.
        expect(hashOf(after, 'dm:conv-a')).toBe(hashOf(before, 'dm:conv-a'));
        expect(hashOf(after, 'ch:chan-1')).toBe(hashOf(before, 'ch:chan-1'));
        expect(hashOf(after, 'gif:gif-1')).toBe(hashOf(before, 'gif:gif-1'));
        expect(hashOf(after, 'att:att-1')).toBe(hashOf(before, 'att:att-1'));
        expect(hashOf(after, 'meta')).toBe(hashOf(before, 'meta'));
    });

    it('a settings change (e.g. pinnedMessages) only touches the meta chunk', async () => {
        const before = await buildBackupPlan(makeVault());
        const after = await buildBackupPlan(makeVault({ pinnedMessages: { 'conv-a': ['m1', 'm-extra'] } }));
        const hashOf = (plan: typeof before, id: string) => plan.chunks.find(c => c.id === id)!.hash;

        expect(hashOf(after, 'meta')).not.toBe(hashOf(before, 'meta'));
        expect(hashOf(after, 'dm:conv-a')).toBe(hashOf(before, 'dm:conv-a'));
        expect(hashOf(after, 'dm:conv-b')).toBe(hashOf(before, 'dm:conv-b'));
    });

    it('a new attachment adds exactly one new chunk without touching existing ones', async () => {
        const before = await buildBackupPlan(makeVault());
        const after = await buildBackupPlan(makeVault({
            attachmentBlobs: { 'att-1': 'YmFzZTY0YXR0', 'att-2': 'bmV3YXR0YWNobWVudA==' },
        }));
        expect(after.chunks.find(c => c.id === 'att:att-2')).toBeDefined();
        expect(before.chunks.find(c => c.id === 'att:att-2')).toBeUndefined();
        const hashOf = (plan: typeof before, id: string) => plan.chunks.find(c => c.id === id)!.hash;
        expect(hashOf(after, 'att:att-1')).toBe(hashOf(before, 'att:att-1'));
    });

    it('manifest.chunks references match filenames derived from their hashes', async () => {
        const plan = await buildBackupPlan(makeVault());
        for (const ref of plan.manifest.chunks) {
            expect(ref.file).toBe(`chunk-${ref.hash}.enc`);
        }
    });

    it('manifest carries the vault\'s userId', async () => {
        const plan = await buildBackupPlan(makeVault());
        expect(plan.manifest.userId).toBe('user-1');
    });
});

describe('reassembleVault — round trip with buildBackupPlan', () => {
    it('reconstructs an equivalent vault from a plan\'s own chunk JSON', async () => {
        const vault = makeVault();
        const plan = await buildBackupPlan(vault);
        const chunkJsonById = Object.fromEntries(plan.chunks.map(c => [c.id, c.json]));
        const rebuilt = reassembleVault(plan.manifest, chunkJsonById);

        expect(rebuilt.userId).toBe(vault.userId);
        expect(rebuilt.history).toEqual(vault.history);
        expect(rebuilt.channelHistory).toEqual(vault.channelHistory);
        expect(rebuilt.gifFiles).toEqual(vault.gifFiles);
        expect(rebuilt.attachmentBlobs).toEqual(vault.attachmentBlobs);
        expect(rebuilt.pinnedMessages).toEqual(vault.pinnedMessages);
    });

    it('throws if the meta chunk is missing', () => {
        expect(() => reassembleVault({ v: 1, userId: 'u', createdAt: 'now', chunks: [{ id: 'meta', hash: 'h', file: 'chunk-h.enc' }] }, {}))
            .toThrow(/meta/i);
    });

    it('throws if a referenced non-meta chunk is missing', () => {
        const manifest = {
            v: 1, userId: 'u', createdAt: 'now',
            chunks: [
                { id: 'meta', hash: 'h1', file: 'chunk-h1.enc' },
                { id: 'dm:conv-a', hash: 'h2', file: 'chunk-h2.enc' },
            ],
        };
        expect(() => reassembleVault(manifest, { meta: '{}' })).toThrow(/dm:conv-a/);
    });

    it('omits channelHistory/gifFiles/attachmentBlobs entirely when the vault had none of them', async () => {
        const vault = makeVault({ channelHistory: {}, gifFiles: {}, attachmentBlobs: {} });
        const plan = await buildBackupPlan(vault);
        const chunkJsonById = Object.fromEntries(plan.chunks.map(c => [c.id, c.json]));
        const rebuilt = reassembleVault(plan.manifest, chunkJsonById);
        expect(rebuilt).not.toHaveProperty('channelHistory');
        expect(rebuilt).not.toHaveProperty('gifFiles');
        expect(rebuilt).not.toHaveProperty('attachmentBlobs');
    });
});

describe('manifest/chunk encryption — key recovery and the rekey path', () => {
    it('recoverBackupKey succeeds with the correct password and returns the same manifest', async () => {
        const vault = makeVault();
        const plan = await buildBackupPlan(vault);
        const keyMaterial = await deriveNewBackupKey('correct-password');
        const encryptedManifest = await encryptManifest(plan.manifest, keyMaterial);

        const recovered = await recoverBackupKey(encryptedManifest.buffer as ArrayBuffer, 'correct-password');
        expect(recovered).not.toBeNull();
        expect(recovered!.manifest).toEqual(plan.manifest);
    });

    it('recoverBackupKey returns null for the wrong password (does not throw)', async () => {
        const plan = await buildBackupPlan(makeVault());
        const keyMaterial = await deriveNewBackupKey('right-password');
        const encryptedManifest = await encryptManifest(plan.manifest, keyMaterial);

        const recovered = await recoverBackupKey(encryptedManifest.buffer as ArrayBuffer, 'wrong-password');
        expect(recovered).toBeNull();
    });

    it('recoverBackupKey returns null when there is no existing manifest', async () => {
        expect(await recoverBackupKey(null, 'any-password')).toBeNull();
    });

    it('recoverBackupKey returns null for garbage/too-small bytes', async () => {
        const garbage = new Uint8Array([1, 2, 3]).buffer;
        expect(await recoverBackupKey(garbage, 'any-password')).toBeNull();
    });

    it('a recovered key correctly decrypts chunks encrypted under the SAME key material', async () => {
        const plan = await buildBackupPlan(makeVault());
        const keyMaterial = await deriveNewBackupKey('pw');
        const encryptedManifest = await encryptManifest(plan.manifest, keyMaterial);
        const recovered = await recoverBackupKey(encryptedManifest.buffer as ArrayBuffer, 'pw');
        expect(recovered).not.toBeNull();

        const metaChunk = plan.chunks.find(c => c.id === 'meta')!;
        const encryptedChunk = await encryptChunk(metaChunk.json, keyMaterial.key);
        const decrypted = await decryptChunk(encryptedChunk, recovered!.key);
        expect(decrypted).toBe(metaChunk.json);
    });

    it('reusing one derived key to encrypt many chunks never repeats an IV (never silently corrupts AES-GCM safety)', async () => {
        const plan = await buildBackupPlan(makeVault());
        const keyMaterial = await deriveNewBackupKey('pw');
        const encryptedChunks = await Promise.all(plan.chunks.map(c => encryptChunk(c.json, keyMaterial.key)));
        const ivs = encryptedChunks.map(bytes => Buffer.from(bytes.slice(0, 12)).toString('hex'));
        expect(new Set(ivs).size).toBe(ivs.length); // all unique
    });
});

describe('isIncrementalManifest', () => {
    it('recognizes a real manifest', async () => {
        const plan = await buildBackupPlan(makeVault());
        expect(isIncrementalManifest(plan.manifest)).toBe(true);
    });

    it('rejects a legacy full-vault backup (no v/chunks fields)', () => {
        expect(isIncrementalManifest(makeVault())).toBe(false);
    });

    it('rejects null/undefined/non-object input without throwing', () => {
        expect(isIncrementalManifest(null)).toBe(false);
        expect(isIncrementalManifest(undefined)).toBe(false);
        expect(isIncrementalManifest('a string')).toBe(false);
        expect(isIncrementalManifest(42)).toBe(false);
    });

    it('rejects an object with the right version but chunks not an array', () => {
        expect(isIncrementalManifest({ v: 1, chunks: 'nope' })).toBe(false);
    });
});

describe('chunkFilesToKeep — cross-manifest retention (the pruning-safety property)', () => {
    const m = (chunkFiles: string[]): any => ({
        v: 1, userId: 'u', createdAt: 'now',
        chunks: chunkFiles.map(file => ({ id: file, hash: file, file })),
    });

    it('is the union of every retained manifest\'s referenced chunks', () => {
        const kept = chunkFilesToKeep([
            m(['chunk-a.enc', 'chunk-b.enc']),
            m(['chunk-b.enc', 'chunk-c.enc']),
        ]);
        expect(kept).toEqual(new Set(['chunk-a.enc', 'chunk-b.enc', 'chunk-c.enc']));
    });

    // The exact scenario this exists to prevent: a conversation unchanged
    // for several backups is only in OLDER manifests' chunk lists once it's
    // been deleted locally (so the newest manifest no longer references it)
    // — it must still be kept as long as any RETAINED older manifest needs it.
    it('keeps a chunk referenced only by an OLDER retained manifest, not the newest one', () => {
        const newest = m(['chunk-a.enc']); // conversation b was deleted locally since the last run
        const older = m(['chunk-a.enc', 'chunk-b.enc']);
        const kept = chunkFilesToKeep([newest, older]);
        expect(kept.has('chunk-b.enc')).toBe(true);
    });

    it('null entries (legacy full-vault retained backups) contribute nothing and never throw', () => {
        const kept = chunkFilesToKeep([null, m(['chunk-a.enc']), null]);
        expect(kept).toEqual(new Set(['chunk-a.enc']));
    });

    it('an empty retained-manifest list keeps nothing', () => {
        expect(chunkFilesToKeep([])).toEqual(new Set());
    });
});
