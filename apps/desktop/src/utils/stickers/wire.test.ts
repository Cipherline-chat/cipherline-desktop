import { describe, it, expect, vi } from 'vitest';
// axios cannot load in this node test env (reportEmoji imports it); nothing here sends.
vi.mock('axios', () => ({ default: {} }));
import { stickerPayloadProblem, STICKER_MAX_BYTES } from '@cipherline/shared';
import {
    attachStickerBytes, buildStickerContent, stickerPreviewText, stickerRefOf, stickerReportText, takeSticker,
} from './wire';
import { PersonalEmojis, STICKER_LIBRARY_PROFILE } from '../personalEmoji/service';
import { serializeForSend } from '../personalEmoji/wire';
import { bytesToB64, personalEmojiIdFromBytes } from '../personalEmoji/token';
import { frankBody } from '../franking';
import { reportableEmojiTokens } from '../reportEmoji';
import { isEditableOwnMessage } from '../editLastMessage';
import { replyQuoteLine } from '../replyQuoteLine';
import type { StoreIO } from '../personalEmoji/store';


const png = (n: number, pad = 0) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 7, 7, ...new Array(pad).fill(1)]);
const SID = '11111111-2222-4333-8444-555555555555';
const SERVER = '99999999-2222-4333-8444-555555555555';

function makeLib(uid = 'u1'): PersonalEmojis {
    const kv = new Map<string, string>(), files = new Map<string, Uint8Array>();
    const io: StoreIO = {
        uid: () => uid, kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, kvRemove: k => { kv.delete(k); },
        readFile: async n => files.get(n) ?? null, writeFile: async (n, b) => { files.set(n, b); },
        deleteFile: async n => { files.delete(n); }, now: () => 1,
    };
    return new PersonalEmojis(io, STICKER_LIBRARY_PROFILE);
}

describe('sticker content shape (old clients see the fallback text)', () => {
    it('a sticker is a TEXT message whose text is "[Sticker: name]"', () => {
        const c = buildStickerContent({ source: 'server', id: SID, name: 'wave', server_id: SERVER });
        expect(c).toEqual({ type: 'text', text: '[Sticker: wave]', sticker: { source: 'server', id: SID, name: 'wave', server_id: SERVER } });
        expect(stickerPayloadProblem(c.sticker)).toBeNull();
        expect(buildStickerContent({ source: 'server', id: SID, name: 'wave', server_id: SERVER }, 'm-1').reply_to_id).toBe('m-1');
    });

    it('stickerRefOf accepts only well-formed refs on text messages', () => {
        expect(stickerRefOf({ type: 'text', text: 'x', sticker: { source: 'server', id: SID, name: 'wave', server_id: SERVER } })).toMatchObject({ source: 'server' });
        expect(stickerRefOf({ type: 'text', text: 'x', sticker: { source: 'server', id: 'nope', name: 'wave', server_id: SERVER } })).toBeNull();
        expect(stickerRefOf({ type: 'text', text: 'x', sticker: { source: 'personal', id: 'p_' + 'a'.repeat(32), name: 'Bad Name' } })).toBeNull();
        expect(stickerRefOf({ type: 'edit', text: 'x', sticker: { source: 'server', id: SID, name: 'wave', server_id: SERVER } })).toBeNull();
        expect(stickerRefOf({ type: 'text', text: 'plain' })).toBeNull();
        expect(stickerRefOf(null)).toBeNull();
    });
});

describe('personal sticker send -> receive round trip', () => {
    it('bytes are added at send, verified + stored on receive, stripped from the stored content', async () => {
        const sender = makeLib('alice'), receiver = makeLib('bob');
        const bytes = png(1, 2000);
        const res = await sender.add(bytes, 'party');
        expect(res.ok).toBe(true);
        const id = await personalEmojiIdFromBytes(bytes);
        const content = buildStickerContent({ source: 'personal', id, name: 'party', mime: 'image/png', animated: false });
        expect((content.sticker as { bytes_b64?: string }).bytes_b64).toBeUndefined(); // optimistic copy: no bytes

        const wire = JSON.parse(await serializeForSend(content, sender.store));
        expect(wire.sticker.bytes_b64).toBe(bytesToB64(bytes));
        expect(stickerPayloadProblem(wire.sticker)).toBeNull();

        const taken = takeSticker(wire, receiver.store);
        expect((taken.content as { sticker: Record<string, unknown> }).sticker.bytes_b64).toBeUndefined();
        expect(await taken.stored).toBe(true);
        expect(await receiver.store.read(id)).toEqual(bytes);
        expect(receiver.load().entries).toHaveLength(0); // cached, not added to their library
    });

    it('bytes that do not hash to the id are never stored', async () => {
        const receiver = makeLib();
        const wire = { type: 'text', text: '[Sticker: x_x]', sticker: { source: 'personal', id: 'p_' + '0'.repeat(32), name: 'x_x', mime: 'image/png', animated: false, bytes_b64: bytesToB64(png(3)) } };
        const taken = takeSticker(wire, receiver.store);
        expect(await taken.stored).toBe(false);
        expect(receiver.store.has('p_' + '0'.repeat(32))).toBe(false);
    });

    it('a malformed sticker is dropped: the row shows the fallback text', () => {
        const receiver = makeLib();
        const wire = { type: 'text', text: '[Sticker: wave]', sticker: { source: 'server', id: SID, name: 'wave' } }; // no server_id
        const taken = takeSticker(wire, receiver.store);
        expect(taken.content).toEqual({ type: 'text', text: '[Sticker: wave]' });
    });

    it('a sticker field on a non-text type is dropped', () => {
        const taken = takeSticker({ type: 'attachment', sticker: { source: 'server', id: SID, name: 'wave', server_id: SERVER } }, makeLib().store);
        expect('sticker' in (taken.content as object)).toBe(false);
    });

    it('oversize bytes are refused structurally before decoding', () => {
        const big = 'A'.repeat(Math.ceil(STICKER_MAX_BYTES / 3) * 4 + 8);
        expect(stickerPayloadProblem({ source: 'personal', id: 'p_' + 'a'.repeat(32), name: 'big', mime: 'image/png', bytes_b64: big })).toMatch(/too large/);
    });

    it('a personal sticker whose bytes are gone is sent as fallback text only', async () => {
        const sender = makeLib();
        const content = buildStickerContent({ source: 'personal', id: 'p_' + 'b'.repeat(32), name: 'gone' });
        const out = await attachStickerBytes(content, sender.store);
        expect(out).toEqual({ type: 'text', text: '[Sticker: gone]' });
    });

    it('a server sticker carries no bytes on the wire', async () => {
        const sender = makeLib();
        const content = buildStickerContent({ source: 'server', id: SID, name: 'wave', server_id: SERVER });
        expect(JSON.parse(await serializeForSend(content, sender.store))).toEqual(content);
    });
});

describe('franking, reports, edits, previews', () => {
    const c = buildStickerContent({ source: 'server', id: SID, name: 'wave', server_id: SERVER });

    it('the franked body binds the sticker id as an emoji-style token', () => {
        expect(stickerReportText(c)).toBe(`[Sticker: wave]\n<:wave:${SID}>`);
        expect(frankBody(c)).toEqual({ kind: 'text', body: `[Sticker: wave]\n<:wave:${SID}>` });
        // A plain text message is unchanged.
        expect(frankBody({ type: 'text', text: 'hi' })).toEqual({ kind: 'text', body: 'hi' });
    });

    it('the report pipeline sees the sticker as a server emoji token (API copies its image)', () => {
        const text = stickerReportText(c)!;
        expect(reportableEmojiTokens(text, text)).toEqual([{ name: 'wave', id: SID, source: 'server' }]);
        const p = buildStickerContent({ source: 'personal', id: 'p_' + 'c'.repeat(32), name: 'mine' });
        const pt = stickerReportText(p)!;
        expect(reportableEmojiTokens(pt, pt)).toEqual([{ name: 'mine', id: 'p_' + 'c'.repeat(32), source: 'personal' }]);
    });

    it('a sticker message is never editable (Up-arrow / menu)', () => {
        expect(isEditableOwnMessage({ id: 'm', content: c, sender_user_id: 'me' }, { myUserId: 'me', myDeviceIds: new Set() } as never)).toBe(false);
        expect(isEditableOwnMessage({ id: 'm', content: { type: 'text', text: 'x' }, sender_user_id: 'me' }, { myUserId: 'me', myDeviceIds: new Set() } as never)).toBe(true);
    });

    it('reply quotes and previews name the sticker', () => {
        expect(stickerPreviewText(c)).toBe('Sticker: wave');
        expect(replyQuoteLine(c, () => 'unused')).toBe('Sticker: wave');
    });
});
