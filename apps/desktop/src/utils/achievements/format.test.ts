import { describe, it, expect } from 'vitest';
import { formatPlayTime, formatUnlockMonth } from './format';

describe('format', () => {
    it('formats the unlock month and leaves malformed input alone', () => {
        expect(formatUnlockMonth('2026-10')).toBe('Oct 2026');
        expect(formatUnlockMonth('2026-13')).toBe('2026-13');
    });
    it('formats play time', () => {
        expect(formatPlayTime(0)).toBe('1 min');
        expect(formatPlayTime(45)).toBe('45 min');
        expect(formatPlayTime(90)).toBe('1.5 h');
        expect(formatPlayTime(120)).toBe('2 h');
        expect(formatPlayTime(60 * 25)).toBe('25 h');
    });
});
