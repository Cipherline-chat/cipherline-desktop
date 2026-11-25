/**
 * The renderer half of "always a thumbnail" (embeds-always-thumb), step by
 * step: a flat provider picture is no picture; the designed picture is
 * attached at once; completePicture tries the frame, then the snapshot, and
 * keeps the designed picture when both fail; a cancel stops the grab; the
 * `designed` mark reaches the wire and a later real picture counts as an
 * improvement for the late attach.
 */
import { describe, it, expect, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { sanitizeEmbedImage, sanitizeLinkEmbeds } from '@cipherline/shared';

const thumbMock = vi.hoisted(() => ({ flat: false }));
vi.mock('./thumb', async (orig) => {
    const real = await orig<typeof import('./thumb')>();
    return {
        ...real,
        reencodeThumb: vi.fn(async () => ({
            blob: new (await import('node:buffer')).Blob([new Uint8Array(20_000)]) as unknown as Blob,
            mime: 'image/webp', width: 920, height: 518, ...(thumbMock.flat ? { flat: true } : {}),
        })),
    };
});

import { cancelFrameGrab, completePicture, finalizeEmbeds, framePrepared, prepareLinkEmbed, type PictureDeps, type PreparedEmbed } from './prepare';
import { improvesOn } from './lateAttach';

const blob = (n: number) => new NodeBlob([new Uint8Array(n)]) as unknown as Blob;
const designed = vi.fn(async () => ({ blob: blob(4_000), mime: 'image/webp' as const, width: 640, height: 360, designed: true as const }));
const MEDAL = 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt';
const medalUnfurl = vi.fn(async () => ({
    ok: true as const,
    embed: { url: MEDAL, kind: 'video', site: 'Medal', title: 'wyw', media: { url: 'https://cdn.medal.tv/mediac/x.mp4', mime: 'video/mp4', width: 1280, height: 720 } },
    image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/avif' }, snapshotable: true as const,
}));
const grabOk: PictureDeps['grab'] = async () => ({ thumb: { blob: blob(30_000), mime: 'image/webp', width: 920, height: 518 }, width: 1920, height: 1080, durationS: 24.15, atS: 2.4, samples: 2 });
const register: PictureDeps['register'] = async () => ({ ok: true, src: `clmedia://media/${'b'.repeat(32)}` });

describe('prepareLinkEmbed: always a picture at once', () => {
    it('a flat (black) provider picture is no picture: the designed one now, a frame / snapshot still to come', async () => {
        thumbMock.flat = true;
        const p = await prepareLinkEmbed(MEDAL, medalUnfurl, { designed });
        thumbMock.flat = false;
        expect(p?.thumb?.designed).toBe(true);
        expect(p?.snapshot).toBe('pending');
        expect(p?.frame).toEqual({ pageUrl: MEDAL, mediaUrl: 'https://cdn.medal.tv/mediac/x.mp4' });
        expect(p?.snapshotOk).toBe(true);
        expect(designed).toHaveBeenCalledWith(expect.objectContaining({ label: 'Medal', play: true }));
    });

    it('a good provider picture is kept: nothing pending, nothing designed', async () => {
        const p = await prepareLinkEmbed(MEDAL, medalUnfurl, { designed });
        expect(p?.thumb?.designed).toBeUndefined();
        expect(p?.snapshot).toBeUndefined();
    });

    it('a card with no picture: designed (centred, with the site icon) + a snapshot pending', async () => {
        const unfurl = vi.fn(async () => ({ ok: true as const, embed: { url: 'https://a.example/', kind: 'card', site: 'a.example', title: 'A' }, icon: { bytes: new Uint8Array([1]), mime: 'image/png' }, snapshot: true as const, snapshotable: true as const }));
        const p = await prepareLinkEmbed('https://a.example/', unfurl, { designed });
        expect(p?.thumb?.designed).toBe(true);
        expect(p?.snapshot).toBe('pending');
        expect(p?.frame).toBeUndefined();
        expect(designed).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'a.example', play: false }));
    });

    it('a post: its photos are its pictures; only a video post needs a poster', async () => {
        const photos = vi.fn(async () => ({ ok: true as const, embed: { url: 'https://x.com/a/status/1', kind: 'post', site: 'X', description: 'hi' }, images: [{ bytes: new Uint8Array([1]), mime: 'image/jpeg' }] }));
        const a = await prepareLinkEmbed('https://x.com/a/status/1', photos, { designed });
        expect(a?.thumb).toBeUndefined();
        expect(a?.snapshot).toBeUndefined();
        const video = vi.fn(async () => ({ ok: true as const, embed: { url: 'https://x.com/a/status/2', kind: 'post', site: 'X', description: 'v', media: { url: 'https://video.twimg.com/a.mp4', mime: 'video/mp4' } } }));
        const b = await prepareLinkEmbed('https://x.com/a/status/2', video, { designed });
        expect(b?.thumb?.designed).toBe(true);
        expect(b?.frame?.mediaUrl).toBe('https://video.twimg.com/a.mp4');
    });

    it('a failed unfurl / an http link: the minimal card WITH the designed picture', async () => {
        const p = await prepareLinkEmbed('https://down.example/x', vi.fn(async () => ({ ok: false as const, reason: 'failed' })), { designed });
        expect(p?.embed).toEqual({ url: 'https://down.example/x', kind: 'card', site: 'down.example' });
        expect(p?.thumb?.designed).toBe(true);
        expect((await prepareLinkEmbed('http://old.example/', vi.fn(), { designed }))?.thumb?.designed).toBe(true);
    });
});

describe('completePicture: frame → snapshot → designed', () => {
    async function pending(): Promise<PreparedEmbed> {
        thumbMock.flat = true;
        const p = (await prepareLinkEmbed(MEDAL, medalUnfurl, { designed }))!;
        thumbMock.flat = false;
        return p;
    }

    it('the frame wins, with the real size and duration in media', async () => {
        const snap = vi.fn();
        const r = await completePicture(await pending(), 'tok1abcdefgh', { register, grab: grabOk, snap });
        expect(r.snapshotResult).toBe('frame');
        expect(r.thumb?.designed).toBeUndefined();
        expect(r.embed.media).toMatchObject({ width: 1920, height: 1080, duration_s: 24.15 });
        expect(r.snapshot).toBeUndefined();
        expect(snap).not.toHaveBeenCalled();
    });

    it('no frame (refused file, failed grab) → the snapshot; refused snapshot too → keeps the designed picture', async () => {
        const snapOk = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([1]), mime: 'image/png' as const, width: 1200, height: 675, ms: 1 }));
        const a = await completePicture(await pending(), 'tok2abcdefgh', { register: async () => ({ ok: false }), snap: snapOk });
        expect(a.snapshotResult).toBe('ok');
        expect(a.embed.image_large).toBeUndefined(); // a video is not a card
        const b = await completePicture(await pending(), 'tok3abcdefgh', { register, grab: async () => null, snap: async () => ({ ok: false, reason: 'login' }) });
        expect(b.snapshotResult).toBe('login');
        expect(b.thumb?.designed).toBe(true);
    });

    it('cancelFrameGrab stops a running grab ("cancelled": it is retried if the link comes back)', async () => {
        let seen: AbortSignal | null = null;
        const grab: PictureDeps['grab'] = (_src, signal) => new Promise((ok) => { seen = signal; signal.addEventListener('abort', () => ok(null)); });
        const p = completePicture(await pending(), 'tok4abcdefgh', { register, grab, snap: vi.fn() });
        await new Promise((r) => setTimeout(r, 5));
        cancelFrameGrab('tok4abcdefgh');
        expect((await p).snapshotResult).toBe('cancelled');
        expect(seen!.aborted).toBe(true);
    });

    it('framePrepared never asks main for anything without a file', async () => {
        const reg = vi.fn();
        expect(await framePrepared({ url: 'https://a.example/', embed: { url: 'https://a.example/', kind: 'card', site: 'a' } }, 'tok5abcdefgh', { register: reg })).toBeNull();
        expect(reg).not.toHaveBeenCalled();
    });
});

describe('the designed mark on the wire', () => {
    it('finalizeEmbeds sends it; the reader\'s validator keeps it (and only `true`)', async () => {
        thumbMock.flat = true;
        const p = (await prepareLinkEmbed(MEDAL, medalUnfurl, { designed }))!;
        thumbMock.flat = false;
        const [e] = await finalizeEmbeds(`x ${MEDAL}`, [p], null, 500);
        expect(e.thumb).toMatchObject({ designed: true, mime: 'image/webp', width: 640, height: 360 });
        expect(e.thumb?.inline_b64).toBeTruthy();
        expect(sanitizeLinkEmbeds([e], [MEDAL])[0].thumb?.designed).toBe(true);
        expect(sanitizeEmbedImage({ ...e.thumb, designed: 'yes' })?.designed).toBeUndefined();
    });

    it('late attach: a real picture improves on a designed one, not on a real one', () => {
        const sentDesigned = { url: MEDAL, kind: 'video' as const, title: 't', thumb: { mime: 'image/webp' as const, width: 640, height: 360, inline_b64: 'A'.repeat(24), designed: true as const } };
        const sentReal = { ...sentDesigned, thumb: { ...sentDesigned.thumb, designed: undefined } };
        const next: PreparedEmbed = { url: MEDAL, embed: { url: MEDAL, kind: 'video', title: 't' }, thumb: { blob: blob(1), mime: 'image/webp', width: 920, height: 518 } };
        expect(improvesOn(sentDesigned, next)).toBe(true);
        expect(improvesOn(sentReal, next)).toBe(false);
        // A designed picture never "improves" on anything.
        expect(improvesOn(sentDesigned, { ...next, thumb: { ...next.thumb!, designed: true } })).toBe(false);
    });
});
