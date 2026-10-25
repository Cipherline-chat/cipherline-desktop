import { describe, it, expect } from 'vitest';
import {
    b64ToBytes, bytesToB64, isAnimatedImage, isPersonalEmojiId, isPersonalEmojiName, personalEmojiIdFromBytes,
    personalEmojiToken, personalTokenSource, personalTokensIn, sniffImageMime, suggestEmojiName,
    validateWireEmoji, validateWirePayload, PERSONAL_EMOJI_MAX_BYTES, PERSONAL_EMOJI_MAX_PER_MESSAGE,
} from './token';
import { applyIncomingDmMessages } from '../dmInbound';
import { parseMentionToken } from '../mentionTokens';
import { resolveEmojiGlyphState } from '../../components/server/emojiGlyphState';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
/** Minimal RIFF/WEBP header (still image). */
const webp = (vp8xFlags?: number) => {
    const b = new Uint8Array(32);
    b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    if (vp8xFlags !== undefined) { b.set([0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0], 12); b[20] = vp8xFlags; }
    else b.set([0x56, 0x50, 0x38, 0x20, 10, 0, 0, 0], 12);
    return b;
};

async function wire(bytes: Uint8Array, over: Record<string, unknown> = {}) {
    return { id: await personalEmojiIdFromBytes(bytes), name: 'pepe', mime: 'image/png', animated: false, bytes_b64: bytesToB64(bytes), ...over };
}

describe('personal emoji ids and names', () => {
    it('id is p_ + 32 hex of the content hash, stable and content-dependent', async () => {
        const a = await personalEmojiIdFromBytes(PNG);
        expect(a).toMatch(/^p_[0-9a-f]{32}$/);
        expect(await personalEmojiIdFromBytes(PNG)).toBe(a);
        expect(await personalEmojiIdFromBytes(new Uint8Array([...PNG, 9]))).not.toBe(a);
    });

    it('server-emoji UUIDs are never personal ids', () => {
        expect(isPersonalEmojiId('3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e')).toBe(false);
        expect(isPersonalEmojiId('p_' + 'a'.repeat(31))).toBe(false);
        expect(isPersonalEmojiId('p_' + 'A'.repeat(32))).toBe(false);
        expect(isPersonalEmojiId('p_' + 'a'.repeat(32))).toBe(true);
    });

    it('names follow the server-emoji grammar', () => {
        expect(isPersonalEmojiName('pe')).toBe(true);
        expect(isPersonalEmojiName('p')).toBe(false);
        expect(isPersonalEmojiName('Pepe')).toBe(false);
        expect(isPersonalEmojiName('a'.repeat(33))).toBe(false);
        expect(isPersonalEmojiName('a:b')).toBe(false);
    });

    it('suggestEmojiName always yields a valid name', () => {
        for (const raw of ['My Cool Pic.PNG', 'x', '', '###', 'a'.repeat(80) + '.gif', 'ünï.webp']) {
            expect(isPersonalEmojiName(suggestEmojiName(raw))).toBe(true);
        }
        expect(suggestEmojiName('My Cool Pic.PNG')).toBe('my_cool_pic');
    });
});

describe('token parsing', () => {
    it('finds personal tokens only, de-duplicated, ignoring server-emoji uuids', () => {
        const id = 'p_' + '0'.repeat(32);
        const text = `hi <:pepe:${id}> and <:pepe:${id}> and <:blob:3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e> <@u:1:bob>`;
        expect(personalTokensIn(text)).toEqual([{ name: 'pepe', id }]);
        expect(personalTokensIn('plain')).toEqual([]);
        expect(personalTokensIn(undefined)).toEqual([]);
    });

    it('a token built here parses back', () => {
        const id = 'p_' + 'ab'.repeat(16);
        expect(personalTokensIn(personalEmojiToken('wow', id))).toEqual([{ name: 'wow', id }]);
    });

    it('selects the field that carries tokens per content type', () => {
        expect(personalTokenSource({ type: 'text', text: 'a' })).toBe('a');
        expect(personalTokenSource({ type: 'edit', text: 'b' })).toBe('b');
        expect(personalTokenSource({ type: 'reaction', emoji: 'c' })).toBe('c');
        expect(personalTokenSource({ type: 'delete' })).toBeNull();
        expect(personalTokenSource(null)).toBeNull();
    });
});

describe('image sniffing', () => {
    it('recognises the four allowed formats and nothing else', () => {
        expect(sniffImageMime(PNG)).toBe('image/png');
        expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
        expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
        expect(sniffImageMime(webp())).toBe('image/webp');
        expect(sniffImageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
        expect(sniffImageMime(new Uint8Array(0))).toBeNull();
    });

    it('detects animation from the container, not from a claim', () => {
        expect(isAnimatedImage(webp(0x12), 'image/webp')).toBe(true);
        expect(isAnimatedImage(webp(0x10), 'image/webp')).toBe(false);
        expect(isAnimatedImage(webp(), 'image/webp')).toBe(false);
        const gif = (n: number) => {
            const b: number[] = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
            for (let i = 0; i < n; i++) b.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0);
            return new Uint8Array(b);
        };
        expect(isAnimatedImage(gif(1), 'image/gif')).toBe(false);
        expect(isAnimatedImage(gif(3), 'image/gif')).toBe(true);
    });
});

describe('validateWireEmoji (untrusted sender)', () => {
    it('accepts a well-formed payload and derives mime/animated from the bytes', async () => {
        const v = await validateWireEmoji(await wire(PNG, { mime: 'text/html', animated: true }));
        expect(v).toMatchObject({ name: 'pepe', mime: 'image/png', animated: false });
        expect('bytes' in v && v.bytes).toEqual(PNG);
    });

    it('rejects bytes that do not hash to the claimed id (cache-poisoning attempt)', async () => {
        const other = await personalEmojiIdFromBytes(new Uint8Array([1, 2, 3]));
        expect(await validateWireEmoji(await wire(PNG, { id: other }))).toEqual({ rejected: 'hash' });
    });

    it('rejects non-images (SVG/HTML) even with a matching hash', async () => {
        const svg = new TextEncoder().encode('<svg onload="alert(1)"/>');
        expect(await validateWireEmoji(await wire(svg))).toEqual({ rejected: 'mime' });
    });

    it('rejects oversize before decoding, bad names and malformed entries', async () => {
        const big = new Uint8Array(PERSONAL_EMOJI_MAX_BYTES + 1); big.set(PNG);
        expect(await validateWireEmoji(await wire(big))).toEqual({ rejected: 'size' });
        expect(await validateWireEmoji(await wire(PNG, { name: 'Bad Name' }))).toEqual({ rejected: 'name' });
        expect(await validateWireEmoji(null)).toEqual({ rejected: 'shape' });
        expect(await validateWireEmoji({ id: 'nope', name: 'pepe', bytes_b64: 'AAAA' })).toEqual({ rejected: 'shape' });
        expect(await validateWireEmoji(await wire(PNG, { bytes_b64: '***' }))).toEqual({ rejected: 'shape' });
    });

    it('payload: drops invalid entries, dedupes, and caps the count', async () => {
        const ok = await Promise.all(Array.from({ length: PERSONAL_EMOJI_MAX_PER_MESSAGE + 3 }, async (_, i) =>
            wire(new Uint8Array([...PNG, i]), { name: `e${i}x` })));
        const out = await validateWirePayload([ok[0], ok[0], { junk: true }, ...ok.slice(1)]);
        expect(out.map(e => e.name)).toEqual(['e0x', 'e1x', 'e2x', 'e3x', 'e4x'].slice(0, out.length));
        expect(out.length).toBeLessThanOrEqual(PERSONAL_EMOJI_MAX_PER_MESSAGE);
        expect(new Set(out.map(e => e.id)).size).toBe(out.length);
        expect(await validateWirePayload('nope')).toEqual([]);
    });

    it('base64 round trip', () => {
        expect(b64ToBytes(bytesToB64(PNG))).toEqual(PNG);
    });
});

describe('old clients (<= 1.0.22) ignore the new field', () => {
    const id = 'p_' + 'c'.repeat(32);

    it('a text message carrying personal_emojis is still an ordinary message row', () => {
        const incoming = {
            c1: [{
                id: 'm1', sender_device_id: 'd2', sender_user_id: 'u2',
                content: { type: 'text', text: `hi <:pepe:${id}>`, personal_emojis: [{ id, name: 'pepe', mime: 'image/webp', animated: false, bytes_b64: 'AAAA' }] },
            }],
        };
        const out = applyIncomingDmMessages({}, incoming as never);
        expect(out.c1).toHaveLength(1);
        expect(out.c1[0].content.type).toBe('text');
    });

    it('the token is unresolvable server-emoji-style: old renderer shows the unavailable glyph labelled with the name', () => {
        const parsed = parseMentionToken(`<:pepe:${id}>`);
        expect(parsed).toMatchObject({ kind: 'emoji', id, label: 'pepe' });
        // No server emoji list entry exists for a p_ id, and no list is loading.
        expect(resolveEmojiGlyphState(undefined, false)).toBe('unavailable');
    });

    it('a reaction carrying personal_emojis applies as a normal reaction', () => {
        const threads = { c1: [{ id: 'm1', sender_device_id: 'd1', content: { type: 'text', text: 'x' } }] };
        const incoming = { c1: [{ id: 'r1', sender_device_id: 'd2', content: { type: 'reaction', target_id: 'm1', emoji: `<:pepe:${id}>`, action: 'add', personal_emojis: [] } }] };
        const out = applyIncomingDmMessages(threads as never, incoming as never);
        expect(out.c1).toHaveLength(1);
        expect(out.c1[0].reactions?.[`<:pepe:${id}>`]).toEqual(['d2']);
    });
});
