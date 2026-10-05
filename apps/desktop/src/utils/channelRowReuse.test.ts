import { describe, it, expect } from 'vitest';
import { splitReusableChannelRows } from './channelRowReuse';

describe('splitReusableChannelRows', () => {
    const real = (id: string) => ({ id, content: { type: 'text', text: id } });
    const placeholder = (id: string) => ({ id, content: { type: 'system', kind: 'encrypted' } });

    it('reuses ids cached as real content, decrypts the rest', () => {
        const raw = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'edit-1' }];
        const cached = [real('a'), placeholder('b')];
        const { reused, toDecrypt } = splitReusableChannelRows(raw, cached);
        expect(reused).toEqual([cached[0]]);
        // b must be decrypted again so a placeholder can heal; c is new; the
        // edit envelope was never cached as a row and is always re-applied.
        expect(toDecrypt.map(r => r.id)).toEqual(['b', 'c', 'edit-1']);
    });

    it('with no cache, decrypts everything', () => {
        const raw = [{ id: 'a' }];
        expect(splitReusableChannelRows(raw, undefined)).toEqual({ reused: [], toDecrypt: raw });
        expect(splitReusableChannelRows(raw, [])).toEqual({ reused: [], toDecrypt: raw });
    });
});
