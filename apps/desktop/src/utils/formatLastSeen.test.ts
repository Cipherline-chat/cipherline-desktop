import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatLastSeen } from './formatLastSeen';

const NOW = new Date('2026-11-16T12:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const M = 60_000, H = 60 * M, D = 24 * H;

describe('formatLastSeen', () => {
    afterEach(() => vi.useRealTimers());
    const at = (ms: number) => { vi.useFakeTimers(); vi.setSystemTime(NOW); return formatLastSeen(ago(ms)); };

    it('compact "Last seen X ago", never "Offline"', () => {
        expect(at(10_000)).toBe('Last seen just now');
        expect(at(5 * M)).toBe('Last seen 5m ago');
        expect(at(20 * H)).toBe('Last seen 20h ago');
        expect(at(30 * H)).toBe('Last seen yesterday');
        expect(at(3 * D)).toBe('Last seen 3d ago');
        expect(at(14 * D)).toBe('Last seen 2w ago');
        expect(at(100 * D)).toBe('Last seen 3mo ago');
        expect(at(400 * D)).toBe('Last seen 1y ago');
        for (const ms of [10_000, 5 * M, 20 * H, 3 * D, 400 * D]) expect(at(ms)).not.toMatch(/Offline/);
    });

    it('null for missing, invalid or future timestamps', () => {
        expect(formatLastSeen(null)).toBeNull();
        expect(formatLastSeen('nope')).toBeNull();
        vi.useFakeTimers(); vi.setSystemTime(NOW);
        expect(formatLastSeen(new Date(NOW + H).toISOString())).toBeNull();
    });
});
