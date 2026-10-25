import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseInviteUrl, parseReferralUrl, extractDeepLinkFromArgv, externalUrlToOpen } from './deep-link';

describe('deep links (E-11)', () => {
    it('refuses codes outside the invite charset, oversized links and decorated URLs', () => {
        for (const bad of [
            'cipherline://invite/', 'cipherline://invite/ab', 'cipherline://invite/<script>', 'cipherline://invite/a%20b',
            'cipherline://invite/abc/def', 'cipherline://invite/abcd?x=1', 'cipherline://invite/abcd#x',
            `cipherline://invite/${'a'.repeat(65)}`, `cipherline://invite/${'a'.repeat(600)}`,
            'cipherline://invite/..%2F..%2Fx', 'https://cipherline.chat/invite/abcd', 'cipherline://other/abcd',
            'cipherline://user:pw@invite/abcd', null, 42,
        ]) {
            expect(parseInviteUrl(bad), String(bad)).toBeNull();
        }
        expect(parseReferralUrl('cipherline://ref/ab"cd')).toBeNull();
    });

    it('positive control: real invite and referral links still parse', () => {
        expect(parseInviteUrl('cipherline://invite/Ab3_-xY9zQk')).toBe('Ab3_-xY9zQk');
        expect(parseInviteUrl('cipherline://invite/Ab3_-xY9zQk/')).toBe('Ab3_-xY9zQk');
        expect(parseReferralUrl('cipherline://ref/a1b2c3d4')).toBe('A1B2C3D4');
    });

    it('argv: only a clean URL argument is taken; switches are never interpreted', () => {
        expect(extractDeepLinkFromArgv(['Cipherline.exe', '--', 'cipherline://invite/abcd'])).toBe('cipherline://invite/abcd');
        expect(extractDeepLinkFromArgv(['Cipherline.exe', 'cipherline://invite/ab" --gpu-launcher="x'])).toBeNull();
        expect(extractDeepLinkFromArgv(['Cipherline.exe', '--gpu-launcher=cipherline://x'])).toBeNull();
        expect(extractDeepLinkFromArgv(['Cipherline.exe'])).toBeNull();
    });

    it('open-external launches the parsed href, https/mailto only', () => {
        expect(externalUrlToOpen('https://cipherline.chat/a b')).toBe('https://cipherline.chat/a%20b');
        expect(externalUrlToOpen('HTTPS://Cipherline.Chat/x')).toBe('https://cipherline.chat/x');
        expect(externalUrlToOpen('mailto:support@cipherline.chat')).toBe('mailto:support@cipherline.chat');
        for (const bad of ['http://cipherline.chat', 'file:///etc/passwd', 'javascript:alert(1)', 'ms-settings:', 'https://u:p@evil.example/', '', 3]) {
            expect(externalUrlToOpen(bad), String(bad)).toBeNull();
        }
    });

    it('main.ts uses these helpers and opens the parsed href', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        expect(main).toContain("from './deep-link'");
        expect(main).not.toMatch(/^function parseInviteUrl/m);
        const i = main.indexOf("ipcMain.handle('shell:open-external'");
        const body = main.slice(i, i + 250);
        expect(body).toContain('externalUrlToOpen(url)');
        expect(body).toContain('shell.openExternal(href)');
    });
});
