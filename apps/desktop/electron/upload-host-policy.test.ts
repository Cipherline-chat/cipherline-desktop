import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkUploadUrl, devUploadHosts, MEDIA_UPLOAD_HOSTS } from './upload-host-policy';

const PROD = { allowDev: false } as const;
const DEV = { allowDev: true, devHosts: ['cipherline.chat'] } as const;
const PRESIGNED = 'https://media.cipherline.chat/cipherline/abc123?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';

describe('net:stream-upload destination policy', () => {
    it('the media host is the only configured upload host', () => {
        expect(MEDIA_UPLOAD_HOSTS).toEqual(['media.cipherline.chat']);
    });

    it('accepts the presigned media URL (prod, staging and dev compose all sign against it)', () => {
        for (const opts of [PROD, DEV]) {
            const v = checkUploadUrl(PRESIGNED, opts);
            expect(v.ok).toBe(true);
            if (v.ok) expect(v.url.hostname).toBe('media.cipherline.chat');
        }
        expect(checkUploadUrl('https://MEDIA.Cipherline.Chat:443/b/k?sig=1', PROD).ok).toBe(true);
    });

    it.each([
        ['an attacker host', 'https://attacker.example/upload'],
        ['another public Cipherline host', 'https://api.cipherline.chat/v1/x'],
        ['a lookalike suffix', 'https://media.cipherline.chat.evil.example/x'],
        ['a lookalike prefix', 'https://evilmedia.cipherline.chat/x'],
        ['a sibling subdomain', 'https://x.media.cipherline.chat/x'],
        ['userinfo that names the media host', 'https://media.cipherline.chat@evil.example/x'],
        ['userinfo on the media host itself', 'https://user:pw@media.cipherline.chat/x'],
        ['an IP literal', 'https://203.0.113.9/x'],
        ['a Google Cloud Storage bucket', 'https://storage.googleapis.com/bucket/obj'],
        ['a private address (SSRF)', 'https://192.168.1.10/x'],
    ])('refuses %s', (_name, url) => {
        expect(checkUploadUrl(url, PROD).ok).toBe(false);
    });

    it('refuses plain http to the media host, and any non-default port', () => {
        expect(checkUploadUrl('http://media.cipherline.chat/x', PROD)).toEqual({ ok: false, reason: 'scheme' });
        expect(checkUploadUrl('https://media.cipherline.chat:8443/x', PROD)).toEqual({ ok: false, reason: 'port' });
    });

    it.each([undefined, null, 5, {}, '', 'not a url', 'ftp://media.cipherline.chat/x', 'file:///etc/passwd', 'javascript:alert(1)',
        'https://media.cipherline.chat/' + 'a'.repeat(5000)])('refuses a malformed or non-http(s) input: %s', (raw) => {
        expect(checkUploadUrl(raw, PROD).ok).toBe(false);
    });

    describe('dev (unpackaged build with a dev server) - never in a packaged build', () => {
        it('adds loopback and the dev server host, over http or https, any port', () => {
            expect(checkUploadUrl('http://localhost:9000/cipherline/k?sig=1', DEV).ok).toBe(true);
            expect(checkUploadUrl('http://127.0.0.1:9000/k', DEV).ok).toBe(true);
            expect(checkUploadUrl('http://cipherline.chat:9000/k', DEV).ok).toBe(true);
        });
        it('the same URLs are refused in a packaged build', () => {
            expect(checkUploadUrl('http://localhost:9000/cipherline/k?sig=1', PROD).ok).toBe(false);
            expect(checkUploadUrl('http://cipherline.chat:9000/k', PROD).ok).toBe(false);
        });
        it('still refuses arbitrary hosts and userinfo tricks', () => {
            expect(checkUploadUrl('https://attacker.example/x', DEV).ok).toBe(false);
            expect(checkUploadUrl('http://localhost@attacker.example/x', DEV).ok).toBe(false);
            expect(checkUploadUrl('http://localhost.attacker.example/x', DEV).ok).toBe(false);
        });
        it('devUploadHosts reads the host out of the dev server URL and the API host override', () => {
            expect(devUploadHosts('http://cipherline.chat:5174', 'localhost:3005')).toEqual(['cipherline.chat', 'localhost']);
            expect(devUploadHosts(undefined, undefined)).toEqual([]);
            expect(devUploadHosts('not a url', '::bad::')).toEqual([]);
        });
    });
});

describe('wiring: the handler uses the policy before any network I/O', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const handler = main.slice(main.indexOf("ipcMain.handle('net:stream-upload'"), main.indexOf('// ── Chunk-based streaming encryption'));

    it('checks the source file, then the destination, then connects', () => {
        const src = handler.indexOf('assertUploadableTempFile(filePath)');
        const dest = handler.indexOf('checkUploadUrl(url');
        const net = handler.indexOf('assertPublicHttpUrl(url)');
        const req = handler.indexOf('https.request(url');
        expect(src).toBeGreaterThan(-1);
        expect(dest).toBeGreaterThan(src);
        expect(net).toBeGreaterThan(dest);
        expect(req).toBeGreaterThan(dest);
    });
    it('the dev allowance is gated on an unpackaged build with a dev server', () => {
        expect(handler).toContain('const isDev = !app.isPackaged && !!DEV_SERVER_URL;');
        expect(handler).toContain('allowDev: isDev');
    });
    it('declared size must equal the file size, and the request body shape is validated', () => {
        expect(handler).toContain('fs.statSync(filePath).size !== size');
        expect(handler).toContain("throw new Error('Invalid upload request')");
    });
});
