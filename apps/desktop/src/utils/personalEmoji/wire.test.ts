import { describe, it, expect } from 'vitest';
import { attachPersonalEmojis, serializeForSend, takePersonalEmojis, type EmojiBytesStore } from './wire';
import { PersonalEmojis } from './service';
import { personalEmojiIdFromBytes, personalEmojiToken, bytesToB64, PERSONAL_EMOJI_MAX_PER_MESSAGE } from './token';
import type { StoreIO } from './store';

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 7, 7]);

function makeStore(uid = 'u1'): PersonalEmojis {
    const kv = new Map<string, string>(), files = new Map<string, Uint8Array>();
    const io: StoreIO = {
        uid: () => uid, kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, kvRemove: k => { kv.delete(k); },
        readFile: async n => files.get(n) ?? null, writeFile: async (n, b) => { files.set(n, b); },
        deleteFile: async n => { files.delete(n); }, now: () => 1,
    };
    return new PersonalEmojis(io);
}
type WithEmojis = Record<string, unknown> & { personal_emojis?: unknown[] };
const asStore = (p: PersonalEmojis): EmojiBytesStore => p.store;

describe('sender → receiver round trip', () => {
    it('text: tokens are backed by bytes on send, validated + stored on receive, field stripped', async () => {
        const sender = makeStore('alice'), receiver = makeStore('bob');
        const bytes = png(1);
        const id = await personalEmojiIdFromBytes(bytes);
        await sender.add(bytes, 'pepe');

        const sent: WithEmojis = await attachPersonalEmojis({ type: 'text', text: `gg ${personalEmojiToken('pepe', id)}` } as WithEmojis, asStore(sender));
        expect(sent.personal_emojis).toHaveLength(1);
        // Through JSON, as on the wire.
        const wire = JSON.parse(JSON.stringify(sent));

        const taken = takePersonalEmojis(wire, asStore(receiver));
        expect('personal_emojis' in taken.content).toBe(false);
        expect(await taken.stored).toEqual([id]);
        expect(await receiver.store.read(id)).toEqual(bytes);
        expect(receiver.load().entries).toHaveLength(0); // cached, NOT added to their library
    });

    it('reaction and edit carry the field too', async () => {
        const sender = makeStore();
        const bytes = png(2);
        const id = await personalEmojiIdFromBytes(bytes);
        await sender.add(bytes, 'wow');
        const tok = personalEmojiToken('wow', id);
        expect((await attachPersonalEmojis({ type: 'reaction', target_id: 'm', emoji: tok, action: 'add' } as WithEmojis, asStore(sender))).personal_emojis).toHaveLength(1);
        expect((await attachPersonalEmojis({ type: 'edit', target_id: 'm', text: `x ${tok}` } as WithEmojis, asStore(sender))).personal_emojis).toHaveLength(1);
    });

    it('nothing to add -> same object back; other content types untouched', async () => {
        const s = makeStore();
        const c1 = { type: 'text', text: 'hello <:blob:3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e>' };
        expect(await attachPersonalEmojis(c1, asStore(s))).toBe(c1);
        const c2 = { type: 'delete', target_id: 'x' };
        expect(await attachPersonalEmojis(c2, asStore(s))).toBe(c2);
        const c3 = { type: 'text', text: 'no tokens' };
        expect(await attachPersonalEmojis(c3, asStore(s))).toBe(c3);
    });

    it('a token whose bytes this device lacks is left unbacked (receiver shows the glyph)', async () => {
        const s = makeStore();
        const c = { type: 'text', text: personalEmojiToken('gone', 'p_' + '1'.repeat(32)) };
        expect(await attachPersonalEmojis(c, asStore(s))).toBe(c);
    });

    it('never sends more than the per-message cap', async () => {
        const s = makeStore();
        let text = '';
        for (let i = 0; i < PERSONAL_EMOJI_MAX_PER_MESSAGE + 3; i++) {
            const b = png(10 + i);
            const id = await personalEmojiIdFromBytes(b);
            await s.add(b, `e${i}x`);
            text += personalEmojiToken(`e${i}x`, id);
        }
        const out = await attachPersonalEmojis({ type: 'text', text } as WithEmojis, asStore(s));
        expect(out.personal_emojis).toHaveLength(PERSONAL_EMOJI_MAX_PER_MESSAGE);
    });

    it('serializeForSend yields the JSON the encryptor gets', async () => {
        const s = makeStore();
        const b = png(3), id = await personalEmojiIdFromBytes(b);
        await s.add(b, 'abc');
        const json = JSON.parse(await serializeForSend({ type: 'text', text: personalEmojiToken('abc', id) }, asStore(s)));
        expect(json.personal_emojis[0]).toMatchObject({ id, name: 'abc', mime: 'image/png', animated: false });
    });
});

describe('receive: the sender is untrusted', () => {
    const entry = async (bytes: Uint8Array, over: Record<string, unknown> = {}) =>
        ({ id: await personalEmojiIdFromBytes(bytes), name: 'pepe', mime: 'image/png', animated: false, bytes_b64: bytesToB64(bytes), ...over });

    it('does not store bytes that do not hash to the id, nor ids the text never references', async () => {
        const r = makeStore();
        const good = png(5), evil = png(6);
        const goodId = await personalEmojiIdFromBytes(good);
        const content = {
            type: 'text', text: `<:a:${goodId}> <:b:p_${'9'.repeat(32)}>`,
            personal_emojis: [
                await entry(evil, { id: goodId }),                       // hash mismatch under a referenced id
                await entry(png(7)),                                       // valid but unreferenced
                { ...(await entry(png(8))), id: 'p_' + '9'.repeat(32) },   // referenced id, wrong bytes
            ],
        };
        const taken = takePersonalEmojis(content, asStore(r));
        expect(await taken.stored).toEqual([]);
        expect(r.store.ids()).toEqual([]);
    });

    it('a poisoned id cannot overwrite an emoji already cached under the real bytes', async () => {
        const r = makeStore();
        const real = png(5), id = await personalEmojiIdFromBytes(real);
        await takePersonalEmojis({ type: 'text', text: `<:a:${id}>`, personal_emojis: [await entry(real)] }, asStore(r)).stored;
        await takePersonalEmojis({ type: 'text', text: `<:a:${id}>`, personal_emojis: [await entry(png(99), { id })] }, asStore(r)).stored;
        expect(await r.store.read(id)).toEqual(real);
    });

    it('content without the field passes through untouched; junk field never throws', async () => {
        const r = makeStore();
        const c = { type: 'text', text: 'x' };
        expect(takePersonalEmojis(c, asStore(r)).content).toBe(c);
        const junk = takePersonalEmojis({ type: 'text', text: '<:a:p_' + '1'.repeat(32) + '>', personal_emojis: 'lol' }, asStore(r));
        expect(await junk.stored).toEqual([]);
        expect('personal_emojis' in junk.content).toBe(false);
        expect(takePersonalEmojis(null, asStore(r)).content).toBeNull();
    });
});
