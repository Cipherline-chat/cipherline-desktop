import { describe, it, expect } from 'vitest';
import {
    pullLibrary,
    publishLibrary,
    publishLibraryDetailed,
    gifRepublishReason,
    publishableLibrary,
    type GifSyncEnv,
} from './gifLibrarySyncService';
import type { GifEntry, GifLibraryState } from '../utils/gifLibrarySync';
import { frameSnapshot, buildSnapshotPayload, bytesToBase64, GIF_SNAPSHOT_VERSION } from '../utils/gifLibraryTransport';

const gif = (id: string, addedAt = 1_000): GifEntry => ({
    id, source: 'local', fileName: `${id}.enc`, mimeType: 'image/gif', addedAt,
});

const te = new TextEncoder();
const td = new TextDecoder();

/**
 * A fake environment. "Encryption" here is identity framing — the real crypto
 * is exercised by crypto.ts's own suite; what these tests are about is the
 * ordering and failure handling in the service.
 */
function makeEnv(over: Partial<GifSyncEnv> & { local?: GifLibraryState } = {}) {
    const localState: GifLibraryState = over.local ?? { entries: [], ledger: {} };
    const disk = new Map<string, Uint8Array>();
    const keys = new Map<string, string>();
    const slot: { bytes: Uint8Array | null; updated_at: string } = { bytes: null, updated_at: 't1' };
    const saved: GifLibraryState[] = [];
    const deleted: string[] = [];
    const uploaded: Uint8Array[] = [];
    const order: string[] = [];

    const env: GifSyncEnv = {
        fetchOwnDevices: async () => [{ device_id: 'd2', spk_pub_b64: 'SPK' }],
        wrapToDevices: async (pt) => `WRAPPED:${pt}`,
        unwrapFromEnvelope: async (env64) => {
            if (!env64.startsWith('WRAPPED:')) throw new Error('not addressed to this device');
            return env64.slice('WRAPPED:'.length);
        },
        generateContentKeyB64: async () => 'CK',
        encryptWithKey: async (pt) => te.encode(pt),
        decryptWithKey: async (bytes) => td.decode(bytes),
        readGifBytes: async (id) => disk.get(id) ?? null,
        writeGifBytes: async (id, b) => { order.push(`write:${id}`); disk.set(id, b); },
        deleteGifBytes: async (id) => { order.push(`delete:${id}`); deleted.push(id); disk.delete(id); },
        getGifKeyB64: (id) => keys.get(id) ?? null,
        putGifKeyB64: (id, k) => { keys.set(id, k); },
        getSlotMeta: async () => (slot.bytes ? { backup_id: 'b1', updated_at: slot.updated_at } : null),
        downloadSlot: async () => slot.bytes,
        uploadSlot: async (b) => { uploaded.push(b); slot.bytes = b; },
        loadLocalState: () => saved.length ? saved[saved.length - 1] : localState,
        saveLocalState: (s) => { order.push('save'); saved.push(s); },
        now: () => 5_000,
        log: () => { },
        ...over,
    };
    return { env, disk, keys, slot, saved, deleted, uploaded, order };
}

/** Build a remote snapshot the fake env can decrypt. */
function remoteSnapshot(
    entries: GifEntry[],
    ledger: Record<string, number>,
    opts: { omitBytesFor?: string[]; omitKeyFor?: string[] } = {},
): Uint8Array {
    const k: Record<string, string> = {};
    const f: Record<string, string> = {};
    for (const e of entries) {
        if (!opts.omitKeyFor?.includes(e.id)) k[e.id] = `KEY-${e.id}`;
        if (!opts.omitBytesFor?.includes(e.id)) f[e.id] = bytesToBase64(te.encode(`BYTES-${e.id}`));
    }
    const payload = buildSnapshotPayload(entries, ledger, k, f, 1);
    return frameSnapshot(
        { v: GIF_SNAPSHOT_VERSION, key_envelope_b64: `WRAPPED:${JSON.stringify({ k: 'CK' })}` },
        te.encode(JSON.stringify(payload)),
    );
}

describe('pullLibrary', () => {
    it('does nothing when the slot has never been written', async () => {
        const { env } = makeEnv();
        const res = await pullLibrary(env);
        expect(res.applied).toBe(false);
        expect(res.seen).toBeNull();
    });

    it('reports the revision it actually read, so the caller can persist it', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 });
        t.slot.updated_at = 'rev-7';

        const res = await pullLibrary(t.env);

        expect(res.applied).toBe(true);
        expect(res.seen).toBe('rev-7');
    });

    it('reports the revision even when it short-circuits as unchanged', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 });
        t.slot.updated_at = 'rev-9';
        expect((await pullLibrary(t.env, 'rev-9')).seen).toBe('rev-9');
    });

    it('does nothing when updated_at matches what we already applied', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 });
        const res = await pullLibrary(t.env, 't1');
        expect(res.applied).toBe(false);
        expect(t.saved).toHaveLength(0);
    });

    it('materialises a new GIF: bytes and key land, metadata merges', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 });

        const res = await pullLibrary(t.env);

        expect(res.applied).toBe(true);
        expect(res.state.entries.map(e => e.id)).toEqual(['a']);
        expect(td.decode(t.disk.get('a')!)).toBe('BYTES-a');
        expect(t.keys.get('a')).toBe('KEY-a');
        expect(res.diff.added.map(e => e.id)).toEqual(['a']);
    });

    it('writes bytes BEFORE persisting metadata', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 });
        await pullLibrary(t.env);
        expect(t.order.indexOf('write:a')).toBeLessThan(t.order.indexOf('save'));
    });

    it('drops an entry whose bytes never arrived rather than showing a broken tile', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a'), gif('b')], { a: 1, b: 1 }, { omitBytesFor: ['b'] });

        const res = await pullLibrary(t.env);

        expect(res.state.entries.map(e => e.id)).toEqual(['a']);
        expect(res.incomplete).toEqual(['b']);
        expect(t.disk.has('b')).toBe(false);
    });

    it('drops an entry whose key never arrived', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 }, { omitKeyFor: ['a'] });
        const res = await pullLibrary(t.env);
        expect(res.incomplete).toEqual(['a']);
        expect(res.state.entries).toEqual([]);
    });

    it('a failed download does NOT become a tombstone that deletes the GIF elsewhere', async () => {
        // Regression: an id we could not materialise used to keep its ledger
        // timestamp with no entry behind it — which reads as "deleted", so the
        // next publish would propagate a bogus deletion to every other device.
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 }, { omitBytesFor: ['a'] });

        const res = await pullLibrary(t.env);

        expect(res.incomplete).toEqual(['a']);
        expect(res.state.ledger.a).toBeUndefined();
    });

    it('still applies a genuine remote tombstone alongside a failed download', async () => {
        const t = makeEnv({ local: { entries: [gif('old', 1)], ledger: { old: 1 } } });
        t.disk.set('old', te.encode('BYTES-old'));
        // 'new' is listed but its bytes are missing; 'old' is a real tombstone.
        t.slot.bytes = remoteSnapshot([gif('new')], { new: 5, old: 99 }, { omitBytesFor: ['new'] });

        const res = await pullLibrary(t.env);

        expect(res.state.entries).toEqual([]);      // 'old' really was deleted
        expect(res.state.ledger.old).toBe(99);
        expect(res.state.ledger.new).toBeUndefined();
    });

    it('excludes a GIF whose write threw, and keeps the rest', async () => {
        const t = makeEnv({
            writeGifBytes: async (id: string) => { if (id === 'b') throw new Error('disk full'); },
        });
        t.slot.bytes = remoteSnapshot([gif('a'), gif('b')], { a: 1, b: 1 });

        const res = await pullLibrary(t.env);

        expect(res.state.entries.map(e => e.id)).toEqual(['a']);
        expect(res.incomplete).toEqual(['b']);
    });

    it('applies a remote deletion and removes the local bytes after saving', async () => {
        const t = makeEnv({ local: { entries: [gif('a')], ledger: { a: 1 } } });
        t.disk.set('a', te.encode('BYTES-a'));
        t.slot.bytes = remoteSnapshot([], { a: 99 });

        const res = await pullLibrary(t.env);

        expect(res.state.entries).toEqual([]);
        expect(t.deleted).toEqual(['a']);
        expect(t.order.indexOf('save')).toBeLessThan(t.order.indexOf('delete:a'));
    });

    it('skips quietly when the snapshot is not addressed to this device', async () => {
        const t = makeEnv({ unwrapFromEnvelope: async () => { throw new Error('not addressed'); } });
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 });

        const res = await pullLibrary(t.env);

        expect(res.applied).toBe(false);
        expect(t.saved).toHaveLength(0);
    });

    it('is idempotent — pulling the same snapshot twice changes nothing the second time', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 });

        expect((await pullLibrary(t.env)).applied).toBe(true);
        expect((await pullLibrary(t.env)).applied).toBe(false);
        expect(t.saved).toHaveLength(1);
    });

    it('does not delete a local GIF the remote has simply never seen', async () => {
        const t = makeEnv({ local: { entries: [gif('mine', 100)], ledger: { mine: 100 } } });
        t.disk.set('mine', te.encode('BYTES-mine'));
        t.slot.bytes = remoteSnapshot([gif('theirs', 200)], { theirs: 200 });

        const res = await pullLibrary(t.env);

        expect(res.state.entries.map(e => e.id).sort()).toEqual(['mine', 'theirs']);
        expect(t.deleted).toEqual([]);
    });
});

describe('publishLibrary', () => {
    it('refuses to publish when the account has no other devices', async () => {
        const t = makeEnv({ fetchOwnDevices: async () => [] });
        expect(await publishLibrary(t.env)).toBe(false);
        expect(t.uploaded).toHaveLength(0);
    });

    it('uploads a snapshot carrying entries, bytes and keys', async () => {
        const t = makeEnv({ local: { entries: [gif('a')], ledger: { a: 1 } } });
        t.disk.set('a', te.encode('BYTES-a'));
        t.keys.set('a', 'KEY-a');

        expect(await publishLibrary(t.env)).toBe(true);
        expect(t.uploaded).toHaveLength(1);

        // The uploaded blob must be a valid frame whose body decodes back.
        const { parseSnapshotFrame, parseSnapshotPayload } = await import('../utils/gifLibraryTransport');
        const { header, body } = parseSnapshotFrame(t.uploaded[0]);
        expect(header.key_envelope_b64).toContain('CK');
        const payload = parseSnapshotPayload(td.decode(body));
        expect(payload.entries.map(e => e.id)).toEqual(['a']);
        expect(payload.keys.a).toBe('KEY-a');
        expect(payload.ledger).toEqual({ a: 1 });
    });

    it('omits a GIF whose key is missing, but still publishes the rest', async () => {
        const t = makeEnv({ local: { entries: [gif('a'), gif('b')], ledger: { a: 1, b: 1 } } });
        t.disk.set('a', te.encode('A')); t.keys.set('a', 'KEY-a');
        t.disk.set('b', te.encode('B')); // no key for b

        await publishLibrary(t.env);

        const { parseSnapshotFrame, parseSnapshotPayload } = await import('../utils/gifLibraryTransport');
        const { body } = parseSnapshotFrame(t.uploaded[0]);
        const payload = parseSnapshotPayload(td.decode(body));
        expect(payload.entries.map(e => e.id)).toEqual(['a']);
    });

    it('omits a GIF whose bytes are gone from disk', async () => {
        const t = makeEnv({ local: { entries: [gif('a')], ledger: { a: 1 } } });
        t.keys.set('a', 'KEY-a'); // key present, file missing

        await publishLibrary(t.env);

        const { parseSnapshotFrame, parseSnapshotPayload } = await import('../utils/gifLibraryTransport');
        const { body } = parseSnapshotFrame(t.uploaded[0]);
        expect(parseSnapshotPayload(td.decode(body)).entries).toEqual([]);
    });

    it('still publishes tombstones for GIFs that carry no bytes', async () => {
        const t = makeEnv({ local: { entries: [], ledger: { gone: 42 } } });

        await publishLibrary(t.env);

        const { parseSnapshotFrame, parseSnapshotPayload } = await import('../utils/gifLibraryTransport');
        const { body } = parseSnapshotFrame(t.uploaded[0]);
        expect(parseSnapshotPayload(td.decode(body)).ledger).toEqual({ gone: 42 });
    });

    it('round-trips publish → pull between two devices', async () => {
        const a = makeEnv({ local: { entries: [gif('x')], ledger: { x: 7 } } });
        a.disk.set('x', te.encode('BYTES-x'));
        a.keys.set('x', 'KEY-x');
        await publishLibrary(a.env);

        const b = makeEnv();
        b.slot.bytes = a.uploaded[0];

        const res = await pullLibrary(b.env);
        expect(res.state.entries.map(e => e.id)).toEqual(['x']);
        expect(td.decode(b.disk.get('x')!)).toBe('BYTES-x');
        expect(b.keys.get('x')).toBe('KEY-x');
    });
});

/**
 * Own-device sync additions (docs/OWN-DEVICE-SYNC.md in cipherline-mobile):
 * the Klipy gate, id safety, sender-aware unwrap and the anti-entropy view.
 */
describe('GIF sync — what may travel', () => {
    const klipy = (id: string, addedAt = 1_000): GifEntry => ({ ...gif(id, addedAt), source: 'klipy' as GifEntry['source'] });

    it('never publishes a Klipy-sourced GIF (bytes, key, entry or ledger) while the gate is off', async () => {
        const t = makeEnv({ local: { entries: [gif('mine'), klipy('k1')], ledger: { mine: 1, k1: 2 } } });
        for (const id of ['mine', 'k1']) { t.disk.set(id, te.encode(`BYTES-${id}`)); t.keys.set(id, `KEY-${id}`); }

        await publishLibrary(t.env);

        const { parseSnapshotFrame, parseSnapshotPayload } = await import('../utils/gifLibraryTransport');
        const p = parseSnapshotPayload(td.decode(parseSnapshotFrame(t.uploaded[0]).body));
        expect(p.entries.map(e => e.id)).toEqual(['mine']);
        expect(Object.keys(p.files)).toEqual(['mine']);
        expect(Object.keys(p.keys)).toEqual(['mine']);
        // No ledger timestamp either: an id with a timestamp and no entry is a
        // tombstone, which would delete the Klipy GIF on every other device.
        expect(p.ledger).toEqual({ mine: 1 });
    });

    it('does not materialise a Klipy-sourced GIF another device published, nor treat it as a deletion', async () => {
        const t = makeEnv({ local: { entries: [], ledger: {} } });
        t.slot.bytes = remoteSnapshot([gif('ok'), klipy('k1')], { ok: 1, k1: 2 });

        const res = await pullLibrary(t.env);

        expect(res.state.entries.map(e => e.id)).toEqual(['ok']);
        expect(t.disk.has('k1')).toBe(false);
        expect(res.state.ledger.k1).toBeUndefined();
        expect(res.view?.state?.entries.map(e => e.id)).toEqual(['ok']);
    });

    it('refuses an id that is not safe as a file name', async () => {
        const t = makeEnv();
        t.slot.bytes = remoteSnapshot([gif('../../evil')], { '../../evil': 1 });
        const res = await pullLibrary(t.env);
        expect(res.state.entries).toEqual([]);
        expect(t.disk.size).toBe(0);
    });

    it('publishableLibrary also leaves out GIFs a previous publish could not read', () => {
        const s = { entries: [gif('a'), gif('b')], ledger: { a: 1, b: 2 } };
        expect(publishableLibrary(s, new Set(['b'])).entries.map(e => e.id)).toEqual(['a']);
    });
});

describe('GIF sync — sender and anti-entropy view', () => {
    it('records the publisher an unwrap reports, and the slot state as published', async () => {
        const t = makeEnv({
            unwrapFromEnvelope: async (e: string) => ({ contentJson: e.slice('WRAPPED:'.length), senderDeviceId: 'laptop' }),
        });
        t.slot.bytes = remoteSnapshot([gif('a')], { a: 1 });
        const res = await pullLibrary(t.env);
        expect(res.view).toMatchObject({ publisher: 'laptop', state: { entries: [gif('a')], ledger: { a: 1 } } });
    });

    it('a snapshot that fails the sender check is not merged, and its view is unreadable', async () => {
        const t = makeEnv({ unwrapFromEnvelope: async () => { throw new Error('foreign'); } });
        t.slot.bytes = remoteSnapshot([gif('planted')], { planted: 9 });
        const res = await pullLibrary(t.env);
        expect(res.applied).toBe(false);
        expect(t.saved).toHaveLength(0);
        expect(res.view).toMatchObject({ state: null });
    });

    it('an empty slot yields a null view (so a device with a library publishes first)', async () => {
        const t = makeEnv();
        expect((await pullLibrary(t.env)).view).toBeNull();
        expect(gifRepublishReason(null, { entries: [gif('a')], ledger: { a: 1 } }, null, 'me')).toBe('slot-empty');
    });

    it('a new phone next to this desktop makes it republish; an up-to-date slot does not', () => {
        const view = { updatedAt: 'r', recipients: ['d2'], publisher: 'me', state: { entries: [gif('a')], ledger: { a: 1 } } };
        const local = { entries: [gif('a')], ledger: { a: 1 } };
        expect(gifRepublishReason(view, local, ['me', 'd2'], 'me')).toBe('none');
        expect(gifRepublishReason(view, local, ['me', 'd2', 'phone'], 'me')).toBe('device-missing');
    });

    it('cosmetic differences (label) and a missing ledger entry (addedAt fallback) are NOT "behind"', () => {
        const view = { updatedAt: 'r', recipients: ['d2'], publisher: 'd2', state: { entries: [{ ...gif('a', 500) }], ledger: {} } };
        const local = { entries: [{ ...gif('a', 500), label: 'party' }], ledger: { a: 500 } };
        expect(gifRepublishReason(view, local, null, 'me')).toBe('none');
    });

    it('a local GIF the slot lacks IS "behind"', () => {
        const view = { updatedAt: 'r', recipients: ['d2'], publisher: 'd2', state: { entries: [], ledger: {} } };
        expect(gifRepublishReason(view, { entries: [gif('a')], ledger: { a: 1 } }, null, 'me')).toBe('slot-behind');
    });

    it('publishLibraryDetailed skips a single-device account without claiming prekeys', async () => {
        let claimed = false;
        const t = makeEnv({
            local: { entries: [gif('a')], ledger: { a: 1 } },
            listOwnDeviceIds: async () => ['me'],
            fetchOwnDevices: async () => { claimed = true; return [{ device_id: 'd2', spk_pub_b64: 'SPK' }]; },
        });
        const res = await publishLibraryDetailed(t.env, 'me');
        expect(res.published).toBe(false);
        expect(claimed).toBe(false);
        expect(t.uploaded).toHaveLength(0);
    });

    it('publishLibraryDetailed returns the view it just created, and what it had to skip', async () => {
        const t = makeEnv({ local: { entries: [gif('a'), gif('b')], ledger: { a: 1, b: 2 } } });
        t.disk.set('a', te.encode('A')); t.keys.set('a', 'KA');   // 'b' has no bytes
        const res = await publishLibraryDetailed(t.env, 'me');
        expect(res.published).toBe(true);
        expect(res.skipped).toEqual(['b']);
        expect(res.view).toMatchObject({ publisher: 'me', state: { entries: [gif('a')] } });
    });
});

/**
 * KLIPY favorites are REFERENCES (slug + one rendition), never media. KLIPY's
 * terms allow storing the reference and forbid storing their files, so a
 * reference may sync between the user's devices as metadata — with no bytes,
 * no key, and nothing written to disk on the receiving device.
 */
describe('GIF sync — KLIPY references travel as metadata only', () => {
    const REF = {
        slug: 'happy-KLx9',
        media: { url: 'https://static.klipy.com/ii/a/b.webp', width: 200, height: 150, mime: 'image/webp' as const },
        title: 'Happy',
    };
    const klipyRef = (id: string, addedAt = 1_000, ref: unknown = REF): GifEntry =>
        ({ id, source: 'klipy', fileName: 'klipy-ref', mimeType: 'image/webp', addedAt, klipy: ref } as GifEntry);

    it('publishes a reference with no key and no bytes, next to a local GIF with both', async () => {
        const t = makeEnv({ local: { entries: [gif('mine'), klipyRef('r1')], ledger: { mine: 1, r1: 2 } } });
        t.disk.set('mine', te.encode('BYTES-mine')); t.keys.set('mine', 'KEY-mine');

        const res = await publishLibraryDetailed(t.env);

        const { parseSnapshotFrame, parseSnapshotPayload } = await import('../utils/gifLibraryTransport');
        const p = parseSnapshotPayload(td.decode(parseSnapshotFrame(t.uploaded[0]).body));
        expect(p.entries.map(e => e.id).sort()).toEqual(['mine', 'r1']);
        expect(Object.keys(p.files)).toEqual(['mine']);
        expect(Object.keys(p.keys)).toEqual(['mine']);
        expect(p.ledger).toEqual({ mine: 1, r1: 2 });
        expect(p.entries.find(e => e.id === 'r1')?.klipy).toEqual(REF);
        expect(res.skipped).toEqual([]);
    });

    it('pulls a reference without writing anything to disk or storing a key', async () => {
        const t = makeEnv({ local: { entries: [], ledger: {} } });
        // A reference must be accepted even though the snapshot carries no
        // bytes/key for it (a local GIF in that state would be "incomplete").
        t.slot.bytes = remoteSnapshot([gif('ok'), klipyRef('r1')], { ok: 1, r1: 2 }, { omitBytesFor: ['r1'], omitKeyFor: ['r1'] });

        const res = await pullLibrary(t.env);

        expect(res.state.entries.map(e => e.id).sort()).toEqual(['ok', 'r1']);
        expect(res.incomplete).toEqual([]);
        expect(t.disk.has('r1')).toBe(false);
        expect(t.keys.has('r1')).toBe(false);
        expect([...t.disk.keys()]).toEqual(['ok']);
    });

    it('refuses a "reference" whose URL is not on the KLIPY allowlist — and does not treat it as a deletion', async () => {
        const t = makeEnv({ local: { entries: [], ledger: {} } });
        const evil = klipyRef('r2', 1_000, { ...REF, media: { ...REF.media, url: 'https://tracker.example/p.gif' } });
        t.slot.bytes = remoteSnapshot([gif('ok'), evil], { ok: 1, r2: 2 }, { omitBytesFor: ['r2'], omitKeyFor: ['r2'] });

        const res = await pullLibrary(t.env);

        expect(res.state.entries.map(e => e.id)).toEqual(['ok']);
        expect(res.state.ledger.r2).toBeUndefined();
    });

    it('still refuses a KLIPY byte COPY (the never-shipped proxy design) on publish', async () => {
        const copy = { ...gif('c1'), source: 'klipy' } as GifEntry;
        const t = makeEnv({ local: { entries: [gif('mine'), copy], ledger: { mine: 1, c1: 2 } } });
        for (const id of ['mine', 'c1']) { t.disk.set(id, te.encode(`BYTES-${id}`)); t.keys.set(id, `KEY-${id}`); }
        await publishLibrary(t.env);
        const { parseSnapshotFrame, parseSnapshotPayload } = await import('../utils/gifLibraryTransport');
        const p = parseSnapshotPayload(td.decode(parseSnapshotFrame(t.uploaded[0]).body));
        expect(p.entries.map(e => e.id)).toEqual(['mine']);
        expect(Object.keys(p.files)).toEqual(['mine']);
    });

    it('a reference is part of the anti-entropy shape (the slot is not "perpetually behind")', () => {
        const s = { entries: [gif('a'), klipyRef('r1')], ledger: { a: 1, r1: 2 } };
        expect(publishableLibrary(s).entries.map(e => e.id).sort()).toEqual(['a', 'r1']);
    });
});
