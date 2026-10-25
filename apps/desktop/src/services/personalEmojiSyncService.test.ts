import { describe, it, expect } from 'vitest';
import {
    emojiRepublishReason, publishEmojis, pullEmojis, parseEmojiPayload, EMOJI_SNAPSHOT_MAGIC, type EmojiSyncEnv,
} from './personalEmojiSyncService';
import { PersonalEmojis } from '../utils/personalEmoji/service';
import type { StoreIO } from '../utils/personalEmoji/store';
import { personalEmojiIdFromBytes } from '../utils/personalEmoji/token';
import { parseOwnSlotFrame, type SlotView } from '../utils/ownSlotSync';
import { emptyLibrary, type EmojiLibState } from '../utils/personalEmoji/library';
import { OwnEntranceSoundStore } from '../utils/customEntranceSound/ownStore';
import { exportEntranceSound, importEntranceSound } from '../utils/customEntranceSound/transfer';

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 7, 7, 7]);

/** One server-side slot shared by fake devices. wrap/unwrap are an identity
 *  stand-in: the real ones are the e2ee engine's and are exercised elsewhere. */
function makeNet() {
    const slot = { bytes: null as Uint8Array | null, updated: 0 };
    return {
        slot,
        device(id: string, allDevices: string[], opts: { canUnwrap?: boolean } = {}) {
            const kv = new Map<string, string>(), files = new Map<string, Uint8Array>();
            const io: StoreIO = {
                uid: () => 'u', kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, kvRemove: k => { kv.delete(k); },
                readFile: async n => files.get(n) ?? null, writeFile: async (n, b) => { files.set(n, b); }, deleteFile: async n => { files.delete(n); }, now: () => 1000,
            };
            const lib = new PersonalEmojis(io);
            const env: EmojiSyncEnv = {
                getSlotMeta: async () => (slot.bytes ? { backup_id: 'b', updated_at: String(slot.updated) } : null),
                downloadSlot: async () => slot.bytes,
                uploadSlot: async b => { slot.bytes = b; slot.updated++; },
                listOwnDeviceIds: async () => allDevices,
                fetchOwnDevices: async () => allDevices.filter(d => d !== id).map(d => ({ device_id: d, spk_pub_b64: 'k' })),
                wrapToDevices: async (plain, devs) => {
                    const env64 = btoa(JSON.stringify({ recipients: Object.fromEntries(devs.map(d => [d.device_id, 1])), plain }));
                    return env64;
                },
                unwrapFromEnvelope: async e => {
                    if (opts.canUnwrap === false) throw new Error('not addressed');
                    return { contentJson: JSON.parse(atob(e)).plain, senderDeviceId: 'sender' };
                },
                generateContentKeyB64: async () => 'KEY',
                encryptWithKey: async (p) => new TextEncoder().encode(p),
                decryptWithKey: async b => new TextDecoder().decode(b),
                now: () => 5,
                log: () => {},
                loadLocalState: () => lib.load(),
                readBytes: id2 => lib.store.read(id2),
                hasBytes: id2 => lib.store.has(id2),
                writeBytes: (entry, bytes) => lib.store.put(entry.id, bytes, { mime: entry.mime, animated: entry.animated, name: entry.name }),
                applyRemote: r => lib.applyRemote(r),
            };
            return { lib, env, kv, files };
        },
    };
}

describe('personal emoji sync', () => {
    it('A publishes, B pulls: same library, readable bytes, on-disk files B sealed itself', async () => {
        const net = makeNet();
        const A = net.device('A', ['A', 'B']), B = net.device('B', ['A', 'B']);
        await A.lib.add(png(1), 'one');
        await A.lib.add(png(2), 'two');
        const pub = await publishEmojis(A.env, 'A');
        expect(pub.published).toBe(true);
        expect(parseOwnSlotFrame(EMOJI_SNAPSHOT_MAGIC, net.slot.bytes!).header.v).toBe(1);

        const res = await pullEmojis(B.env, null);
        expect(res.applied).toBe(true);
        expect(B.lib.load().entries.map(e => e.name).sort()).toEqual(['one', 'two']);
        const id = await personalEmojiIdFromBytes(png(1));
        expect(await B.lib.store.read(id)).toEqual(png(1));
        // Not A's sealed file: B sealed it under its OWN key.
        expect(B.files.get(`emoji-${id}`)).not.toEqual(A.files.get(`emoji-${id}`));
    });

    it('a deletion on one device reaches the other; pulling the same revision again is free', async () => {
        const net = makeNet();
        const A = net.device('A', ['A', 'B']), B = net.device('B', ['A', 'B']);
        const r = await A.lib.add(png(1), 'one');
        await publishEmojis(A.env, 'A');
        const first = await pullEmojis(B.env, null);
        if (!r.ok) throw new Error();
        B.lib.remove(r.entry.id);
        await publishEmojis(B.env, 'B');
        const second = await pullEmojis(A.env, first.view);
        expect(second.applied).toBe(true);
        expect(A.lib.load().entries).toHaveLength(0);
        const again = await pullEmojis(A.env, second.view);
        expect(again.applied).toBe(false);
    });

    it('an entry whose bytes do not hash to its id is NOT merged (tampered/corrupt slot)', async () => {
        const net = makeNet();
        const A = net.device('A', ['A', 'B']), B = net.device('B', ['A', 'B']);
        await A.lib.add(png(1), 'one');
        await publishEmojis(A.env, 'A');
        // Swap the file bytes inside the (identity-"encrypted") snapshot.
        const { body } = parseOwnSlotFrame(EMOJI_SNAPSHOT_MAGIC, net.slot.bytes!);
        const payload = JSON.parse(new TextDecoder().decode(body));
        const id = Object.keys(payload.files)[0];
        payload.files[id] = btoa(String.fromCharCode(...png(99)));
        const { frameOwnSlot } = await import('../utils/ownSlotSync');
        const header = parseOwnSlotFrame(EMOJI_SNAPSHOT_MAGIC, net.slot.bytes!).header;
        net.slot.bytes = frameOwnSlot(EMOJI_SNAPSHOT_MAGIC, header, new TextEncoder().encode(JSON.stringify(payload)));
        net.slot.updated++;

        const res = await pullEmojis(B.env, null);
        expect(res.incomplete).toEqual([id]);
        expect(B.lib.load().entries).toHaveLength(0);
        expect(B.lib.store.ids()).toEqual([]);
    });

    it('a snapshot this device cannot unwrap is skipped and marked unreadable (never republished over)', async () => {
        const net = makeNet();
        const A = net.device('A', ['A', 'C']), C = net.device('C', ['A', 'C'], { canUnwrap: false });
        await A.lib.add(png(1), 'one');
        await publishEmojis(A.env, 'A');
        const res = await pullEmojis(C.env, null);
        expect(res.applied).toBe(false);
        expect(res.view?.state).toBeNull();
        expect(emojiRepublishReason(res.view, C.lib.load(), ['A', 'C'], 'C')).toBe('none');
    });

    it('a single-device account never publishes (nobody to read it)', async () => {
        const net = makeNet();
        const A = net.device('A', ['A']);
        await A.lib.add(png(1), 'one');
        expect(await publishEmojis(A.env, 'A')).toMatchObject({ published: false });
        expect(net.slot.bytes).toBeNull();
    });

    it('an emoji whose bytes are unreadable is left out of the publish, not published as metadata-only', async () => {
        const net = makeNet();
        const A = net.device('A', ['A', 'B']);
        const r = await A.lib.add(png(1), 'one');
        await A.lib.add(png(2), 'two');
        if (!r.ok) throw new Error();
        A.files.delete(`emoji-${r.entry.id}`);
        const pub = await publishEmojis(A.env, 'A');
        expect(pub.skipped).toEqual([r.entry.id]);
        expect(pub.view?.state?.entries.map(e => e.name)).toEqual(['two']);
    });

    it('republish reasons: empty slot, behind slot, new device, otherwise none', async () => {
        const net = makeNet();
        const A = net.device('A', ['A', 'B']);
        expect(emojiRepublishReason(null, emptyLibrary(), ['A', 'B'], 'A')).toBe('none');
        await A.lib.add(png(1), 'one');
        expect(emojiRepublishReason(null, A.lib.load(), ['A', 'B'], 'A')).toBe('slot-empty');
        await publishEmojis(A.env, 'A');
        const view = (await pullEmojis(A.env, null)).view as SlotView<EmojiLibState>;
        expect(emojiRepublishReason(view, A.lib.load(), ['A', 'B'], 'A')).toBe('none');
        await A.lib.add(png(2), 'two');
        expect(emojiRepublishReason(view, A.lib.load(), ['A', 'B'], 'A')).toBe('slot-behind');
        expect(emojiRepublishReason(view, A.lib.load().entries.length ? { entries: view.state!.entries, tombstones: {} } : emptyLibrary(), ['A', 'B', 'D'], 'A')).toBe('device-missing');
    });

    it('payload parsing drops junk and survives garbage', () => {
        expect(() => parseEmojiPayload('nope')).toThrow();
        const p = parseEmojiPayload(JSON.stringify({ entries: [{ id: 'x' }], tombstones: { y: 1 }, files: { a: 'b', c: 3 } }));
        expect(p.state).toEqual(emptyLibrary());
        expect(p.files).toEqual({ a: 'b' });
    });
});

describe('custom entrance sound rides in the emoji snapshot', () => {
    const webm = (seed: number) => { const b = Uint8Array.from({ length: 900 }, (_, i) => (i * 5 + seed) & 0xff); b.set([0x1a, 0x45, 0xdf, 0xa3]); return b; };
    function withSound(dev: ReturnType<ReturnType<typeof makeNet>['device']>, t: { now: number }) {
        const kv = new Map<string, string>(), files = new Map<string, Uint8Array>();
        const store = new OwnEntranceSoundStore({
            uid: () => 'u', kvGet: () => kv.get('rec') ?? null, kvSet: (_u, v) => { kv.set('rec', v); },
            readFile: async n => files.get(n) ?? null, writeFile: async (n, b) => { files.set(n, b); }, deleteFile: async n => { files.delete(n); },
            now: () => t.now,
        });
        dev.env.exportEntranceSound = () => exportEntranceSound(store);
        dev.env.importEntranceSound = raw => importEntranceSound(store, raw, 'sync');
        return store;
    }

    it('set on A reaches B; a removal follows; a snapshot without the field changes nothing', async () => {
        const net = makeNet();
        const t = { now: 100 };
        const A = net.device('A', ['A', 'B']), B = net.device('B', ['A', 'B']);
        const sa = withSound(A, t), sb = withSound(B, t);
        const id = await sa.set(webm(1), 1500);
        await publishEmojis(A.env, 'A');
        const pulled = await pullEmojis(B.env, null);
        expect(pulled.applied).toBe(true);
        expect(sb.current()?.id).toBe(id);
        expect(await sb.read()).toEqual(webm(1));

        t.now = 200;
        await sa.remove();
        await publishEmojis(A.env, 'A');
        await pullEmojis(B.env, null);
        expect(sb.current()).toBeNull();

        // An older build republishes without `entranceSound`: B keeps what it has.
        t.now = 300;
        const kept = await sb.set(webm(2), 900);
        delete A.env.exportEntranceSound;
        await publishEmojis(A.env, 'A');
        await pullEmojis(B.env, null);
        expect(sb.current()?.id).toBe(kept);
    });

    it('a snapshot whose sound bytes do not match its id is ignored', async () => {
        const net = makeNet();
        const t = { now: 100 };
        const A = net.device('A', ['A', 'B']), B = net.device('B', ['A', 'B']);
        const sb = withSound(B, t);
        A.env.exportEntranceSound = async () => ({ v: 1, id: 'a'.repeat(32), at: 50, durationMs: 1, b64: btoa('not a sound') });
        await publishEmojis(A.env, 'A');
        await pullEmojis(B.env, null);
        expect(sb.current()).toBeNull();
    });
});
