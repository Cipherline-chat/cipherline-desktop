/**
 * KDE's file manager is called `dolphin`, the same as Dolphin Emulator's
 * Windows / macOS executable, so every Plasma user showed as "Playing Dolphin
 * Emulator" all day (owner report, CachyOS, 2026-11-04).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isPlatformExcludedProcess, procCmdlineName } from './game-detector';

const SRC = readFileSync(resolve(__dirname, 'game-detector.ts'), 'utf8');

describe('dolphin: a file manager on Linux, an emulator elsewhere', () => {
    it('is excluded on Linux only', () => {
        expect(isPlatformExcludedProcess('dolphin', 'linux')).toBe(true);
        expect(isPlatformExcludedProcess('dolphin', 'win32')).toBe(false);
        expect(isPlatformExcludedProcess('dolphin', 'darwin')).toBe(false);
    });

    it('KDE Dolphin as Linux reads it (/usr/bin/dolphin) is the excluded name', () => {
        const name = procCmdlineName('/usr/bin/dolphin\0--new-window\0');
        expect(name).toBe('dolphin');
        expect(isPlatformExcludedProcess(name, 'linux')).toBe(true);
    });

    it('the emulator\'s own Linux binaries still map to Dolphin Emulator', () => {
        for (const bin of ['dolphin-emu', 'dolphin-emu-qt2', 'dolphin-emu-nogui']) {
            expect(SRC).toMatch(new RegExp(`'${bin}':\\s+'Dolphin Emulator'`));
            expect(isPlatformExcludedProcess(bin, 'linux')).toBe(false);
        }
    });

    it('the detector consults the platform list after custom games and before every match layer', () => {
        const loop = SRC.slice(SRC.indexOf('// Layer 1: User custom games'), SRC.indexOf('// Layer 2: Steam library'));
        expect(loop).toContain('if (isPlatformExcludedProcess(proc, process.platform)) continue;');
    });
});
