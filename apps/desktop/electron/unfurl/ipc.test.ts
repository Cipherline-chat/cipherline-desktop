import { describe, it, expect, vi } from 'vitest';
import { createUnfurler, registerUnfurlIpc, SNAPSHOT_CANCEL_CHANNEL, SNAPSHOT_CHANNEL, SNAPSHOT_ELIGIBLE_TTL_MS, UNFURL_CHANNEL, MEDIA_COPY_CHANNEL, UNFURL_CONCURRENCY, UNFURL_CACHE_TTL_MS } from './ipc';
import type { UnfurlResult } from './unfurl';
import { registerSenderClipMedia } from '../media-embed/ipc';
import { MediaRegistry } from '../media-embed/media-registry';
import { youTubeRefOf } from './providers';
import { parseYouTubeLink } from '../../src/utils/youtubeLink';

const okResult = (url: string): UnfurlResult => ({ ok: true, embed: { url, kind: 'card', title: 't' } });

describe('createUnfurler', () => {
    it('validates the argument before anything runs', async () => {
        const unfurl = vi.fn(async (u: unknown) => okResult(String(u)));
        const f = createUnfurler({ unfurl });
        for (const bad of [undefined, null, 5, {}, '', 'x'.repeat(2049)]) expect(await f(bad)).toEqual({ ok: false, reason: 'invalid' });
        expect(unfurl).not.toHaveBeenCalled();
    });

    it('shares one run per URL in flight, caches the result, and expires it', async () => {
        let t = 1000;
        const unfurl = vi.fn(async (u: unknown) => okResult(String(u)));
        const f = createUnfurler({ unfurl, now: () => t });
        await Promise.all([f('https://a.example/'), f('https://a.example/')]);
        expect(unfurl).toHaveBeenCalledTimes(1);
        await f('https://a.example/');
        expect(unfurl).toHaveBeenCalledTimes(1);
        t += UNFURL_CACHE_TTL_MS + 1;
        await f('https://a.example/');
        expect(unfurl).toHaveBeenCalledTimes(2);
    });

    it('a network failure is not cached; a thrown unfurl is a quiet failure', async () => {
        const unfurl = vi.fn(async (): Promise<UnfurlResult> => { throw new Error('boom'); });
        const f = createUnfurler({ unfurl });
        expect(await f('https://a.example/')).toEqual({ ok: false, reason: 'failed' });
        expect(await f('https://a.example/')).toEqual({ ok: false, reason: 'failed' });
        expect(unfurl).toHaveBeenCalledTimes(2);
    });

    it(`runs at most ${UNFURL_CONCURRENCY} at once`, async () => {
        let running = 0, peak = 0;
        const unfurl = vi.fn(async (u: unknown) => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 10)); running--; return okResult(String(u)); });
        const f = createUnfurler({ unfurl });
        await Promise.all(Array.from({ length: 10 }, (_, i) => f(`https://a.example/${i}`)));
        expect(unfurl).toHaveBeenCalledTimes(10);
        expect(peak).toBe(UNFURL_CONCURRENCY);
    });

    it('logs the host and outcome only, never the path', async () => {
        const lines: string[] = [];
        const f = createUnfurler({ unfurl: async (u) => okResult(String(u)), log: (l) => lines.push(l) });
        await f('https://a.example/secret/path?token=1');
        expect(lines[0]).toMatch(/^\[unfurl\] a\.example ok card /);
        expect(lines.join('')).not.toMatch(/secret|token/);
    });

    it('registers the one channel', () => {
        const handle = vi.fn();
        registerUnfurlIpc({ handle });
        // The copy channel (2026-11-24) is always there; the snapshot pair only with a snapshotter.
        expect(handle.mock.calls.map((c) => c[0])).toEqual([UNFURL_CHANNEL, MEDIA_COPY_CHANNEL]);
    });
});

describe('registerSenderClipMedia (receiver plays a sender-named clip file without fetching the page)', () => {
    const registry = new MediaRegistry();
    const page = 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt';
    it('accepts the provider\'s own media host', () => {
        const r = registerSenderClipMedia(page, 'https://cdn.medal.tv/mediac/x.mp4?auth=exp=1~hmac=2', { registry });
        expect(r.ok && r.src).toMatch(/^clmedia:\/\/media\/[0-9a-f]{32}$/);
    });
    it.each([
        ['another host', page, 'https://evil.example/x.mp4'],
        ['http', page, 'http://cdn.medal.tv/x.mp4'],
        ['a port', page, 'https://cdn.medal.tv:8443/x.mp4'],
        ['credentials', page, 'https://u:p@cdn.medal.tv/x.mp4'],
        ['an image path', page, 'https://cdn.medal.tv/x.jpg'],
        ['not a clip page', 'https://news.example/a', 'https://cdn.medal.tv/x.mp4'],
        ['a cross-provider file', 'https://streamable.com/moo', 'https://cdn.medal.tv/x.mp4'],
        ['junk', page, 42],
    ])('refuses %s', (_n, p, m) => {
        expect(registerSenderClipMedia(p, m, { registry })).toEqual({ ok: false });
    });
    it('refuses without a registry', () => {
        expect(registerSenderClipMedia(page, 'https://cdn.medal.tv/x.mp4', {})).toEqual({ ok: false });
    });
});

describe('youTubeRefOf (main) agrees with parseYouTubeLink (renderer)', () => {
    it.each([
        'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5',
        'https://youtu.be/jNQXAC9IVRw?t=1m30s',
        'https://www.youtube.com/shorts/dQw4w9WgXcQ',
        'https://music.youtube.com/watch?v=dQw4w9WgXcQ#t=42',
        'https://m.youtube.com/watch?v=dQw4w9WgXcQ&start=10',
        'https://www.youtube.com/embed/dQw4w9WgXcQ',
        'https://www.youtube.com/live/dQw4w9WgXcQ',
        'https://evil.example/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/watch?v=short',
        'https://u:p@www.youtube.com/watch?v=dQw4w9WgXcQ',
        'ftp://youtu.be/dQw4w9WgXcQ',
    ])('%s', (u) => {
        expect(youTubeRefOf(u)).toEqual(parseYouTubeLink(u));
    });
});

describe('embed:snapshot (page snapshots) is gated on the unfurler', () => {
    function setup(result: (url: string) => UnfurlResult) {
        let t = 1_000_000;
        const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
        const request = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([1, 2]), mime: 'image/png' as const, width: 1200, height: 675, ms: 900, counters: { requests: 3 } as never }));
        const cancel = vi.fn(() => true);
        registerUnfurlIpc({ handle: (c, l) => { handlers.set(c, l); } }, { unfurl: async (u) => result(String(u)), now: () => t, snapshotter: { request, cancel } });
        const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a);
        return { call, request, cancel, advance: (ms: number) => { t += ms; } };
    }
    const flagged = (url: string): UnfurlResult => ({ ok: true, embed: { url, kind: 'card', title: 'No picture' }, snapshot: true });

    it('only for a URL the unfurler just flagged (a real page with no picture); never a URL the renderer made up', async () => {
        const s = setup(flagged);
        expect(await s.call(SNAPSHOT_CHANNEL, 'https://made-up.example/', 'tokenaaaa')).toEqual({ ok: false, reason: 'not-eligible' });
        expect(s.request).not.toHaveBeenCalled();
        await s.call(UNFURL_CHANNEL, 'https://nopic.example/a');
        const r = await s.call(SNAPSHOT_CHANNEL, 'https://nopic.example/a', 'tokenaaaa');
        expect(r).toEqual({ ok: true, bytes: new Uint8Array([1, 2]), mime: 'image/png', width: 1200, height: 675, ms: 900 }); // counters stay in main
        expect(s.request).toHaveBeenCalledWith('https://nopic.example/a', 'tokenaaaa');
        s.advance(SNAPSHOT_ELIGIBLE_TTL_MS + 1);
        expect(await s.call(SNAPSHOT_CHANNEL, 'https://nopic.example/a', 'tokenbbbb')).toEqual({ ok: false, reason: 'not-eligible' });
    });

    it('a page with its own picture, a wall / minimal card, or a failure is never eligible', async () => {
        const s = setup((url) => (url.includes('pic') ? { ok: true, embed: { url, kind: 'card', title: 't' }, image: { bytes: new Uint8Array([1]), mime: 'image/png' } } : url.includes('wall') ? { ok: true, embed: { url, kind: 'card', site: 'wall.example' } } : { ok: false, reason: 'failed' }));
        for (const u of ['https://pic.example/', 'https://wall.example/', 'https://down.example/']) {
            await s.call(UNFURL_CHANNEL, u);
            expect(await s.call(SNAPSHOT_CHANNEL, u, 'tokenaaaa')).toEqual({ ok: false, reason: 'not-eligible' });
        }
        expect(s.request).not.toHaveBeenCalled();
    });

    it('a provider page marked `snapshotable` (embeds-always-thumb: its picture may turn out flat, its frame grab may fail) is eligible; a direct file is not', async () => {
        const s = setup((url) => (url.includes('medal')
            ? { ok: true, embed: { url, kind: 'video', title: 'clip' }, image: { bytes: new Uint8Array([1]), mime: 'image/avif' }, snapshotable: true }
            : { ok: true, embed: { url, kind: 'video', media: { url, mime: 'video/mp4' } } }));
        await s.call(UNFURL_CHANNEL, 'https://medal.tv/clips/abcd1234');
        expect(await s.call(SNAPSHOT_CHANNEL, 'https://medal.tv/clips/abcd1234', 'tokenaaaa')).toMatchObject({ ok: true });
        await s.call(UNFURL_CHANNEL, 'https://cdn.example/a.mp4');
        expect(await s.call(SNAPSHOT_CHANNEL, 'https://cdn.example/a.mp4', 'tokenbbbb')).toEqual({ ok: false, reason: 'not-eligible' });
        expect(s.request).toHaveBeenCalledTimes(1);
    });

    it('arguments are checked: non-https, credentials, bad tokens; cancel takes only a token', async () => {
        const s = setup(flagged);
        for (const u of ['http://nopic.example/a', 'https://u:p@nopic.example/a', 'file:///etc/passwd']) {
            await s.call(UNFURL_CHANNEL, u);
            expect(await s.call(SNAPSHOT_CHANNEL, u, 'tokenaaaa')).toEqual({ ok: false, reason: 'invalid' });
        }
        await s.call(UNFURL_CHANNEL, 'https://nopic.example/a');
        for (const tok of [undefined, 'short', 'has spaces in it', 'x'.repeat(65), 5]) {
            expect(await s.call(SNAPSHOT_CHANNEL, 'https://nopic.example/a', tok)).toEqual({ ok: false, reason: 'invalid' });
        }
        expect(s.request).not.toHaveBeenCalled();
        expect(await s.call(SNAPSHOT_CANCEL_CHANNEL, 'tokenaaaa')).toBe(true);
        expect(await s.call(SNAPSHOT_CANCEL_CHANNEL, '../../etc')).toBe(false);
        expect(s.cancel).toHaveBeenCalledTimes(1);
    });
});
