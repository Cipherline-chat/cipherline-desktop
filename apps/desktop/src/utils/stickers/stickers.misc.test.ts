import { describe, it, expect } from 'vitest';
import { stickerMatches } from '@cipherline/shared';
import { pushRecent, RECENT_STICKERS_MAX, type RecentSticker } from './recent';
import { parseStickerTags } from './tags';
import { PersonalEmojis, STICKER_LIBRARY_PROFILE } from '../personalEmoji/service';
import { sanitizeLibrary } from '../personalEmoji/library';
import { PERSONAL_EMOJI_MAX_BYTES } from '../personalEmoji/token';
import { createServerListCache } from '../emojiListCache';
import type { StoreIO } from '../personalEmoji/store';

const r = (id: string): RecentSticker => ({ source: 'personal', id: `p_${id.padEnd(32, '0')}`, name: `n_${id}` });

describe('recent stickers', () => {
    it('newest first, de-duplicated, capped', () => {
        let list: RecentSticker[] = [];
        list = pushRecent(list, r('a'));
        list = pushRecent(list, r('b'));
        list = pushRecent(list, r('a'));
        expect(list.map(x => x.name)).toEqual(['n_a', 'n_b']);
        for (let i = 0; i < 30; i++) list = pushRecent(list, r(String(i).padStart(2, '0')));
        expect(list).toHaveLength(RECENT_STICKERS_MAX);
    });
});

describe('sticker search + tags', () => {
    it('matches name, description and tags, case-insensitively; colons ignored', () => {
        const s = { name: 'wave', description: 'Hello There', tags: ['greet', 'hi'] };
        expect(stickerMatches('', s)).toBe(true);
        expect(stickerMatches('WAV', s)).toBe(true);
        expect(stickerMatches('there', s)).toBe(true);
        expect(stickerMatches('gree', s)).toBe(true);
        expect(stickerMatches(':wave:', s)).toBe(true);
        expect(stickerMatches('bye', s)).toBe(false);
    });

    it('parses comma/space separated tags and reports bad ones', () => {
        expect(parseStickerTags('Wave, hi  hi,greet')).toEqual({ tags: ['wave', 'hi', 'greet'], bad: [] });
        expect(parseStickerTags('ok, no-dash')).toEqual({ tags: ['ok'], bad: ['no-dash'] });
    });
});

describe('My stickers library', () => {
    function io(): StoreIO {
        const kv = new Map<string, string>(), files = new Map<string, Uint8Array>();
        return {
            uid: () => 'u', kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, kvRemove: k => { kv.delete(k); },
            readFile: async n => files.get(n) ?? null, writeFile: async (n, b) => { files.set(n, b); },
            deleteFile: async n => { files.delete(n); }, now: () => 1,
        };
    }
    const bigPng = (size: number) => { const b = new Uint8Array(size).fill(3); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };

    it('accepts a sticker above the emoji cap (<= 512 KB); the emoji library still refuses it', async () => {
        const shared = io();
        const stickers = new PersonalEmojis(shared, STICKER_LIBRARY_PROFILE);
        const emojis = new PersonalEmojis(io());
        const bytes = bigPng(PERSONAL_EMOJI_MAX_BYTES + 1000);
        expect((await stickers.add(bytes, 'big_one')).ok).toBe(true);
        expect(await emojis.add(bytes, 'big_one')).toEqual({ ok: false, error: 'too_large' });
        expect(stickers.load().entries.map(e => e.name)).toEqual(['big_one']);
    });

    it('stickers live under their own key, separate from My Emojis', async () => {
        const shared = io();
        const stickers = new PersonalEmojis(shared, STICKER_LIBRARY_PROFILE);
        const emojis = new PersonalEmojis(shared);
        await stickers.add(bigPng(100), 'one');
        expect(emojis.load().entries).toHaveLength(0);
        expect(shared.kvGet('cipherline_sticker_library_u')).toContain('one');
    });

    it('an emoji-capped sanitize drops a big entry; a sticker-capped one keeps it', () => {
        const entry = { id: 'p_' + 'a'.repeat(32), name: 'big', mime: 'image/webp', animated: false, size: 400_000, order: 0, at: 1, addedAt: 1 };
        expect(sanitizeLibrary({ entries: [entry], tombstones: {} }).entries).toHaveLength(0);
        expect(sanitizeLibrary({ entries: [entry], tombstones: {} }, 512 * 1024).entries).toHaveLength(1);
    });
});

describe('createServerListCache (stickers reuse the emoji list store)', () => {
    it('dedupes, upserts and lists servers', () => {
        const c = createServerListCache<{ id: string; v: number }>(x => x.id);
        c.set('s1', [{ id: 'a', v: 1 }, { id: 'a', v: 2 }]);
        expect(c.get('s1')).toEqual([{ id: 'a', v: 1 }]);
        expect(c.upsert(c.get('s1')!, { id: 'a', v: 3 })).toEqual([{ id: 'a', v: 3 }]);
        expect(c.serverIds()).toEqual(['s1']);
        expect(c.find('a')).toEqual({ id: 'a', v: 1 });
        c.clear();
        expect(c.has('s1')).toBe(false);
    });
});
