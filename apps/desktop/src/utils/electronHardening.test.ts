import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * E-6 (2026-10 security audit): Electron fuses, macOS hardened-runtime
 * entitlements, and the packaged-build debug-switch rule.
 *
 * Fuses and entitlements are inert config - no typecheck covers package.json or
 * a plist, and nothing at runtime notices when one drifts back to Electron's
 * permissive default - so this file pins them. The CI half is
 * scripts/smoke-test.mjs, which reads the fuse wire out of the PACKAGED binary
 * and fails the build if it differs from package.json `build.electronFuses`;
 * the byte-level reader it uses (scripts/smoke-lib.mjs) is tested here.
 *
 * Reads only files under apps/desktop, so it exports cleanly to the public repo.
 */

const DESKTOP = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(DESKTOP, ...p), 'utf8');
/** Source with // and block comments removed, so prose that NAMES a thing is not mistaken for using it. */
const code = (...p: string[]) => read(...p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const pkg = JSON.parse(read('package.json'));
const build = pkg.build;
const require_ = createRequire(import.meta.url);

// ── Fuses ──────────────────────────────────────────────────────────────────

/** fuse -> value -> why. Every one of the eight V1 fuses is named: none is left to Electron's default. */
const EXPECTED_FUSES = {
    // `ELECTRON_RUN_AS_NODE=1 Cipherline.exe -e ...` would be a signed-binary LOLBin. The only
    // self-spawn (the screen-share sources helper) re-launches the app and DELETES the variable.
    runAsNode: false,
    // Chromium cookie store encrypted with the OS keystore (DPAPI / Keychain / libsecret).
    enableCookieEncryption: true,
    // NODE_OPTIONS / NODE_EXTRA_CA_CERTS from the environment must not steer a shipped install.
    enableNodeOptionsEnvironmentVariable: false,
    // `--inspect` on a fresh launch would be main-process code execution with the app's identity.
    enableNodeCliInspectArguments: false,
    // app.asar is hash-checked (macOS + Windows) so a same-user process cannot edit it in place.
    enableEmbeddedAsarIntegrityValidation: true,
    // ...and, with the above, there is no unvalidated `app/` folder fallback.
    onlyLoadAppFromAsar: true,
    // Electron's default; stated so the wire has no "inherit" slot.
    loadBrowserProcessSpecificV8Snapshot: false,
    // file:// pages (installer splash, annotation overlay) need none of fetch/service-worker/universal access.
    grantFileProtocolExtraPrivileges: false,
};

describe('Electron fuses (package.json build.electronFuses)', () => {
    it('pins every fuse to the audited value', () => {
        expect(build.electronFuses).toEqual(EXPECTED_FUSES);
    });

    it('uses only option names electron-builder knows (a typo would be silently inert)', () => {
        const schema = JSON.parse(readFileSync(join(require_.resolve('app-builder-lib/package.json'), '..', 'scheme.json'), 'utf8'));
        const allowed = Object.keys(schema.definitions?.FuseOptionsV1?.properties ?? {});
        expect(allowed.length).toBeGreaterThan(5); // never vacuous
        for (const k of Object.keys(build.electronFuses)) expect(allowed).toContain(k);
    });

    it('the asar-dependent fuses have an asar to depend on', () => {
        expect(build.asar).not.toBe(false);
        expect(build.afterPack).toBeUndefined(); // a custom hook could re-flip or skip the fuses
        // Native addons live OUTSIDE the asar integrity boundary on purpose (dlopen needs a real file).
        expect(build.asarUnpack).toEqual(['build/Release/audio_capture.node']);
    });

    it('nothing relies on ELECTRON_RUN_AS_NODE or a self-spawn as plain Node', () => {
        const offenders: string[] = [];
        for (const f of readdirSync(join(DESKTOP, 'electron')).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
            const src = code('electron', f);
            if (/ELECTRON_RUN_AS_NODE/.test(src) && f !== 'sources-helper-client.ts') offenders.push(`${f}: ELECTRON_RUN_AS_NODE`);
            if (/\butilityProcess\b|child_process['"]\)?\s*\.fork|\bfork\(/.test(src)) offenders.push(`${f}: fork/utilityProcess`);
        }
        expect(offenders).toEqual([]);
        // The one use is a delete: the sources helper must NOT run as plain Node.
        expect(read('electron', 'sources-helper-client.ts')).toMatch(/delete env\.ELECTRON_RUN_AS_NODE;/);
        // ...and it re-launches the app executable with its own flag, not `-e`/a script.
        expect(read('electron', 'main.ts')).toMatch(/command: process\.execPath,\s*\n[^\n]*\n\s*args: IS_PACKAGED \? \[SOURCES_HELPER_FLAG\]/);
    });

    it('the file:// pages we load do not use what GrantFileProtocolExtraPrivileges=false takes away', () => {
        // fetch() of file://, service workers, and universal access to child frames.
        for (const f of ['annotation-overlay.ts', 'installer-splash.ts']) {
            const src = read('electron', f);
            expect(src, f).not.toMatch(/\bfetch\s*\(|serviceWorker|<iframe|XMLHttpRequest|<webview/);
        }
        // Only these two loadFile callers exist (main.ts splash, annotation overlay); a third must be reviewed here.
        const loaders = readdirSync(join(DESKTOP, 'electron'))
            .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
            .filter((n) => /\.loadFile\(/.test(read('electron', n)))
            .sort();
        expect(loaders).toEqual(['annotation-overlay.ts', 'main.ts']);
        expect(read('electron', 'main.ts').match(/\.loadFile\(/g)).toHaveLength(1);
    });
});

// ── macOS entitlements ──────────────────────────────────────────────────────

/** The plist's <key> names with XML comments removed (the file explains what is absent, by name). */
function entitlementKeys(): string[] {
    const xml = read('build-assets', 'entitlements.mac.plist').replace(/<!--[\s\S]*?-->/g, '');
    return [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
}

describe('macOS entitlements (build-assets/entitlements.mac.plist)', () => {
    it('is exactly the audited set - adding an entitlement is a deliberate edit to THIS test', () => {
        expect(entitlementKeys().sort()).toEqual([
            'com.apple.security.cs.allow-jit',
            'com.apple.security.cs.allow-unsigned-executable-memory',
            'com.apple.security.device.audio-input',
            'com.apple.security.device.camera',
            'com.apple.security.network.client',
        ]);
    });

    it('does not re-enable DYLD injection or unsigned-library loading', () => {
        const keys = entitlementKeys();
        expect(keys).not.toContain('com.apple.security.cs.allow-dyld-environment-variables');
        expect(keys).not.toContain('com.apple.security.cs.disable-library-validation');
    });

    it('every entitlement in the file is switched on, none is <false/>', () => {
        const xml = read('build-assets', 'entitlements.mac.plist').replace(/<!--[\s\S]*?-->/g, '');
        expect((xml.match(/<true\/>/g) ?? []).length).toBe(5);
        expect(xml).not.toMatch(/<false\/>/);
    });

    it('is the file the mac build signs the app AND its helpers with, under the hardened runtime', () => {
        expect(build.mac.hardenedRuntime).toBe(true);
        expect(build.mac.entitlements).toBe('build-assets/entitlements.mac.plist');
        expect(build.mac.entitlementsInherit).toBe('build-assets/entitlements.mac.plist');
    });

    it('the only native module shipped is our own addon (so Team-ID library validation has one thing to cover)', () => {
        expect(build.files).toContain('build/Release/audio_capture.node');
        expect(build.asarUnpack).toEqual(['build/Release/audio_capture.node']);
        // No production dependency is a native-addon package.
        const nativeish = Object.keys(pkg.dependencies).filter((d) => /^(node-gyp|bindings|prebuild|nan|node-addon-api|better-sqlite3|bcrypt|sharp|keytar|ffi-napi|koffi)/.test(d));
        expect(nativeish).toEqual([]);
    });
});

// ── Packaged-build debug switches + smoke wiring ────────────────────────────

describe('packaged builds ignore debugging switches (wiring)', () => {
    const main = read('electron', 'main.ts');

    it('main.ts strips them for every packaged launch, before the app is ready', () => {
        const call = main.indexOf('stripDebugSwitches(app.commandLine, IS_PACKAGED);');
        expect(call).toBeGreaterThan(-1);
        expect(call).toBeLessThan(main.indexOf('app.whenReady()'));
        // Not conditioned on smoke mode: the smoke run must not have a debugger either.
        const line = main.slice(main.lastIndexOf('\n', call) + 1, main.indexOf('\n', call));
        expect(line.trim()).toBe('stripDebugSwitches(app.commandLine, IS_PACKAGED);');
    });

    it('smoke mode reports through the app itself, not through a debugger', () => {
        expect(main).toMatch(/if \(IS_SMOKE_TEST\) installSmokeReporter\(app\);/);
        const smoke = code('scripts', 'smoke-test.mjs');
        expect(smoke).not.toMatch(/playwright/i);
        expect(smoke).not.toMatch(/remote-debugging|--inspect/);
        expect(smoke).toMatch(/verifyFusesOnDisk\(executablePath, fuseConfig\)/);
        expect(smoke).toMatch(/checkMacAddonSignature\(/);
    });
});

// ── smoke-lib.mjs: the fuse-wire reader the CI gate relies on ───────────────

type SmokeLib = {
    FUSE_SENTINEL: string;
    FUSE_V1_ORDER: string[];
    parseFuseWires(b: Buffer): Array<{ version: number; states: number[] }>;
    checkFuses(w: Array<{ version: number; states: number[] }>, c: Record<string, unknown>): string[];
    fuseFilePath(p: string): string;
    macAppRoot(p: string): string | null;
    parseTeamIdentifier(s: string): string | null;
    checkMacAddonSignature(
        exe: string,
        run: (c: string, a: string[]) => { status: number; output: string },
        exists?: (p: string) => boolean,
    ): { skipped?: string; problems?: string[]; appTeam?: string };
};

async function lib(): Promise<SmokeLib> {
    return (await import(/* @vite-ignore */ pathToFileURL(join(DESKTOP, 'scripts', 'smoke-lib.mjs')).href)) as SmokeLib;
}

/** A fake "binary": noise, the sentinel, wire version 1, length, then one byte per fuse. */
function fakeBinary(l: SmokeLib, states: string): Buffer {
    return Buffer.concat([
        Buffer.from('MZ-noise-'), Buffer.from(l.FUSE_SENTINEL, 'latin1'),
        Buffer.from([1, states.length]), Buffer.from(states, 'latin1'), Buffer.from('-tail'),
    ]);
}
const wireFor = (cfg: Record<string, boolean>, order: string[]) => order.map((k) => (cfg[k] ? '1' : '0')).join('');

describe('scripts/smoke-lib.mjs (fuse wire reader used by the CI smoke gate)', () => {
    it('reads the wire and accepts exactly the configured fuses', async () => {
        const l = await lib();
        expect(l.FUSE_V1_ORDER).toEqual(Object.keys(EXPECTED_FUSES)); // same order as the wire AND as the pinned config
        const wires = l.parseFuseWires(fakeBinary(l, wireFor(EXPECTED_FUSES, l.FUSE_V1_ORDER)));
        expect(wires).toHaveLength(1);
        expect(l.checkFuses(wires, EXPECTED_FUSES)).toEqual([]);
    });

    it('rejects an Electron-default wire (every open fuse is named)', async () => {
        const l = await lib();
        // Electron defaults: RunAsNode, cookies off, NODE_OPTIONS on, inspect on, asar integrity off, any app dir, v8 snapshot off, file privileges on.
        const wires = l.parseFuseWires(fakeBinary(l, '10110001'));
        const problems = l.checkFuses(wires, EXPECTED_FUSES);
        expect(problems.join('\n')).toMatch(/runAsNode: expected false, binary has true/);
        expect(problems.join('\n')).toMatch(/enableNodeCliInspectArguments: expected false, binary has true/);
        expect(problems.join('\n')).toMatch(/grantFileProtocolExtraPrivileges: expected false, binary has true/);
        expect(problems.join('\n')).toMatch(/enableEmbeddedAsarIntegrityValidation: expected true, binary has false/);
        expect(problems).toHaveLength(7);
    });

    it('every slice of a universal binary must match, and a missing wire fails', async () => {
        const l = await lib();
        const good = wireFor(EXPECTED_FUSES, l.FUSE_V1_ORDER);
        const two = Buffer.concat([fakeBinary(l, good), fakeBinary(l, '10110001')]);
        const problems = l.checkFuses(l.parseFuseWires(two), EXPECTED_FUSES);
        expect(problems.length).toBeGreaterThan(0);
        expect(problems[0]).toMatch(/wire 2\/2/);
        expect(l.checkFuses([], EXPECTED_FUSES)).toEqual(['no Electron fuse wire found in the binary']);
        expect(l.parseFuseWires(Buffer.from('nothing here'))).toEqual([]);
    });

    it('a fuse marked removed cannot be claimed as set', async () => {
        const l = await lib();
        const good = wireFor(EXPECTED_FUSES, l.FUSE_V1_ORDER);
        const wires = l.parseFuseWires(fakeBinary(l, `r${good.slice(1)}`));
        expect(l.checkFuses(wires, EXPECTED_FUSES)[0]).toMatch(/runAsNode: fuse is marked removed/);
    });

    it('locates the wire in the framework binary on macOS, the executable elsewhere', async () => {
        const l = await lib();
        expect(l.fuseFilePath('/r/linux-unpacked/desktop')).toBe('/r/linux-unpacked/desktop');
        expect(l.fuseFilePath('C:\\r\\win-unpacked\\Cipherline.exe')).toBe('C:\\r\\win-unpacked\\Cipherline.exe');
        expect(l.fuseFilePath('/r/mac-arm64/Cipherline.app/Contents/MacOS/Cipherline'))
            .toBe('/r/mac-arm64/Cipherline.app/Contents/Frameworks/Electron Framework.framework/Electron Framework');
        expect(l.macAppRoot('/a/b.apps/x/Cipherline.app/Contents/MacOS/Cipherline')).toBe('/a/b.apps/x/Cipherline.app');
    });

    it('macOS addon check: same Team ID passes; a different, missing or ad-hoc one fails; unsigned apps are skipped', async () => {
        const l = await lib();
        const exe = '/r/mac-arm64/Cipherline.app/Contents/MacOS/Cipherline';
        const sign = (team: string | null, verifyOk = true) => (_cmd: string, args: string[]) => {
            if (args[0] === '--verify') return { status: verifyOk ? 0 : 1, output: verifyOk ? '' : 'invalid signature' };
            const isAddon = args[args.length - 1].endsWith('.node');
            const t = isAddon ? team : '78M5WXKCH9';
            return { status: 0, output: `Identifier=x\nTeamIdentifier=${t ?? 'not set'}\n` };
        };
        const present = () => true;
        expect(l.checkMacAddonSignature(exe, sign('78M5WXKCH9'), present)).toEqual({ problems: [], appTeam: '78M5WXKCH9' });
        expect(l.checkMacAddonSignature(exe, sign('ABCDE12345'), present).problems?.join()).toMatch(/TeamIdentifier is ABCDE12345, the app's is 78M5WXKCH9/);
        expect(l.checkMacAddonSignature(exe, sign(null), present).problems?.join()).toMatch(/not set/);
        expect(l.checkMacAddonSignature(exe, sign('78M5WXKCH9', false), present).problems?.join()).toMatch(/--verify --strict/);
        expect(l.checkMacAddonSignature(exe, sign('78M5WXKCH9'), () => false).skipped).toMatch(/no audio_capture\.node/);
        const unsignedApp = () => ({ status: 0, output: 'TeamIdentifier=not set\n' });
        expect(l.checkMacAddonSignature(exe, unsignedApp, present).skipped).toMatch(/not Developer-ID signed/);
        expect(l.checkMacAddonSignature('/r/linux-unpacked/desktop', sign(null), present).skipped).toMatch(/not a macOS/);
        expect(l.parseTeamIdentifier('Identifier=a\nTeamIdentifier=not set')).toBeNull();
    });
});
