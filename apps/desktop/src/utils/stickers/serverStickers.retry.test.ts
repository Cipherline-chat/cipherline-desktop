/**
 * "Stickers and custom emojis show as unavailable when I scroll back."
 * A list fetch that failed TRANSIENTLY (network blip, 429, 5xx) used to be
 * recorded as "settled with no list", which the renderers read as "this
 * sticker / emoji was deleted" - permanently, with nothing retrying it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const get = vi.fn();
vi.mock('axios', () => ({
    default: { get: (...a: unknown[]) => get(...a), isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError },
}));
vi.mock('../serverEmojiLoader', () => ({ prefetchServerEmojis: vi.fn() }));
vi.mock('../apiPath', () => ({ apiUrl: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v) }));

import { ensureServerStickers, stickerListCache, findServerSticker } from './serverStickers';
import { emojiListCache, cancelListRetries } from '../emojiListCache';
import { refreshServerEmojis } from '../../hooks/useServerEmojis';


const sticker = { sticker_id: 'st1', server_id: 'srv', name: 'wave', description: null, tags: [], attachment_id: 'a1', key_b64: 'k', nonce_b64: 'n', animated: false, created_by: null, created_at: '2026-01-01T00:00:00Z' };
const netErr = Object.assign(new Error('Network Error'), { isAxiosError: true });
const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status } });

beforeEach(() => { vi.useFakeTimers(); get.mockReset(); stickerListCache.clear(); emojiListCache.clear(); cancelListRetries(); });
afterEach(() => { cancelListRetries(); vi.useRealTimers(); });

describe('sticker list: a failed fetch is not an answer', () => {
    it('stays unknown (not "deleted") after a network error, then resolves on retry', async () => {
        get.mockRejectedValueOnce(netErr).mockResolvedValueOnce({ data: [sticker] });
        await ensureServerStickers('srv', 'tok');
        // Unknown: not settled, no list -> useServerSticker yields undefined (placeholder), not null.
        expect(stickerListCache.isSettled('srv')).toBe(false);
        expect(findServerSticker('srv', 'st1')).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2_500);
        expect(findServerSticker('srv', 'st1')?.name).toBe('wave');
    });

    it('a 429 is retried too', async () => {
        get.mockRejectedValueOnce(http(429)).mockResolvedValueOnce({ data: [sticker] });
        await ensureServerStickers('srv', 'tok');
        expect(findServerSticker('srv', 'st1')).toBeUndefined();
        await vi.advanceTimersByTimeAsync(2_500);
        expect(findServerSticker('srv', 'st1')).not.toBeUndefined();
    });

    it('403 (not a member) IS authoritative: gone, no retry', async () => {
        get.mockRejectedValue(http(403));
        await ensureServerStickers('srv', 'tok');
        expect(findServerSticker('srv', 'st1')).toBeNull();
        await vi.advanceTimersByTimeAsync(200_000);
        expect(get).toHaveBeenCalledTimes(1);
    });
});

describe('emoji list: a failed fetch is not an answer', () => {
    it('refreshServerEmojis throws on a 5xx and does not settle the server', async () => {
        get.mockRejectedValueOnce(http(503));
        await expect(refreshServerEmojis('srv', 'tok')).rejects.toBeTruthy();
        expect(emojiListCache.isSettled('srv')).toBe(false);
        expect(emojiListCache.has('srv')).toBe(false);
    });

    it('403 settles with no list (authoritative)', async () => {
        get.mockRejectedValueOnce(http(403));
        await refreshServerEmojis('srv', 'tok');
        expect(emojiListCache.isSettled('srv')).toBe(true);
    });
});
