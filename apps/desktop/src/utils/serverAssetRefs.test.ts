/**
 * Owner 2026-11-26: a custom emoji / sticker, once sent, keeps rendering in the
 * message forever. The server now retires (never destroys) a deleted one and
 * serves it by id; this module is the device side: remember what was shown, and
 * ask by id for what the list lacks. A miss is never "deleted".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const post = vi.fn();
vi.mock('axios', () => ({
    default: { post: (...a: unknown[]) => post(...a), isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError },
}));
vi.mock('./apiPath', () => ({ apiUrl: (s: TemplateStringsArray, ...v: unknown[]) => String.raw({ raw: s }, ...v) }));
const store = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        whenAccountReady: () => Promise.resolve(),
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    },
}));

import {
    __resetAssetRefs, ASSET_REF_CAP, assetResolvePendingCount, bindAssetRefAccount, flushAssetRefs, isAssetMissing,
    isAssetResolvePending, noteDisplayed, peekAssetRef, requestResolve, RESOLVE_RETRY_DELAYS_MS, type AssetRef,
} from './serverAssetRefs';
import { resolveEmojiGlyphState } from '../components/server/emojiGlyphState';

const ref = (id: string, over: Partial<AssetRef> = {}): AssetRef => ({
    id, kind: 'emoji', server_id: 'srv', name: 'wave', attachment_id: `att-${id}`, key_b64: 'k', nonce_b64: 'n', animated: false, retired: false, ...over,
});
const row = (id: string, retired = true) => ({ emoji_id: id, server_id: 'srv', name: 'wave', attachment_id: `att-${id}`, key_b64: 'k', nonce_b64: 'n', animated: false, retired });
const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status } });
const tick = () => vi.advanceTimersByTimeAsync(100);

beforeEach(() => { vi.useFakeTimers(); post.mockReset(); store.clear(); __resetAssetRefs(); });
afterEach(() => { __resetAssetRefs(); vi.useRealTimers(); });

describe('by-id resolution of ids the list lacks', () => {
    it('asks the server by id, batches, and remembers a RETIRED emoji so it renders', async () => {
        post.mockResolvedValue({ data: { emojis: [row('e1'), row('e2')] } });
        requestResolve('emoji', 'srv', 'e1', 'tok');
        requestResolve('emoji', 'srv', 'e2', 'tok');
        expect(isAssetResolvePending('e1')).toBe(true);
        // pending = 'loading' glyph, never 'unavailable'
        expect(resolveEmojiGlyphState(undefined, false, 'e1')).toBe('loading');
        await tick();
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][0]).toBe('/servers/srv/emojis/resolve');
        expect(post.mock.calls[0][1]).toEqual({ ids: ['e1', 'e2'] });
        expect(peekAssetRef('e1')).toMatchObject({ retired: true, attachment_id: 'att-e1' });
        expect(assetResolvePendingCount()).toBe(0);
    });

    it('an id the server does not return is authoritatively missing -> unavailable, and is not asked again', async () => {
        post.mockResolvedValue({ data: { emojis: [] } });
        requestResolve('emoji', 'srv', 'gone', 'tok');
        await tick();
        expect(isAssetMissing('gone')).toBe(true);
        expect(resolveEmojiGlyphState(undefined, false, 'gone')).toBe('unavailable');
        requestResolve('emoji', 'srv', 'gone', 'tok');
        await tick();
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('a network error / 429 / 5xx is NOT an answer: stays pending, retries, then resolves', async () => {
        post.mockRejectedValueOnce(http(503)).mockRejectedValueOnce(http(429)).mockResolvedValueOnce({ data: { emojis: [row('e1')] } });
        requestResolve('emoji', 'srv', 'e1', 'tok');
        await tick();
        expect(isAssetResolvePending('e1')).toBe(true);
        expect(isAssetMissing('e1')).toBe(false);
        expect(resolveEmojiGlyphState(undefined, false, 'e1')).toBe('loading');
        await vi.advanceTimersByTimeAsync(RESOLVE_RETRY_DELAYS_MS[0] + 50);
        expect(isAssetResolvePending('e1')).toBe(true);
        await vi.advanceTimersByTimeAsync(RESOLVE_RETRY_DELAYS_MS[1] + 50);
        expect(peekAssetRef('e1')?.retired).toBe(true);
        expect(post).toHaveBeenCalledTimes(3);
    });

    it('403 (not a member) / old API without the route (404) are authoritative for the session', async () => {
        post.mockRejectedValueOnce(http(403));
        requestResolve('emoji', 'srv', 'a', 'tok');
        await tick();
        expect(isAssetMissing('a')).toBe(true);
        post.mockRejectedValueOnce(http(404));
        requestResolve('sticker', 'srv', 'b', 'tok');
        await tick();
        expect(isAssetMissing('b')).toBe(true);
    });

    it('stickers use their own route and response key', async () => {
        post.mockResolvedValue({ data: { stickers: [{ sticker_id: 's1', server_id: 'srv', name: 'hi', attachment_id: 'sa', key_b64: 'k', nonce_b64: 'n', animated: true, retired: true }] } });
        requestResolve('sticker', 'srv', 's1', 'tok');
        await tick();
        expect(post.mock.calls[0][0]).toBe('/servers/srv/stickers/resolve');
        expect(peekAssetRef('s1')).toMatchObject({ kind: 'sticker', animated: true, retired: true });
    });

    it('does not ask for an id it already remembers', async () => {
        noteDisplayed(ref('e1'));
        requestResolve('emoji', 'srv', 'e1', 'tok');
        await tick();
        expect(post).not.toHaveBeenCalled();
    });

    it('ignores rows that are not among the requested ids (a hostile/odd response cannot plant refs)', async () => {
        post.mockResolvedValue({ data: { emojis: [row('e1'), row('zzz')] } });
        requestResolve('emoji', 'srv', 'e1', 'tok');
        await tick();
        expect(peekAssetRef('zzz')).toBeUndefined();
    });
});

describe('durable archive', () => {
    it('persists per account (encrypted store key carries the user id) and reloads after a restart', async () => {
        await bindAssetRefAccount('u1');
        noteDisplayed(ref('e1', { retired: true }));
        flushAssetRefs();
        expect([...store.keys()]).toEqual(['cipherline_server_asset_refs_u1']);
        __resetAssetRefs();
        expect(peekAssetRef('e1')).toBeUndefined();
        await bindAssetRefAccount('u1');
        expect(peekAssetRef('e1')).toMatchObject({ retired: true, attachment_id: 'att-e1' });
    });

    it('another account does not see it', async () => {
        await bindAssetRefAccount('u1');
        noteDisplayed(ref('e1'));
        flushAssetRefs();
        __resetAssetRefs();
        await bindAssetRefAccount('u2');
        expect(peekAssetRef('e1')).toBeUndefined();
    });

    it('a corrupt blob starts empty instead of throwing', async () => {
        store.set('cipherline_server_asset_refs_u1', '{not json');
        await expect(bindAssetRefAccount('u1')).resolves.toBeUndefined();
        expect(peekAssetRef('e1')).toBeUndefined();
    });

    it('is capped, dropping the least-recently-shown first', async () => {
        await bindAssetRefAccount('u1');
        for (let i = 0; i < ASSET_REF_CAP + 5; i++) noteDisplayed(ref(`e${i}`), 1_000 + i);
        expect(peekAssetRef('e0')).toBeUndefined();
        expect(peekAssetRef(`e${ASSET_REF_CAP + 4}`)).toBeDefined();
    });
});
