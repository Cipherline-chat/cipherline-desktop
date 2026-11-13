/**
 * A received high five showed twice: the overlay ("High five from <name>")
 * AND a closable toast. The owner wants only the overlay.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

describe('incoming high five: one notification', () => {
    it('plays the overlay and does not also raise a toast', () => {
        const hook = read('hooks/useProfileMoments.ts');
        const onFive = hook.slice(hook.indexOf('const onFive'), hook.indexOf('window.addEventListener(HIGH_FIVE_EVENT'));
        expect(onFive).toMatch(/HIGH_FIVE_PLAY_EVENT/);
        expect(onFive).not.toMatch(/toastRef\.current\(/);
        expect(onFive).not.toMatch(/high-fived you/);
    });

    it('positive control: the overlay itself names who sent it and is announced', () => {
        const overlay = read('components/HighFiveOverlay.tsx');
        expect(overlay).toMatch(/High five from \{play\.from\}/);
        expect(overlay).toMatch(/aria-live="polite"/);
    });
});
