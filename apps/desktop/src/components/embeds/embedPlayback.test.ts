import { describe, it, expect, vi } from 'vitest';
import { PlaybackScope } from './embedPlayback';

describe('PlaybackScope: one playing embed per chat view', () => {
    it('a claim replaces the previous holder and notifies subscribers', () => {
        const s = new PlaybackScope();
        const seen: (string | null)[] = [];
        s.subscribe(() => seen.push(s.current()));
        s.claim('a');
        s.claim('b');
        expect(s.current()).toBe('b');
        expect(seen).toEqual(['a', 'b']);
    });

    it('re-claiming is a no-op; releasing someone else\'s claim does nothing', () => {
        const s = new PlaybackScope();
        const fn = vi.fn();
        s.subscribe(fn);
        s.claim('a');
        s.claim('a');
        s.release('b');
        expect(s.current()).toBe('a');
        expect(fn).toHaveBeenCalledTimes(1);
        s.release('a');
        expect(s.current()).toBeNull();
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('unsubscribe stops notifications', () => {
        const s = new PlaybackScope();
        const fn = vi.fn();
        const off = s.subscribe(fn);
        off();
        s.claim('a');
        expect(fn).not.toHaveBeenCalled();
    });
});
