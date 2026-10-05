import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BlobUrlCache } from './blobUrlCache';
import { bytesFromBinaryPayload } from './binaryPayload';
import { base64ToBytes } from './base64Bytes';
import { shallowValueEqual, shallowArrayEqual, mergeIfChanged, setIfChanged } from './renderMemo';

const revoked: string[] = [];
beforeEach(() => {
    revoked.length = 0;
    vi.restoreAllMocks();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => { revoked.push(u); });
});

describe('BlobUrlCache', () => {
    it('never evicts an entry someone holds, and revokes what it evicts', () => {
        const c = new BlobUrlCache(100, 10);
        c.put('a', 'blob:a', 60);            // held
        c.put('b', 'blob:b', 60);            // held — over budget, but both held
        expect(c.stats()).toMatchObject({ entries: 2, held: 2 });
        expect(revoked).toEqual([]);
        c.release('a');                      // now evictable, and over budget
        expect(c.peek('a')).toBeNull();
        expect(revoked).toEqual(['blob:a']);
        expect(c.peek('b')?.url).toBe('blob:b');
    });

    it('keeps released entries for reuse while within budget (the chat-switch case)', () => {
        const c = new BlobUrlCache(1000, 10);
        c.put('a', 'blob:a', 10);
        c.release('a');
        expect(revoked).toEqual([]);
        const again = c.acquire('a');
        expect(again?.url).toBe('blob:a');
        expect(c.stats().held).toBe(1);
    });

    it('evicts least-recently-used first', () => {
        const c = new BlobUrlCache(1000, 2);
        c.put('a', 'blob:a', 1); c.release('a');
        c.put('b', 'blob:b', 1); c.release('b');
        c.peek('a');                          // a is now more recent than b
        c.put('c', 'blob:c', 1); c.release('c');
        expect(revoked).toEqual(['blob:b']);
    });

    it('a second put for the same key keeps the first URL and revokes the duplicate', () => {
        const c = new BlobUrlCache(1000, 10);
        const first = c.put('a', 'blob:1', 5);
        const second = c.put('a', 'blob:2', 5);
        expect(second.url).toBe('blob:1');
        expect(first).toBe(second);
        expect(revoked).toEqual(['blob:2']);
        expect(c.stats().held).toBe(1);
        expect(second.refs).toBe(2);
    });

    it('clear() revokes everything', () => {
        const c = new BlobUrlCache(1000, 10);
        c.put('a', 'blob:a', 1); c.put('b', 'blob:b', 1);
        c.clear();
        expect(revoked.sort()).toEqual(['blob:a', 'blob:b']);
        expect(c.stats().entries).toBe(0);
    });

    it('remembers intrinsic size for a remount to reserve the box', () => {
        const c = new BlobUrlCache(1000, 10);
        c.put('a', 'blob:a', 1);
        c.setSize('a', 640, 480);
        expect(c.peek('a')).toMatchObject({ width: 640, height: 480 });
    });
});

describe('base64ToBytes / bytesFromBinaryPayload', () => {
    it('decodes the same bytes as the old per-character decoder', () => {
        const raw = new Uint8Array(4096);
        for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + 7) & 0xff;
        let bin = ''; for (const b of raw) bin += String.fromCharCode(b);
        const b64 = btoa(bin);
        const old = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
        expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(old));
        expect(Array.from(bytesFromBinaryPayload({ mimeType: 'image/gif', b64 }))).toEqual(Array.from(old));
    });

    it('accepts raw bytes so main can stop base64-encoding', () => {
        const buf = new Uint8Array([1, 2, 3]).buffer;
        expect(Array.from(bytesFromBinaryPayload({ mimeType: 'x', bytes: buf }))).toEqual([1, 2, 3]);
        const u8 = new Uint8Array([4, 5]);
        expect(bytesFromBinaryPayload({ mimeType: 'x', bytes: u8 })).toBe(u8);
    });
});

describe('renderMemo', () => {
    it('shallowArrayEqual compares elements by identity', () => {
        const o = {};
        expect(shallowArrayEqual([1, o, 'a'], [1, o, 'a'])).toBe(true);
        expect(shallowArrayEqual([1, {}], [1, {}])).toBe(false);
        expect(shallowArrayEqual([1], [1, 2])).toBe(false);
        expect(shallowArrayEqual([NaN], [NaN])).toBe(true);
    });

    it('shallowValueEqual: arrays, sets, plain objects; depth 2 for rebuilt id arrays', () => {
        expect(shallowValueEqual([], [])).toBe(true);
        expect(shallowValueEqual({ a: 1 }, { a: 1 })).toBe(true);
        expect(shallowValueEqual({ a: 1 }, { a: 2 })).toBe(false);
        expect(shallowValueEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true);
        const p1 = { saved: ['x'], ret: 'never' };
        const p2 = { saved: ['x'], ret: 'never' };
        expect(shallowValueEqual(p1, p2)).toBe(false);       // depth 1: new array
        expect(shallowValueEqual(p1, p2, 2)).toBe(true);     // depth 2: same contents
        expect(shallowValueEqual({ saved: ['x'] }, { saved: ['y'] }, 2)).toBe(false);
        class K { a = 1; }
        expect(shallowValueEqual(new K(), new K())).toBe(false); // not plain
    });

    it('mergeIfChanged / setIfChanged keep the old identity when nothing changes', () => {
        const prev = { a: '1', b: '2' };
        expect(mergeIfChanged(prev, { a: '1' })).toBe(prev);
        expect(mergeIfChanged(prev, {})).toBe(prev);
        expect(mergeIfChanged(prev, { a: '9' })).toEqual({ a: '9', b: '2' });
        expect(mergeIfChanged(prev, { c: '3' })).toEqual({ a: '1', b: '2', c: '3' });
        const undef: Record<string, string | undefined> = { a: undefined };
        expect(mergeIfChanged({} as Record<string, string | undefined>, undef)).not.toBe(undef); // key added, even as undefined
        const s = new Set(['d1', 'd2']);
        expect(setIfChanged(s, ['d2', 'd1'])).toBe(s);
        expect(setIfChanged(s, ['d1'])).not.toBe(s);
        expect(setIfChanged(s, ['d1', 'd3'])).not.toBe(s);
    });

});
