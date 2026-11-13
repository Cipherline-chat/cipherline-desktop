import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import {
    onUpdateError,
    onInstallError,
    debDownloadUrl,
    linuxPackageKind,
    classifyInstallError,
    UPDATE_BASE_URL,
    type UpdateState,
    type UpdateErrorContext,
} from '../../electron/updater-state';
import { describeUpdateTile, manualLabel } from './updateTile';

/**
 * .deb installs update through electron-updater's DebUpdater (`pkexec dpkg -i`). When that
 * fails — no polkit agent on a minimal window manager, a dismissed password dialog, apt refusing —
 * the state used to end in `failed` with a Retry that can only fail the same way and no link, unlike
 * the AppImage. These pin the fix: a same-origin link to the .deb for that version, a dismissed
 * prompt told apart from a real failure, and plain wording for both (electron/updater-state.ts
 * module doc; wiring in electron/updater.wiring.test.ts).
 */
const NOW = 1_800_000_000_000;
const NAMED = `${UPDATE_BASE_URL}/cipherline_2.0.0_amd64.deb`;
const V = '1.0.22';

const ctx = (over: Partial<UpdateErrorContext> = {}): UpdateErrorContext => ({
    kind: 'transient',
    failures: 1,
    platform: 'linux',
    now: NOW,
    buildDownloadUrl: (v) => `${UPDATE_BASE_URL}/Cipherline-${v}.AppImage`,
    ...over,
});

describe('linuxPackageKind (electron-updater picks DebUpdater from resources/package-type)', () => {
    it('$APPIMAGE wins; a `deb` package-type is a .deb; anything else has no artifact of ours', () => {
        expect(linuxPackageKind('/home/u/Cipherline.AppImage', null)).toBe('appimage');
        expect(linuxPackageKind(undefined, 'deb\n')).toBe('deb');
        expect(linuxPackageKind('', 'deb')).toBe('deb');
        expect(linuxPackageKind(undefined, 'rpm')).toBe('other');
        expect(linuxPackageKind(undefined, null)).toBe('other');
        expect(linuxPackageKind(undefined, undefined)).toBe('other');
    });
});

describe('classifyInstallError (spawnSync throws "Command <cmd> exited with code <n>")', () => {
    it('only pkexec exit 126 — the dialog was dismissed — is a cancellation', () => {
        expect(classifyInstallError({ message: 'Command pkexec exited with code 126' })).toBe('cancelled');
        expect(classifyInstallError({ message: '  Command /usr/bin/pkexec exited with code 126\n' })).toBe('cancelled');
    });
    it('127 (no authentication agent / not authorized), other commands and other codes are failures', () => {
        expect(classifyInstallError({ message: 'Command pkexec exited with code 127' })).toBe('failed');
        expect(classifyInstallError({ message: 'Command pkexec exited with code 1' })).toBe('failed');
        expect(classifyInstallError({ message: 'Command pkexec exited with code 1260' })).toBe('failed');
        expect(classifyInstallError({ message: 'Command sudo exited with code 126' })).toBe('failed');
        expect(classifyInstallError({ message: 'Command kdesudo exited with code 126' })).toBe('failed');
        expect(classifyInstallError({ message: 'pkexec exited with code 126, nothing else' })).toBe('failed');
        expect(classifyInstallError({ message: 'Command pkexec exited with code 126; rm -rf /' })).toBe('failed');
        expect(classifyInstallError({ message: 5 as unknown as string })).toBe('failed');
        expect(classifyInstallError(null)).toBe('failed');
        expect(classifyInstallError(undefined)).toBe('failed');
    });
});

describe('debDownloadUrl', () => {
    it('takes the .deb the signed manifest lists, resolved under the update origin', () => {
        expect(debDownloadUrl([{ url: 'Cipherline-2.0.0.AppImage' }, { url: 'cipherline_2.0.0_amd64.deb' }], '2.0.0', 'x64')).toBe(NAMED);
        expect(debDownloadUrl([{ url: 'CIPHERLINE_2.0.0_AMD64.DEB' }], '2.0.0', 'x64')).toBe(`${UPDATE_BASE_URL}/CIPHERLINE_2.0.0_AMD64.DEB`);
    });
    it("falls back to electron-builder's own name (package.json deb.artifactName) when the manifest lists none", () => {
        expect(debDownloadUrl([{ url: 'Cipherline-2.0.0.AppImage' }], '2.0.0', 'x64')).toBe(NAMED);
        expect(debDownloadUrl(null, '2.0.0', 'x64')).toBe(NAMED);
        expect(debDownloadUrl([], '2.1.0-staging.12', 'x64')).toBe(`${UPDATE_BASE_URL}/cipherline_2.1.0-staging.12_amd64.deb`);
    });
    it('the only .deb we build is x64: no guessed link for another arch, but a listed one is used', () => {
        expect(debDownloadUrl([], '2.0.0', 'arm64')).toBeNull();
        expect(debDownloadUrl([{ url: 'cipherline_2.0.0_amd64.deb' }], '2.0.0', 'arm64')).toBe(NAMED);
    });
    it('never builds a URL from a version that is not a version', () => {
        for (const v of ['', '2.0', '../../x', '2.0.0/../../evil', '2.0.0 ', '2.0.0?x=1', 'latest', '2.0.0#h', 'a'.repeat(80)]) {
            expect(debDownloadUrl([], v, 'x64')).toBeNull();
        }
    });
    it('drops manifest entries that are paths, absolute URLs, traversal or odd characters — and falls through, never opens them', () => {
        for (const bad of [
            'https://evil.example/cipherline_2.0.0_amd64.deb', '//evil.example/x.deb', '../cipherline_2.0.0_amd64.deb',
            'sub/dir/x.deb', 'x.deb?token=1', 'x.deb#frag', 'a b.deb', 'x\\y.deb', 'user@evil/x.deb', '.deb',
        ]) {
            expect(debDownloadUrl([{ url: bad }], '2.0.0', 'x64')).toBe(NAMED);
            expect(debDownloadUrl([{ url: bad }], 'nonsense', 'x64')).toBeNull();
        }
        // a bad entry does not stop a later good one
        expect(debDownloadUrl([{ url: '../x.deb' }, { url: 'good_1.0.0_amd64.deb' }], '2.0.0', 'x64')).toBe(`${UPDATE_BASE_URL}/good_1.0.0_amd64.deb`);
    });
    it('every result is https on the update origin and ends in .deb', () => {
        for (const r of [debDownloadUrl([{ url: 'cipherline_2.0.0_amd64.deb' }], '2.0.0', 'x64'), debDownloadUrl([], '2.0.0', 'x64')]) {
            const u = new URL(r!);
            expect(u.origin).toBe(new URL(UPDATE_BASE_URL).origin);
            expect(u.protocol).toBe('https:');
            expect(u.pathname.endsWith('.deb')).toBe(true);
        }
    });
    it('the fallback name is what package.json actually produces', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
        expect(pkg.build.deb.artifactName).toBe('cipherline_${version}_${arch}.${ext}');
        expect(pkg.build.linux.target.find((t: { target: string }) => t.target === 'deb').arch).toEqual(['x64']);
    });
});

describe('onInstallError', () => {
    const ready: UpdateState = { phase: 'ready', version: '2.0.0' };
    it('a dismissed password prompt: failed(install) tagged cancelled — Retry asks again, no link', () => {
        expect(onInstallError(ready, { kind: 'cancelled', manualDownloadUrl: NAMED }))
            .toEqual({ phase: 'failed', version: '2.0.0', stage: 'install', cause: 'cancelled' });
    });
    it('any other .deb install failure: the .deb link, tagged so the UI can say what it is', () => {
        expect(onInstallError(ready, { kind: 'failed', manualDownloadUrl: NAMED }))
            .toEqual({ phase: 'manual', version: '2.0.0', downloadUrl: NAMED, pkg: 'deb', cause: 'install' });
    });
    it('a .deb with no usable link keeps the in-app Retry; every other install is unchanged', () => {
        expect(onInstallError(ready, { kind: 'failed', manualDownloadUrl: null })).toEqual({ phase: 'failed', version: '2.0.0', stage: 'install' });
        expect(onInstallError(ready, undefined)).toEqual({ phase: 'failed', version: '2.0.0', stage: 'install' });
        expect(onInstallError(ready, {})).toEqual({ phase: 'failed', version: '2.0.0', stage: 'install' });
    });
});

describe('onUpdateError: a .deb whose download keeps failing', () => {
    const cur: UpdateState = { phase: 'downloading', version: '2.0.0', percent: 5 };
    const deb = (over: Partial<UpdateErrorContext> = {}) => ctx({ failures: 4, linuxPackage: 'deb', buildDownloadUrl: () => NAMED, ...over });
    it('after the retries are spent: the .deb link, tagged pkg=deb; before that, still retrying in-app', () => {
        expect(onUpdateError(cur, deb()).state).toEqual({ phase: 'manual', version: '2.0.0', downloadUrl: NAMED, pkg: 'deb' });
        expect(onUpdateError(cur, deb({ failures: 2 })).state.phase).toBe('retrying');
    });
    it("an AppImage's link carries no pkg tag (unchanged), and a .deb with no link ends in-app", () => {
        expect(onUpdateError(cur, ctx({ failures: 4, linuxPackage: 'appimage' })).state)
            .toEqual({ phase: 'manual', version: '2.0.0', downloadUrl: `${UPDATE_BASE_URL}/Cipherline-2.0.0.AppImage` });
        expect(onUpdateError(cur, deb({ buildDownloadUrl: () => null })).state).toEqual({ phase: 'failed', version: '2.0.0', stage: 'download' });
    });
    it('a signature rejection is still never a link, .deb or not', () => {
        expect(onUpdateError(cur, deb({ kind: 'signature' })).state).toEqual({ phase: 'failed', version: '2.0.0', stage: 'verify' });
    });
});

describe('.deb wording (plain, and says why)', () => {
    it('a dismissed password prompt is a retry, not an error, and says so', () => {
        const t = describeUpdateTile({ phase: 'failed', version: V, stage: 'install', cause: 'cancelled' }, NOW);
        expect(t).toMatchObject({ visible: true, action: 'retry', tone: 'warn' });
        expect(t.label).toBe('Update not installed — the password prompt was cancelled. Click to try again');
        // ...while a real install failure keeps its own wording and tone
        expect(describeUpdateTile({ phase: 'failed', version: V, stage: 'install' }, NOW))
            .toMatchObject({ tone: 'error', label: "Update couldn't be installed — click to try again" });
    });
    it('the .deb link names the package and why it is offered, and only `manual` has a browser action', () => {
        expect(manualLabel({ phase: 'manual', version: V, downloadUrl: 'x', pkg: 'deb', cause: 'install' }))
            .toBe(`Couldn't install the update automatically — click to download v${V} (.deb) and install it yourself`);
        expect(manualLabel({ phase: 'manual', version: V, downloadUrl: 'x', pkg: 'deb' }))
            .toBe(`Update couldn't download in the app — click to download v${V} (.deb)`);
        expect(manualLabel({ phase: 'manual', version: V, downloadUrl: 'x' })).toBe(`Update available — click to download v${V}`);
        expect(describeUpdateTile({ phase: 'manual', version: V, downloadUrl: NAMED, pkg: 'deb', cause: 'install' }, NOW))
            .toMatchObject({ action: 'open-download', tone: 'external' });
        expect(describeUpdateTile({ phase: 'failed', version: V, stage: 'install', cause: 'cancelled' }, NOW).action).toBe('retry');
    });
});
