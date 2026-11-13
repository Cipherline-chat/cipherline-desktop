import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    appImageIsUnsandboxed, sandboxNoticeOutcome, warnIfAppImageUnsandboxed, SANDBOX_NOTICE,
    type SandboxFacts, type SandboxNoticeDeps,
} from './linux-sandbox';

const base: SandboxFacts = {
    platform: 'linux', packaged: true, appImageEnv: '/home/u/Cipherline.AppImage', noSandboxSwitch: true, smokeTest: false,
};

describe('appImageIsUnsandboxed', () => {
    it('is an installed AppImage on Linux that was started with --no-sandbox', () => {
        expect(appImageIsUnsandboxed(base)).toBe(true);
    });
    it('is never Windows or macOS, whatever the other facts say', () => {
        expect(appImageIsUnsandboxed({ ...base, platform: 'win32' })).toBe(false);
        expect(appImageIsUnsandboxed({ ...base, platform: 'darwin' })).toBe(false);
    });
    it('is not the .deb, an unpacked build or a dev run (no APPIMAGE / not packaged)', () => {
        expect(appImageIsUnsandboxed({ ...base, appImageEnv: undefined })).toBe(false);
        expect(appImageIsUnsandboxed({ ...base, appImageEnv: '' })).toBe(false);
        expect(appImageIsUnsandboxed({ ...base, packaged: false })).toBe(false);
    });
    it('is not CI\'s smoke test, and not an AppImage that has its sandbox', () => {
        expect(appImageIsUnsandboxed({ ...base, smokeTest: true })).toBe(false);
        expect(appImageIsUnsandboxed({ ...base, noSandboxSwitch: false })).toBe(false);
    });
});

describe('sandboxNoticeOutcome', () => {
    it('Continue keeps running; the box remembers it', () => {
        expect(sandboxNoticeOutcome(0, false)).toEqual({ quit: false, remember: false });
        expect(sandboxNoticeOutcome(0, true)).toEqual({ quit: false, remember: true });
    });
    it('Quit quits and remembers nothing', () => {
        expect(sandboxNoticeOutcome(1, true)).toEqual({ quit: true, remember: false });
    });
});

describe('warnIfAppImageUnsandboxed', () => {
    const deps = (over: Partial<SandboxNoticeDeps> = {}): SandboxNoticeDeps => ({
        facts: base,
        suppressed: () => false,
        remember: vi.fn(),
        showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
        quit: vi.fn(),
        log: vi.fn(),
        ...over,
    });
    it('shows the notice, with the .deb as the way out, and carries on', async () => {
        const d = deps();
        expect(await warnIfAppImageUnsandboxed(d)).toBe(true);
        expect(d.showMessageBox).toHaveBeenCalledTimes(1);
        const arg = (d.showMessageBox as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(arg.detail).toMatch(/\.deb/);
        expect(arg.buttons).toEqual([...SANDBOX_NOTICE.buttons]);
        expect(d.quit).not.toHaveBeenCalled();
        expect(d.remember).not.toHaveBeenCalled();
    });
    it('shows nothing where the app is sandboxed (Windows, macOS, the .deb, an AppImage with its sandbox)', async () => {
        for (const facts of [
            { ...base, platform: 'win32' }, { ...base, platform: 'darwin' },
            { ...base, appImageEnv: undefined }, { ...base, noSandboxSwitch: false },
        ]) {
            const d = deps({ facts });
            expect(await warnIfAppImageUnsandboxed(d)).toBe(false);
            expect(d.showMessageBox).not.toHaveBeenCalled();
            expect(d.log).not.toHaveBeenCalled();
        }
    });
    it('logs the state even when the person asked not to be told again, but shows nothing', async () => {
        const d = deps({ suppressed: () => true });
        expect(await warnIfAppImageUnsandboxed(d)).toBe(false);
        expect(d.log).toHaveBeenCalledTimes(1);
        expect(d.showMessageBox).not.toHaveBeenCalled();
    });
    it('remembers "don\'t show again" only on Continue; Quit quits', async () => {
        const keep = deps({ showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: true })) });
        await warnIfAppImageUnsandboxed(keep);
        expect(keep.remember).toHaveBeenCalledTimes(1);
        const leave = deps({ showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: true })) });
        await warnIfAppImageUnsandboxed(leave);
        expect(leave.quit).toHaveBeenCalledTimes(1);
        expect(leave.remember).not.toHaveBeenCalled();
    });
    it('a dialog that fails, or a marker that cannot be read or written, never stops the app', async () => {
        const broken = deps({ showMessageBox: vi.fn(async () => { throw new Error('no display'); }) });
        expect(await warnIfAppImageUnsandboxed(broken)).toBe(false);
        expect(broken.quit).not.toHaveBeenCalled();
        const noMarker = deps({
            suppressed: () => { throw new Error('EACCES'); },
            remember: () => { throw new Error('EACCES'); },
            showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: true })),
        });
        expect(await warnIfAppImageUnsandboxed(noMarker)).toBe(true);
    });
});

describe('packaging: the Linux build does not bake the sandbox off', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
    it('executableArgs (electron-builder defaults an AppImage\'s desktop entry to --no-sandbox when empty) never contains --no-sandbox', () => {
        const args: unknown = pkg.build.linux.executableArgs;
        expect(Array.isArray(args)).toBe(true);
        expect((args as string[]).length).toBeGreaterThan(0); // an EMPTY list falls back to --no-sandbox
        expect((args as string[]).join(' ')).not.toMatch(/no-sandbox/);
    });
    it('no electron-builder Linux target or after-pack hook adds --no-sandbox either', () => {
        expect(JSON.stringify(pkg.build)).not.toMatch(/no-sandbox/);
    });
    it('main.ts hands the notice only real facts and never touches the sandbox switches', () => {
        const main = readFileSync(resolve(__dirname, 'main.ts'), 'utf8');
        expect(main).toContain("noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox')");
        expect(main).not.toMatch(/appendSwitch\('no-sandbox'|appendSwitch\("no-sandbox"|disable-setuid-sandbox/);
    });
    it('control: the matcher catches a baked-in flag', () => {
        expect(JSON.stringify({ linux: { executableArgs: ['--no-sandbox'] } })).toMatch(/no-sandbox/);
    });
});
