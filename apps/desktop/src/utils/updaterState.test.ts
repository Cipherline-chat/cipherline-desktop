import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
    onUpdateAvailable,
    onDownloadProgress,
    onUpdateDownloaded,
    onUpdateNotAvailable,
    onUpdateError,
    onInstallError,
    classifyUpdateError,
    isUpdateInFlight,
    parseUpdaterCacheDirName,
    pendingUpdateCacheDir,
    updaterErrorDetail,
    toDiagnosticDetail,
    pickDownloadUrl,
    RETRY_DELAYS_MS,
    UPDATE_BASE_URL,
    type UpdateState,
    type UpdateErrorContext,
} from '../../electron/updater-state';
import { DETAIL_RE } from '../../electron/freeze-monitor';

/**
 * The policy under test (owner, 2026-10-09): an update ALWAYS completes in the
 * app. Before this, any error after `update-available` sent the user to a
 * browser download (staging.157 report). Every test below pins one half of
 * that: a failure is retried in-app with backoff and ends in an in-app
 * Retry state on Windows and macOS — and a transient network blip with no
 * update in flight still never manufactures a false "update available".
 */

// ── The renderer's mirror (env.d.ts) must stay identical to the real type ──
// Checked by `tsc -p tsconfig.app.json` (this file is under src/); the runtime
// assertion below only makes the check visible in the test report.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const RENDERER_MIRROR_MATCHES: Equals<UpdateState, UpdateStateShape> = true;

const info = (version: string, files: { url: string }[] = []) => ({ version, files });
const NOW = 1_800_000_000_000;
const ctx = (over: Partial<UpdateErrorContext> = {}): UpdateErrorContext => ({
    kind: 'transient',
    failures: 1,
    platform: 'win32',
    now: NOW,
    buildDownloadUrl: (v) => `${UPDATE_BASE_URL}/Cipherline-${v}.AppImage`,
    ...over,
});

describe('renderer mirror', () => {
    it('env.d.ts UpdateStateShape is exactly electron/updater-state.ts UpdateState', () => {
        expect(RENDERER_MIRROR_MATCHES).toBe(true);
    });
});

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

    it('ignores a stray progress event once ready, retrying or failed — no resurrected progress bar', () => {
        const stuck: UpdateState[] = [
            { phase: 'ready', version: '2.0.0' },
            { phase: 'retrying', version: '2.0.0', attempt: 1, maxAttempts: 3, retryAt: NOW },
            { phase: 'failed', version: '2.0.0', stage: 'download' },
            { phase: 'manual', version: '2.0.0', downloadUrl: 'https://x/y.AppImage' },
        ];
        for (const s of stuck) expect(onDownloadProgress(s, { percent: 50 })).toBe(s);
    });

    it('-> ready on update-downloaded, taking the version from the event', () => {
        // Deliberately NOT threading `current` in — must be correct even if a
        // progress event was dropped and `current` never reached 'downloading'.
        expect(onUpdateDownloaded(info('2.0.0'))).toEqual({ phase: 'ready', version: '2.0.0' });
    });

    it('update-not-available stands an in-flight / failed attempt down, but never discards a downloaded update', () => {
        expect(onUpdateNotAvailable({ phase: 'available', version: '2' })).toEqual({ phase: 'idle' });
        expect(onUpdateNotAvailable({ phase: 'retrying', version: '2', attempt: 1, maxAttempts: 3, retryAt: NOW })).toEqual({ phase: 'idle' });
        expect(onUpdateNotAvailable({ phase: 'failed', version: '2', stage: 'verify' })).toEqual({ phase: 'idle' });
        const ready: UpdateState = { phase: 'ready', version: '2' };
        expect(onUpdateNotAvailable(ready)).toBe(ready);
        const idle: UpdateState = { phase: 'idle' };
        expect(onUpdateNotAvailable(idle)).toBe(idle);
    });

    it('isUpdateInFlight is exactly available / downloading / retrying', () => {
        expect(isUpdateInFlight({ phase: 'available', version: '1' })).toBe(true);
        expect(isUpdateInFlight({ phase: 'downloading', version: '1', percent: 1 })).toBe(true);
        expect(isUpdateInFlight({ phase: 'retrying', version: '1', attempt: 1, maxAttempts: 3, retryAt: 0 })).toBe(true);
        expect(isUpdateInFlight({ phase: 'idle' })).toBe(false);
        expect(isUpdateInFlight({ phase: 'ready', version: '1' })).toBe(false);
        expect(isUpdateInFlight({ phase: 'failed', version: '1', stage: 'download' })).toBe(false);
        expect(isUpdateInFlight({ phase: 'manual', version: '1', downloadUrl: 'x' })).toBe(false);
    });
});

describe('classifyUpdateError — only a real signature verdict stops the retries', () => {
    it('ERR_UPDATER_INVALID_SIGNATURE is a signature failure on every platform', () => {
        for (const p of ['win32', 'darwin', 'linux'] as const) {
            expect(classifyUpdateError({ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'x' }, p)).toBe('signature');
        }
    });

    it('"the check could not run" is NOT a signature failure (it is retried)', () => {
        expect(classifyUpdateError({ code: 'ERR_UPDATER_SIGNATURE_CHECK_UNAVAILABLE', message: 'timed out' }, 'win32')).toBe('transient');
        // electron-updater's own verifier timing out: a bare execFile error, no code.
        expect(classifyUpdateError({ message: 'Command failed: set "PSModulePath=" & chcp 65001 >NUL & powershell.exe ...' }, 'win32')).toBe('transient');
    });

    it('network, checksum, rename and blockmap errors are transient', () => {
        for (const e of [
            { code: 'ECONNRESET', message: 'socket hang up' },
            { code: 'ERR_CHECKSUM_MISMATCH', message: 'sha512 checksum mismatch, expected a, got b' },
            { code: 'EPERM', message: 'EPERM: operation not permitted, rename' },
            { message: 'Cannot download differentially, fallback to full download' },
            { message: 'net::ERR_TIMED_OUT' },
            {},
        ]) {
            expect(classifyUpdateError(e, 'win32')).toBe('transient');
        }
        expect(classifyUpdateError(null, 'win32')).toBe('transient');
        expect(classifyUpdateError(undefined, 'darwin')).toBe('transient');
    });

    it('Squirrel.Mac code-signature rejections are signature failures on macOS only', () => {
        const sq = { message: 'Code signature at URL file:///x/Cipherline.app/ did not pass validation: code has no resources but signature indicates they must be present' };
        expect(classifyUpdateError(sq, 'darwin')).toBe('signature');
        expect(classifyUpdateError({ message: 'The code does not satisfy the designated requirement' }, 'darwin')).toBe('signature');
        // The same words elsewhere are not a Squirrel verdict.
        expect(classifyUpdateError(sq, 'win32')).toBe('transient');
    });
});

describe('onUpdateError — in-app retries, never a browser link on Windows/macOS', () => {
    const inFlight: UpdateState[] = [
        { phase: 'available', version: '2.0.0' },
        { phase: 'downloading', version: '2.0.0', percent: 61 },
        { phase: 'retrying', version: '2.0.0', attempt: 1, maxAttempts: 3, retryAt: NOW - 1 },
    ];

    it('the backoff is 10 s, 60 s, 5 min', () => {
        expect([...RETRY_DELAYS_MS]).toEqual([10_000, 60_000, 300_000]);
    });

    it('each transient failure schedules the next retry, keeping the version', () => {
        for (const current of inFlight) {
            RETRY_DELAYS_MS.forEach((delay, i) => {
                const d = onUpdateError(current, ctx({ failures: i + 1 }));
                expect(d.retryInMs).toBe(delay);
                expect(d.state).toEqual({ phase: 'retrying', version: '2.0.0', attempt: i + 1, maxAttempts: 3, retryAt: NOW + delay });
            });
        }
    });

    it('a failure count below 1 is treated as the first failure (never an undefined delay)', () => {
        expect(onUpdateError(inFlight[0], ctx({ failures: 0 })).retryInMs).toBe(RETRY_DELAYS_MS[0]);
    });

    it('retries exhausted on Windows and macOS -> failed(download), in-app, no URL', () => {
        for (const platform of ['win32', 'darwin'] as const) {
            for (const current of inFlight) {
                const d = onUpdateError(current, ctx({ platform, failures: RETRY_DELAYS_MS.length + 1 }));
                expect(d).toEqual({ state: { phase: 'failed', version: '2.0.0', stage: 'download' }, retryInMs: null });
            }
        }
    });

    it('NO failure count on Windows or macOS ever yields the manual (browser) phase', () => {
        for (const platform of ['win32', 'darwin'] as const) {
            for (const kind of ['transient', 'signature'] as const) {
                for (let failures = 0; failures <= 10; failures++) {
                    for (const current of inFlight) {
                        const d = onUpdateError(current, ctx({ platform, kind, failures }));
                        expect(d.state.phase).not.toBe('manual');
                    }
                }
            }
        }
    });

    it('a signature rejection stops at once -> failed(verify), no automatic retry, on any attempt', () => {
        for (const current of inFlight) {
            for (const failures of [1, 2, 4]) {
                expect(onUpdateError(current, ctx({ kind: 'signature', failures })))
                    .toEqual({ state: { phase: 'failed', version: '2.0.0', stage: 'verify' }, retryInMs: null });
            }
        }
    });

    it('Linux falls back to the manual link only AFTER the retries are spent', () => {
        for (let failures = 1; failures <= RETRY_DELAYS_MS.length; failures++) {
            expect(onUpdateError(inFlight[1], ctx({ platform: 'linux', failures })).state.phase).toBe('retrying');
        }
        expect(onUpdateError(inFlight[1], ctx({ platform: 'linux', failures: 4 }))).toEqual({
            state: { phase: 'manual', version: '2.0.0', downloadUrl: `${UPDATE_BASE_URL}/Cipherline-2.0.0.AppImage` },
            retryInMs: null,
        });
    });

    it('Linux with no plausible download URL ends in-app (failed), never a dead button', () => {
        expect(onUpdateError(inFlight[0], ctx({ platform: 'linux', failures: 4, buildDownloadUrl: () => null })).state)
            .toEqual({ phase: 'failed', version: '2.0.0', stage: 'download' });
    });

    it('a signature rejection on Linux is still failed(verify), not a link', () => {
        expect(onUpdateError(inFlight[0], ctx({ platform: 'linux', kind: 'signature', failures: 9 })).state)
            .toEqual({ phase: 'failed', version: '2.0.0', stage: 'verify' });
    });

    it('an error with NO known update (idle) stays idle — no false positive, no retry', () => {
        expect(onUpdateError({ phase: 'idle' }, ctx())).toEqual({ state: { phase: 'idle' }, retryInMs: null });
        expect(onUpdateError({ phase: 'idle' }, ctx({ kind: 'signature' }))).toEqual({ state: { phase: 'idle' }, retryInMs: null });
    });

    it('a later background-check error keeps ready / failed / manual exactly as they were', () => {
        const keep: UpdateState[] = [
            { phase: 'ready', version: '2.0.0' },
            { phase: 'failed', version: '2.0.0', stage: 'download' },
            { phase: 'manual', version: '2.0.0', downloadUrl: 'https://x/y.AppImage' },
        ];
        for (const s of keep) expect(onUpdateError(s, ctx())).toEqual({ state: s, retryInMs: null });
    });

    it('an installer that cannot start -> failed(install), keeping the version', () => {
        expect(onInstallError({ phase: 'ready', version: '2.0.0' })).toEqual({ phase: 'failed', version: '2.0.0', stage: 'install' });
        expect(onInstallError({ phase: 'idle' })).toEqual({ phase: 'failed', version: '', stage: 'install' });
    });
});

describe('a rejected update MANIFEST (signed-update-provider.ts)', () => {
    it('is classified as manifest on every platform, by code only', () => {
        for (const p of ['win32', 'darwin', 'linux'] as const) {
            expect(classifyUpdateError({ code: 'ERR_UPDATER_MANIFEST_SIGNATURE', message: 'x' }, p)).toBe('manifest');
            expect(classifyUpdateError({ message: 'update manifest latest.yml failed signature verification (invalid)' }, p)).toBe('transient');
        }
    });

    it("shows \"couldn't be verified\" even from idle (it is decided at CHECK time), with no automatic retry", () => {
        expect(onUpdateError({ phase: 'idle' }, ctx({ kind: 'manifest', platform: 'linux' })))
            .toEqual({ state: { phase: 'failed', version: '', stage: 'verify' }, retryInMs: null });
        const from: UpdateState[] = [
            { phase: 'available', version: '2.0.0' },
            { phase: 'retrying', version: '2.0.0', attempt: 2, maxAttempts: 3, retryAt: NOW },
            { phase: 'failed', version: '2.0.0', stage: 'download' },
            { phase: 'manual', version: '2.0.0', downloadUrl: 'https://x/y.AppImage' },
        ];
        for (const current of from) {
            expect(onUpdateError(current, ctx({ kind: 'manifest', platform: 'linux', failures: 1 })))
                .toEqual({ state: { phase: 'failed', version: '2.0.0', stage: 'verify' }, retryInMs: null });
        }
    });

    it('keeps an update that was already downloaded and verified (ready)', () => {
        const ready: UpdateState = { phase: 'ready', version: '2.0.0' };
        expect(onUpdateError(ready, ctx({ kind: 'manifest' }))).toEqual({ state: ready, retryInMs: null });
    });

    it('never yields the manual (browser) phase', () => {
        for (const platform of ['win32', 'darwin', 'linux'] as const) {
            for (let failures = 0; failures <= 6; failures++) {
                expect(onUpdateError({ phase: 'downloading', version: '2.0.0', percent: 5 }, ctx({ kind: 'manifest', platform, failures })).state.phase).toBe('failed');
            }
        }
    });

    it('the provider is pointed at the same feed electron-builder bakes into app-update.yml', () => {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { build: { publish: { url: string }[] } };
        expect(pkg.build.publish.map((p) => p.url)).toEqual([UPDATE_BASE_URL]);
    });
});

describe("electron-updater's pending cache", () => {
    it('reads updaterCacheDirName from the real app-update.yml shape (staging.155)', () => {
        const yml = 'provider: generic\nurl: https://updates.cipherline.chat\nchannel: staging\nupdaterCacheDirName: desktop-updater\npublisherName:\n  - Cipherline LLC\n';
        expect(parseUpdaterCacheDirName(yml)).toBe('desktop-updater');
        expect(parseUpdaterCacheDirName("updaterCacheDirName: 'desktop-updater'\r\n")).toBe('desktop-updater');
    });

    it('refuses anything that is not one plain path segment', () => {
        for (const bad of [
            'updaterCacheDirName: ../../Windows',
            'updaterCacheDirName: ..',
            'updaterCacheDirName: a/b',
            'updaterCacheDirName: a\\b',
            'updaterCacheDirName: C:',
            'updaterCacheDirName: ',
            'provider: generic',
            '',
        ]) {
            expect(parseUpdaterCacheDirName(bad)).toBeNull();
        }
        expect(parseUpdaterCacheDirName(null)).toBeNull();
        expect(parseUpdaterCacheDirName(undefined)).toBeNull();
    });

    it('mirrors ElectronAppAdapter.baseCachePath per platform', () => {
        const j = path.posix.join;
        expect(pendingUpdateCacheDir('win32', { LOCALAPPDATA: '/L' }, '/home/u', 'desktop-updater', j)).toBe('/L/desktop-updater/pending');
        expect(pendingUpdateCacheDir('win32', {}, '/home/u', 'desktop-updater', j)).toBe('/home/u/AppData/Local/desktop-updater/pending');
        expect(pendingUpdateCacheDir('darwin', {}, '/Users/u', 'desktop-updater', j)).toBe('/Users/u/Library/Caches/desktop-updater/pending');
        expect(pendingUpdateCacheDir('linux', { XDG_CACHE_HOME: '/x' }, '/home/u', 'desktop-updater', j)).toBe('/x/desktop-updater/pending');
        expect(pendingUpdateCacheDir('linux', {}, '/home/u', 'desktop-updater', j)).toBe('/home/u/.cache/desktop-updater/pending');
    });
});

describe('updater diagnostics line', () => {
    const scrubHome = (s: string) => s.split('C:\\Users\\alice').join('<home>').split('alice').join('<user>');

    it('always passes the Performance log charset, scrubbed, with code and next step', () => {
        const err = {
            code: 'ERR_UPDATER_INVALID_SIGNATURE',
            message: "New version 1.0.21-staging.157 is not signed by the application owner: publisherNames: Cipherline LLC, raw info: {\"Status\":1,\"Path\":\"C:\\Users\\alice\\AppData\\Local\\desktop-updater\\pending\\temp-Cipherline Setup.exe\"}",
        };
        const decision = onUpdateError({ phase: 'downloading', version: '1.0.21-staging.157', percent: 100 }, ctx({ kind: 'signature' }));
        const line = updaterErrorDetail(err, decision, scrubHome);
        expect(DETAIL_RE.test(line)).toBe(true);
        expect(line.length).toBeLessThanOrEqual(240);
        expect(line.startsWith('code=ERR_UPDATER_INVALID_SIGNATURE next=failed verify msg=')).toBe(true);
        expect(line).toContain('Status');
        expect(line).not.toMatch(/alice/i);
    });

    it('describes a scheduled retry, and copes with no code / no message / a huge message', () => {
        const d = onUpdateError({ phase: 'available', version: '2' }, ctx({ failures: 2 }));
        expect(updaterErrorDetail({}, d, s => s)).toBe('code=none next=retry 2/3 in 60s');
        const huge = updaterErrorDetail({ code: 'ECONNRESET', message: 'x'.repeat(5000) }, d, s => s);
        expect(DETAIL_RE.test(huge)).toBe(true);
        expect(updaterErrorDetail({ code: 'not a code; drop table', message: 'm' }, d, s => s)).toMatch(/^code=none /);
    });

    it('toDiagnosticDetail reduces any text to the charset and length', () => {
        const t = toDiagnosticDetail('{"a":"b"}\n\t<script>' + 'é'.repeat(400));
        expect(DETAIL_RE.test(t)).toBe(true);
        expect(toDiagnosticDetail('abc', 2)).toBe('ab');
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
