import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

describe('encryption-at-rest warning', () => {
    it('is no longer a fixed overlay in App.tsx (it covered the title area and banners)', () => {
        const app = read('../App.tsx');
        expect(app).not.toContain('Encryption at rest is unavailable');
        expect(app).not.toMatch(/position:\s*'fixed',\s*top:\s*32/);
    });

    it('lives in the Dashboard banner stack, in flow, and is dismissible', () => {
        const dash = read('./Dashboard.tsx');
        expect(dash).toContain('<EncryptionAtRestNotice />');
        const src = read('./EncryptionAtRestNotice.tsx');
        expect(src).not.toMatch(/position:\s*'fixed'/);
        expect(src).toContain("masterKeyStatus() !== 'absent'");
        expect(src).toContain('setDismissed(true)');
    });
});
