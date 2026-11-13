import { describe, it, expect } from 'vitest';
import { formatPlayTime, formatUnlockMonth, unlockToastText } from './format';

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
    it('one unlock names it; several that land together share one toast', () => {
        expect(unlockToastText([])).toBeNull();
        expect(unlockToastText([{ name: 'Shell Seeker', description: 'Find your first easter egg.' }]))
            .toEqual({ title: 'Achievement unlocked: Shell Seeker', message: 'Find your first easter egg.' });
        expect(unlockToastText([{ name: 'Message in a Bottle', description: 'a' }, { name: 'Shell Seeker', description: 'b' }]))
            .toEqual({ title: '2 achievements unlocked', message: 'Message in a Bottle · Shell Seeker' });
    });
});

describe('boot toast gathering', () => {
    it('everything unlocked at launch shares ONE combined toast', async () => {
        const { unlockToastText } = await import('./format');
        const t = unlockToastText([{ name: 'Message in a Bottle', description: '' }, { name: 'New Face', description: '' }, { name: 'Handshake', description: '' }]);
        expect(t?.title).toBe('3 achievements unlocked');
        expect(t?.message).toBe('Message in a Bottle · New Face · Handshake');
    });
    it('the wait stretches to the end of the boot window, never below the normal gather window', async () => {
        const { unlockToastDelayMs, UNLOCK_TOAST_GATHER_MS, BOOT_TOAST_GATHER_MS } = await import('./format');
        expect(unlockToastDelayMs(1_000, 1_000 + BOOT_TOAST_GATHER_MS)).toBe(BOOT_TOAST_GATHER_MS);
        expect(unlockToastDelayMs(1_000 + 4_000, 1_000 + BOOT_TOAST_GATHER_MS)).toBe(2_000);
        expect(unlockToastDelayMs(1_000 + 60_000, 1_000 + BOOT_TOAST_GATHER_MS)).toBe(UNLOCK_TOAST_GATHER_MS);
    });
});
