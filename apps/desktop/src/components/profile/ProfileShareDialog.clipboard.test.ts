/**
 * "Copy image" on Share your profile did nothing in the app: it called
 * navigator.clipboard.write directly, and Electron's permission handler
 * (electron/main.ts) refuses that web permission, so every click hit the
 * error. It must go through the shared copyImageBlob helper, which falls back
 * to the preload bridge (clipboard:write-image) that main actually serves.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');

describe('Share your profile: Copy image', () => {
    const dialog = src('src/components/profile/ProfileShareDialog.tsx');

    it('copies through the shared helper (web API, then the preload bridge)', () => {
        expect(dialog).toMatch(/import \{ copyImageBlob \} from '\.\.\/\.\.\/utils\/copyImage'/);
        expect(dialog).toMatch(/await copyImageBlob\(blob\)/);
    });

    it('never calls the web clipboard API itself (the app refuses it)', () => {
        expect(dialog).not.toMatch(/navigator\.clipboard\.write\(/);
    });

    it('positive control: main really does refuse it, and serves the bridge', () => {
        const main = src('electron/main.ts');
        expect(main).toMatch(/ipcMain\.handle\('clipboard:write-image'/);
        expect(main).not.toMatch(/permission === 'clipboard-sanitized-write'/);
    });
});
