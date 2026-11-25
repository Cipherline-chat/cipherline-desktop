/**
 * The sender's copy of expiring linked media (mediaCopy.ts, the contract's
 * `media.file`, the send / late-attach plumbing), 2026-11-24.
 */
import { describe, it, expect, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import {
    LINK_EMBED_MEDIA_COPY_MAX_BYTES, linkEmbedAttachmentIds, linkEmbedsReportText, sanitizeLinkEmbed, sanitizeLinkEmbeds, type LinkEmbed,
} from '@cipherline/shared';
import { copyMatchesMime, isCopyPending, markCopyPending, mediaCopyMaxBytes, setMediaCopyUploadLimit, sniffMediaMime, uploadOnce } from './mediaCopy';
import { isSameSite, siteOf } from './sameSite';
import { finalizeEmbeds, takeAndFinalize, type PreparedEmbed } from './prepare';
import { improvesOn, runLateAttach } from './lateAttach';

const blob = (n: number, type = 'image/gif') => new NodeBlob([new Uint8Array(n).fill(1)], { type }) as unknown as Blob;
const FILE = { attachment_id: '11111111-2222-4333-8444-555555555555', file_key_b64: `${'A'.repeat(43)}=`, file_nonce_b64: 'B'.repeat(16), byte_size: 1000 };
const URL1 = 'https://cdn.discordapp.com/attachments/1/2/a.gif?ex=656a5c4b&is=6557e74b&hm=2b';
const base: LinkEmbed = { url: URL1, kind: 'image', site: 'cdn.discordapp.com', media: { url: URL1, mime: 'image/gif', width: 128, height: 128 } };

describe('contract: media.file', () => {
    it('kept when well-formed and within the cap for its type; dropped otherwise', () => {
        expect(sanitizeLinkEmbed({ ...base, media: { ...base.media, file: FILE } })?.media?.file).toEqual(FILE);
        const over = { ...FILE, byte_size: LINK_EMBED_MEDIA_COPY_MAX_BYTES.image + 1 };
        expect(sanitizeLinkEmbed({ ...base, media: { ...base.media, file: over } })?.media?.file).toBeUndefined();
        // A video may be bigger than an image.
        const vid = { ...base, kind: 'video', media: { url: URL1, mime: 'video/mp4', file: { ...FILE, byte_size: 20 * 1024 * 1024 } } };
        expect(sanitizeLinkEmbed(vid)?.media?.file?.byte_size).toBe(20 * 1024 * 1024);
        for (const bad of [{ ...FILE, attachment_id: 'x' }, { ...FILE, file_key_b64: 'short' }, { ...FILE, file_nonce_b64: '!' }, { ...FILE, byte_size: 0 }, 'str']) {
            expect(sanitizeLinkEmbed({ ...base, media: { ...base.media, file: bad } })?.media?.file).toBeUndefined();
        }
        // animated only on images, loop only on video.
        expect(sanitizeLinkEmbed({ ...base, media: { ...base.media, animated: true } })?.media?.animated).toBe(true);
        expect(sanitizeLinkEmbed({ ...base, kind: 'video', media: { url: URL1, mime: 'video/mp4', animated: true } })?.media?.animated).toBeUndefined();
    });

    it('the copy counts as an attachment of the message (retention / pins) and is named in report text; older embeds unchanged', () => {
        const withFile = { ...base, media: { ...base.media!, file: FILE } };
        expect(linkEmbedAttachmentIds([withFile])).toEqual([FILE.attachment_id]);
        expect(linkEmbedsReportText([withFile])).toContain(`Media copy: attachment ${FILE.attachment_id}`);
        expect(linkEmbedsReportText([base])).not.toContain('Media copy');
    });
});

describe('mediaCopy', () => {
    it('caps: 8 MB images, 25 MB videos, never above the account limit', () => {
        setMediaCopyUploadLimit(undefined);
        expect(mediaCopyMaxBytes('image/gif')).toBe(8 * 1024 * 1024);
        expect(mediaCopyMaxBytes('video/mp4')).toBe(25 * 1024 * 1024);
        setMediaCopyUploadLimit(10 * 1024 * 1024);
        expect(mediaCopyMaxBytes('video/mp4')).toBe(10 * 1024 * 1024 - 64 * 1024);
        setMediaCopyUploadLimit(undefined);
    });

    it('sniffs decrypted bytes; a mismatch is refused (POSITIVE CONTROL: HTML is not a GIF)', () => {
        expect(sniffMediaMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
        expect(sniffMediaMime(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('video/mp4');
        expect(copyMatchesMime('video/quicktime', new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe(true);
        expect(copyMatchesMime('image/gif', new TextEncoder().encode('<!doctype html>'))).toBe(false);
        expect(copyMatchesMime('image/png', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe(false);
    });

    it('uploadOnce: the late attach reuses the in-flight upload; a failure is forgotten', async () => {
        const b = blob(10);
        let n = 0;
        const up = vi.fn(async () => { n++; return { attachment_id: 'id', file_key_b64: 'k', file_nonce_b64: 'n', byte_size: 10 }; });
        await Promise.all([uploadOnce(up, b), uploadOnce(up, b)]);
        expect(n).toBe(1);
        const b2 = blob(10);
        const failing = vi.fn(async () => { throw new Error('x'); });
        await expect(uploadOnce(failing, b2)).rejects.toThrow();
        await uploadOnce(up, b2);
        expect(n).toBe(2);
    });

    it('pending marks expire', () => {
        markCopyPending('https://a.example/x', true);
        expect(isCopyPending('https://a.example/x')).toBe(true);
        markCopyPending('https://a.example/x', false);
        expect(isCopyPending('https://a.example/x')).toBe(false);
    });
});

describe('sameSite', () => {
    it.each([
        ['https://klipy.com/gifs/x', 'https://static2.klipy.com/a.gif', true],
        ['https://www.example.co.uk/a', 'https://cdn.example.co.uk/v.mp4', true],
        ['https://example.com/a', 'https://evil.com/a.mp4', false],
        ['https://a.example.co.uk/', 'https://b.other.co.uk/', false],
        ['http://example.com/a', 'https://example.com/a.mp4', false],
    ])('%s ~ %s → %s', (a, b, want) => expect(isSameSite(a, b)).toBe(want));
    it('siteOf', () => { expect(siteOf('static2.klipy.com')).toBe('klipy.com'); expect(siteOf('cdn.example.co.uk')).toBe('example.co.uk'); });
});

describe('send + late attach with a copy', () => {
    const text = `look ${URL1}`;
    const prepared: PreparedEmbed = { url: URL1, embed: base, copy: { blob: blob(1000), mime: 'image/gif' } };

    it('finalize uploads the copy as media.file (its plaintext size)', async () => {
        const up = vi.fn(async (b: Blob) => ({ ...FILE, byte_size: b.size }));
        const [e] = await finalizeEmbeds(text, [prepared], up, 1000);
        expect(e.media?.file).toEqual({ ...FILE, byte_size: 1000 });
        expect(sanitizeLinkEmbeds([e], [URL1])[0].media?.file).toBeTruthy();
    });

    it('a copy upload that misses the send deadline: sent with the link, reported LATE, then attached by the embeds-only edit with the SAME upload', async () => {
        const p: PreparedEmbed = { url: URL1, embed: base, copy: { blob: blob(1000), mime: 'image/gif' } };
        let resolveUpload!: (v: typeof FILE) => void;
        const up = vi.fn(() => new Promise<typeof FILE>((ok) => { resolveUpload = ok; }));
        const late: string[] = [];
        const sent = await takeAndFinalize(text, async () => [p], up, 50, (u) => late.push(...u));
        expect(sent[0].media?.file).toBeUndefined();
        expect(late).toEqual([URL1]);
        expect(improvesOn(sent[0], p)).toBe(true);
        const edits: unknown[] = [];
        const content = { type: 'text', text, embeds: sent };
        const run = runLateAttach({ text, sent, late, upload: up }, {
            awaitFinal: async () => p,
            finalize: finalizeEmbeds,
            findRow: () => ({ id: 'm1', content, send_state: 'sent' }),
            send: async (e) => { edits.push(e); },
        });
        setTimeout(() => resolveUpload(FILE), 20);
        expect(await run).toBe('attached');
        expect(up).toHaveBeenCalledTimes(1);
        expect(edits[0]).toMatchObject({ embeds_only: true, embeds: [{ media: { file: { attachment_id: FILE.attachment_id } } }] });
    });
});
