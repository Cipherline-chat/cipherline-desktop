import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * main.ts / sources-helper.ts / entry.ts import `electron` (or load files
 * that do) and cannot run under vitest, so — like the other *.wiring tests —
 * this pins the WIRING by reading the source. The decisions are tested in
 * capture-flags.test.ts; the transport in sources-helper-client.test.ts.
 *
 * The property guarded: with DXGI enabled in the main process, the main
 * process never calls desktopCapturer.getSources() (the 2026-10-07 freeze).
 */
const read = (f: string) => fs.readFileSync(path.resolve(__dirname, f), 'utf8');
const MAIN = read('main.ts');
const ENTRY = read('entry.ts');
const HELPER = read('sources-helper.ts');
const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as { main: string };
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('entry point', () => {
    it('package.json starts entry.js, which picks helper vs app and nothing else', () => {
        expect(PKG.main).toBe('dist-electron/entry.js');
        const c = code(ENTRY);
        expect(c).toMatch(/if \(isSourcesHelperArgv\(process\.argv\)\) \{\s*require\('\.\/sources-helper'\);\s*\} else \{\s*require\('\.\/main'\);\s*\}/);
        // Only the pure protocol module may load before the decision.
        expect(c.match(/^import .*$/gm)).toEqual(["import { isSourcesHelperArgv } from './sources-helper-protocol';"]);
    });
});

describe('main.ts never lists sources in-process when DXGI is on', () => {
    const c = code(MAIN);
    it('desktopCapturer.getSources is called in exactly one place: listSourcesInProcess', () => {
        const calls = c.match(/desktopCapturer\.getSources\(/g) ?? [];
        expect(calls).toHaveLength(1);
        const fn = c.indexOf('const listSourcesInProcess = async');
        const call = c.indexOf('desktopCapturer.getSources(');
        expect(fn).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(fn);
        expect(call - fn).toBeLessThan(400);
    });
    it('the broker uses the helper whenever one exists, and one exists exactly for PICKER_ENUMERATION === helper', () => {
        expect(c).toContain("const sourcesHelper = PICKER_ENUMERATION === 'helper'");
        expect(c).toContain('getSources: (req) => (sourcesHelper ? sourcesHelper.getSources(req) : listSourcesInProcess(req)),');
        // No other path into listSourcesInProcess.
        expect(c.match(/listSourcesInProcess\(/g)).toHaveLength(1);
    });
    it('PICKER_ENUMERATION comes from the same pref/auto decision as the launch switches', () => {
        expect(c).toMatch(/const PICKER_ENUMERATION = pickerEnumeration\(\{\s*platform: process\.platform,\s*pref: SCREEN_CAPTURER_PREF,\s*autoBackend: AUTO_CAPTURER\.backend,/);
        expect(c).toContain('buildChromiumMediaSwitches(process.platform, SCREEN_CAPTURER_PREF, AUTO_CAPTURER.backend)');
        // The test knob is unpackaged-only.
        expect(c).toContain("forceHelper: !IS_PACKAGED && process.env.CIPHERLINE_SOURCES_HELPER === '1'");
    });
    it('the share is granted with id + name only', () => {
        expect(c).toContain('currentScreenshareCallback({ video: { id: match.id, name: match.name }, audio: audioMode });');
    });
    it('the launch log says where the picker runs', () => {
        expect(c).toContain('picker=${PICKER_ENUMERATION}');
    });
    it('a failed helper is remembered for the next launch, and forgotten once it works', () => {
        expect(c).toContain('helperFailed: SOURCES_HELPER_FAILED_AT_START');
        expect(c).toMatch(/case 'unavailable':[\s\S]{0,300}serializeSourcesHelperFailure/);
        expect(c).toMatch(/case 'ready':[\s\S]{0,300}fs\.rmSync\(SOURCES_HELPER_FAILURE_PATH/);
    });
});

describe('sources-helper.ts', () => {
    const c = code(HELPER);
    it('disables DXGI (and the GPU) before ready, and uses a private profile', () => {
        const sw = c.indexOf("app.commandLine.appendSwitch('disable-features', WINDOWS_NO_DXGI_FEATURE)");
        const ready = c.indexOf('app.whenReady()');
        expect(sw).toBeGreaterThan(-1);
        expect(sw).toBeLessThan(ready);
        expect(c.indexOf('app.disableHardwareAcceleration()')).toBeLessThan(ready);
        expect(c.indexOf("app.setPath('userData', dataDir)")).toBeLessThan(ready);
    });
    it('never loads the app, never opens a window', () => {
        expect(c).not.toMatch(/from '\.\/main'|require\('\.\/main'\)/);
        expect(c).not.toContain('BrowserWindow');
        expect(c).not.toContain('requestSingleInstanceLock');
    });
    it('refuses to run without the parent\'s address and token', () => {
        expect(c).toMatch(/if \(!address \|\| !token\) \{[\s\S]{0,120}process\.exit\(2\)/);
    });
});
