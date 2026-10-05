import { describe, it, expect } from 'vitest';
import {
    onUpdateAvailable,
    onDownloadProgress,
    onUpdateDownloaded,
    onUpdateError,
    pickDownloadUrl,
    UPDATE_BASE_URL,
    type UpdateState,
} from '../../electron/updater-state';

/**
 * This module exists to prevent one specific failure: a user on an unsigned
 * macOS build (or a de-AppImaged Linux install) waits forever for a green
 * dot that electron-updater is silently never going to produce, because the
 * app never told them it can't self-install. Every test below is either
 * proving that degrades cleanly to a manual link, or proving the OPPOSITE
 * failure doesn't happen — a transient network blip must not manufacture a
 * false "update available" out of thin air.
 */

const info = (version: string, files: { url: string }[] = []) => ({ version, files });

describe('update lifecycle', () => {
    it('idle -> available on update-available', () => {
        const s = onUpdateAvailable(info('2.0.0'));
        expect(s).toEqual({ phase: 'available', version: '2.0.0' });
    });

    it('available -> downloading on progress, carrying the version forward', () => {
        const s = onDownloadProgress({ phase: 'available', version: '2.0.0' }, { percent: 40 });
        expect(s).toEqual({ phase: 'downloading', version: '2.0.0', percent: 40 });
    });

    it('downloading -> downloading updates percent in place', () => {
        const s = onDownloadProgress({ phase: 'downloading', version: '2.0.0', percent: 40 }, { percent: 91.7 });
        expect(s).toEqual({ phase: 'downloading', version: '2.0.0', percent: 91.7 });
    });

    it('clamps an out-of-range percent rather than trusting the event', () => {
        expect(onDownloadProgress({ phase: 'available', version: '1' }, { percent: 142 }))
            .toMatchObject({ percent: 100 });
        expect(onDownloadProgress({ phase: 'available', version: '1' }, { percent: -3 }))
            .toMatchObject({ percent: 0 });
    });

    it('ignores a stray progress event once ready — no resurrected progress bar', () => {
        const ready: UpdateState = { phase: 'ready', version: '2.0.0' };
        expect(onDownloadProgress(ready, { percent: 50 })).toBe(ready);
    });

    it('ignores a stray progress event in manual state', () => {
        const manual: UpdateState = { phase: 'manual', version: '2.0.0', downloadUrl: 'https://x/y.dmg' };
        expect(onDownloadProgress(manual, { percent: 50 })).toBe(manual);
    });

    it('-> ready on update-downloaded, taking the version from the event', () => {
        // Deliberately NOT threading `current` in — must be correct even if a
        // progress event was dropped and `current` never reached 'downloading'.
        expect(onUpdateDownloaded(info('2.0.0'))).toEqual({ phase: 'ready', version: '2.0.0' });
    });

    describe('error handling — the whole point of this module', () => {
        const alwaysUrl = (v: string) => `https://updates.cipherline.chat/app-${v}.dmg`;
        const neverUrl = () => null;

        it('an error with an update in flight (available) degrades to manual', () => {
            const s = onUpdateError({ phase: 'available', version: '2.0.0' }, alwaysUrl);
            expect(s).toEqual({ phase: 'manual', version: '2.0.0', downloadUrl: 'https://updates.cipherline.chat/app-2.0.0.dmg' });
        });

        it('an error mid-download also degrades to manual, keeping the version', () => {
            const s = onUpdateError({ phase: 'downloading', version: '2.0.0', percent: 61 }, alwaysUrl);
            expect(s).toEqual({ phase: 'manual', version: '2.0.0', downloadUrl: 'https://updates.cipherline.chat/app-2.0.0.dmg' });
        });

        it('an error with NO known update (idle) stays idle — no false positive', () => {
            expect(onUpdateError({ phase: 'idle' }, alwaysUrl)).toEqual({ phase: 'idle' });
        });

        it('an error while already ready is swallowed to idle, not left stuck', () => {
            // A late background re-check failing after the update already
            // finished downloading carries no information worth acting on.
            expect(onUpdateError({ phase: 'ready', version: '2.0.0' }, alwaysUrl)).toEqual({ phase: 'idle' });
        });

        it('an error while already manual is swallowed to idle, not re-manualed', () => {
            const manual: UpdateState = { phase: 'manual', version: '2.0.0', downloadUrl: 'https://x/y.dmg' };
            expect(onUpdateError(manual, alwaysUrl)).toEqual({ phase: 'idle' });
        });

        it('falls back to idle (never a dead button) when no download URL can be built', () => {
            expect(onUpdateError({ phase: 'available', version: '2.0.0' }, neverUrl)).toEqual({ phase: 'idle' });
        });
    });
});

describe('pickDownloadUrl', () => {
    const macFiles = [
        { url: 'Cipherline-2.0.0-arm64-mac.zip' },
        { url: 'Cipherline-2.0.0-mac.zip' },
        { url: 'Cipherline-2.0.0-arm64.dmg' },
        { url: 'Cipherline-2.0.0.dmg' },
    ];
    const linuxFiles = [{ url: 'Cipherline-2.0.0.AppImage' }];
    const winFiles = [{ url: 'Cipherline-Setup-2.0.0.exe' }];

    it('picks the arm64 dmg on Apple Silicon', () => {
        expect(pickDownloadUrl(macFiles, 'darwin', 'arm64'))
            .toBe(`${UPDATE_BASE_URL}/Cipherline-2.0.0-arm64.dmg`);
    });

    it('picks the untagged dmg on Intel', () => {
        expect(pickDownloadUrl(macFiles, 'darwin', 'x64'))
            .toBe(`${UPDATE_BASE_URL}/Cipherline-2.0.0.dmg`);
    });

    it('never hands out the .zip when a matching .dmg exists', () => {
        const url = pickDownloadUrl(macFiles, 'darwin', 'arm64')!;
        expect(url.endsWith('.zip')).toBe(false);
    });

    it('falls back to any .dmg when the arch tag is unrecognised', () => {
        expect(pickDownloadUrl(macFiles, 'darwin', 'ia32')).toBe(`${UPDATE_BASE_URL}/Cipherline-2.0.0-arm64.dmg`);
    });

    it('falls back to .zip when no .dmg is published at all', () => {
        const zipOnly = [{ url: 'Cipherline-2.0.0-mac.zip' }];
        expect(pickDownloadUrl(zipOnly, 'darwin', 'x64')).toBe(`${UPDATE_BASE_URL}/Cipherline-2.0.0-mac.zip`);
    });

    it('picks the AppImage on Linux regardless of arch (only one is published today)', () => {
        expect(pickDownloadUrl(linuxFiles, 'linux', 'arm64')).toBe(`${UPDATE_BASE_URL}/Cipherline-2.0.0.AppImage`);
        expect(pickDownloadUrl(linuxFiles, 'linux', 'x64')).toBe(`${UPDATE_BASE_URL}/Cipherline-2.0.0.AppImage`);
    });

    it('picks the .exe on Windows', () => {
        expect(pickDownloadUrl(winFiles, 'win32', 'x64')).toBe(`${UPDATE_BASE_URL}/Cipherline-Setup-2.0.0.exe`);
    });

    it('returns null rather than a bare base-URL guess when the manifest has nothing plausible', () => {
        expect(pickDownloadUrl([{ url: 'Cipherline-2.0.0.blockmap' }], 'darwin', 'arm64')).toBeNull();
    });

    it('returns null for an empty file list', () => {
        expect(pickDownloadUrl([], 'darwin', 'arm64')).toBeNull();
    });

    it('returns null for an unhandled platform', () => {
        expect(pickDownloadUrl(macFiles, 'freebsd' as NodeJS.Platform, 'x64')).toBeNull();
    });

    it('every resolved URL is a same-origin absolute URL under UPDATE_BASE_URL', () => {
        const cases: Array<[{ url: string }[], NodeJS.Platform, string]> = [
            [macFiles, 'darwin', 'arm64'],
            [linuxFiles, 'linux', 'x64'],
            [winFiles, 'win32', 'x64'],
        ];
        for (const [files, platform, arch] of cases) {
            const url = pickDownloadUrl(files, platform, arch)!;
            expect(new URL(url).origin).toBe(new URL(UPDATE_BASE_URL).origin);
        }
    });
});
