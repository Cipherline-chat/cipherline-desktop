import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertRemoteImageUrlShape, MAX_REMOTE_IMAGE_URL_LENGTH } from './net-guard';

describe('net:fetch-binary URL shape (E-4, partial)', () => {
    it('refuses plain http, other schemes, credentials and oversized beacon URLs', () => {
        for (const bad of [
            'http://example.com/a.png', 'ftp://example.com/a.png', 'file:///etc/passwd', 'data:image/png;base64,AA',
            'https://user:pw@example.com/a.png', `https://example.com/a.png?d=${'x'.repeat(MAX_REMOTE_IMAGE_URL_LENGTH)}`,
            '', 42, null,
        ]) {
            expect(() => assertRemoteImageUrlShape(bad), String(bad).slice(0, 40)).toThrow();
        }
    });

    it('positive control: ordinary https image links pass and come back parsed', () => {
        expect(assertRemoteImageUrlShape('https://i.imgur.com/abc.gif')).toBe('https://i.imgur.com/abc.gif');
        expect(assertRemoteImageUrlShape('HTTPS://Pbs.Twimg.com/media/x?format=jpg&name=small'))
            .toBe('https://pbs.twimg.com/media/x?format=jpg&name=small');
    });

    it('main.ts applies it on every hop (redirects recurse through fetchImagePinned)', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        const i = main.indexOf('async function fetchImagePinned(');
        const body = main.slice(i, i + 2200);
        expect(body).toContain('const rawUrl = assertRemoteImageUrlShape(requestedUrl);');
        expect(body).toContain('const req = https.request(rawUrl, {');
        expect(body).toContain('fetchImagePinned(next, redirectsLeft - 1)');
    });
});
