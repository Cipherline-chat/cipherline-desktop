import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Google's consent screen shows the Drive scope as an UNCHECKED box, and Continue
// with it unticked still yields a token (email only). startOAuth must notice and
// refuse to store it, rather than look "connected" and 403 on every backup.

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: {} }));
vi.mock('./storage', () => ({ secureStore: { initialize: vi.fn(), get: vi.fn(), set: vi.fn(), delete: vi.fn() } }));

import { driveAccessWasGranted, DRIVE_ACCESS_NOT_GRANTED_MESSAGE } from './googleDriveAuth';

const DRIVE = 'https://www.googleapis.com/auth/drive.file';

describe('driveAccessWasGranted', () => {
    it('is true when drive.file is among the granted scopes', () => {
        expect(driveAccessWasGranted(`email ${DRIVE}`)).toBe(true);
        expect(driveAccessWasGranted(`openid https://www.googleapis.com/auth/userinfo.email ${DRIVE}`)).toBe(true);
    });

    it('accepts the OLD broader grant (it contains drive.file) so existing connections are unaffected', () => {
        expect(driveAccessWasGranted(`email ${DRIVE} https://www.googleapis.com/auth/drive.metadata.readonly`)).toBe(true);
    });

    it('is false when the box was left unticked (email-only grant)', () => {
        expect(driveAccessWasGranted('email')).toBe(false);
        expect(driveAccessWasGranted('openid https://www.googleapis.com/auth/userinfo.email')).toBe(false);
    });

    it('does not match a longer scope that merely starts with drive.file', () => {
        expect(driveAccessWasGranted(`email ${DRIVE}.readonly`)).toBe(false);
    });

    it('does not block when Google omits the scope field', () => {
        expect(driveAccessWasGranted(undefined)).toBe(true);
        expect(driveAccessWasGranted('')).toBe(true);
    });
});

describe('startOAuth wiring', () => {
    const src = readFileSync(join(__dirname, 'googleDriveAuth.ts'), 'utf8');

    it('checks the grant before persisting anything, and throws the user-facing message', () => {
        const check = src.indexOf('if (!driveAccessWasGranted(tokenResp.scope))');
        expect(check).toBeGreaterThan(-1);
        expect(src.indexOf("secureStore.set(KEYS.accessToken")).toBeGreaterThan(check);
        expect(src.slice(check, check + 400)).toContain('throw new Error(DRIVE_ACCESS_NOT_GRANTED_MESSAGE)');
    });

    it('tells the user to tick the box', () => {
        expect(DRIVE_ACCESS_NOT_GRANTED_MESSAGE).toMatch(/tick the box/i);
    });
});
