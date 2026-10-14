import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Validate the electron-builder `build` block against electron-builder's OWN
 * shipped JSON schema.
 *
 * WHY THIS EXISTS: `build.win.publisherName` was added as code-signing prep and
 * sailed through every local check — it is inert config, no typecheck covers
 * package.json, and no test read it. It is also **not a valid property in
 * electron-builder 26**, which moved the signtool settings under
 * `win.signtoolOptions` and sets `additionalProperties: false` on the win
 * object. So the first thing that noticed was electron-builder itself, on the
 * Windows runner, mid-release:
 *
 *   ⨯ Invalid configuration object ...
 *    - configuration.win has an unknown property 'publisherName'
 *
 * The Windows job died, macOS and Linux were skipped behind it, and the release
 * shipped NOTHING — all three channels stayed on the previous build. A config
 * typo cost a whole release cycle, and it was only discoverable on a runner.
 *
 * This reads the schema out of the installed app-builder-lib rather than
 * hardcoding a key list, so it tracks whatever version is actually installed:
 * bump electron-builder and this test starts enforcing the NEW schema, which is
 * exactly when a silently-renamed option would otherwise bite again.
 */

const require_ = createRequire(import.meta.url);
// Absent in the public desktop repo's export, where the release workflow does not live: the test skips.
const WORKFLOW = fileURLToPath(new URL('../../../../.github/workflows/release-desktop.yml', import.meta.url));

/** The schema ships inside app-builder-lib; resolve it through node so this
 *  works from a worktree whose node_modules is a symlink or hoisted. */
function loadSchema(): any {
    const entry = require_.resolve('app-builder-lib/package.json');
    return JSON.parse(readFileSync(join(entry, '..', 'scheme.json'), 'utf8'));
}

function loadBuildConfig(): any {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.build;
}

/** Check one object against a named definition, honouring additionalProperties:false. */
function unknownKeys(defs: any, obj: Record<string, unknown>, defName: string): string[] {
    const spec = defs[defName];
    if (!spec || spec.additionalProperties !== false) return [];
    const allowed = new Set(Object.keys(spec.properties ?? {}));
    return Object.keys(obj).filter((k) => !allowed.has(k));
}

describe('electron-builder configuration matches the installed schema', () => {
    it('loads both the schema and the config (never passes vacuously)', () => {
        const defs = loadSchema().definitions;
        expect(defs?.WindowsConfiguration?.properties).toBeTruthy();
        expect(loadBuildConfig()?.win).toBeTruthy();
    });

    it.each([
        ['win', 'WindowsConfiguration'],
        ['mac', 'MacConfiguration'],
        ['linux', 'LinuxConfiguration'],
        ['nsis', 'NsisOptions'],
    ])('build.%s has no unknown properties', (key, defName) => {
        const cfg = loadBuildConfig();
        if (!cfg[key]) return; // platform block not configured — nothing to check
        expect(unknownKeys(loadSchema().definitions, cfg[key], defName)).toEqual([]);
    });

    it('build.win declares NO publisherName while the Windows build is unsigned', () => {
        // ── The second, worse half of the same incident (2026-09-15) ────────
        //
        // Round 1 put `publisherName` directly on `win`, which electron-builder
        // 26 rejects: the release built nothing (see the module doc above).
        // Round 2 moved it to `win.signtoolOptions`, the build went green — and
        // that is when it started doing real damage, because a VALID
        // publisherName on an UNSIGNED build breaks Windows auto-update outright.
        //
        // Measured, not reasoned (app-builder-lib 26.8.1 + electron-updater 6.8.x,
        // both the versions this repo pins):
        //
        //  1. `win.verifyUpdateCodeSignature` is unset, so WinPackager's
        //     `isForceCodeSigningVerification` is true, so PublishManager's
        //     `getAppUpdatePublishConfiguration()` copies `computedPublisherName`
        //     into the app-update.yml it bakes into the installer.
        //  2. On the NEXT update, NsisUpdater.verifySignature() reads that
        //     publisherName back out of app-update.yml. Non-null means "verify",
        //     so it shells out to `Get-AuthenticodeSignature` on the freshly
        //     downloaded .exe.
        //  3. No CSC_LINK is configured, so that .exe is unsigned — confirmed
        //     straight off the wire: the PE Certificate Table data directory is
        //     rva=0 size=0 in every published `Cipherline Setup *.exe`.
        //     Status is NotSigned, no publisher matches, and NsisUpdater throws
        //     ERR_UPDATER_INVALID_SIGNATURE.
        //  4. electron/main.ts's `autoUpdater.on('error')` degraded to the
        //     `manual` phase, and the user got a browser download link
        //     instead of an auto-install. Which is exactly what was reported.
        //     (Since 2026-10-09 a signature rejection instead ends in-app as
        //     "couldn't be verified" with Retry — see electron/updater-state.ts
        //     — so this misconfiguration would now strand users on the old
        //     build with no way forward at all. Keep this test.)
        //
        // Proven against the shipped artifacts: staging.117's app-update.yml has
        // no publisherName (auto-update worked); staging.119's — the first build
        // off the round-2 fix — carries `publisherName: [Cipherline Pty Ltd]`.
        // 119 -> 120 was the first update that could not self-install.
        //
        // SIGNING IS NOW WIRED (Azure Artifact Signing, "Cipherline LLC"), BUT NOT HERE.
        // release-desktop.yml passes `--config.win.azureSignOptions.*` (including
        // publisherName) on the command line ONLY when the AZURE_* secrets are set, so
        // "signed" and "carries a publisherName" are always the same build. Do not move
        // those options into package.json: it would reintroduce the unsigned-build
        // breakage described above for every local, fork and staging build without secrets.
        // (The "Cipherline Pty Ltd" value above is the OLD wrong entity name that shipped
        // in staging.119; the real entity is Cipherline LLC.)
        const win = loadBuildConfig().win;
        expect(win.publisherName).toBeUndefined();
        expect(win.signtoolOptions?.publisherName).toBeUndefined();
    });

    it.skipIf(!existsSync(WORKFLOW))('release workflow passes only real azureSignOptions keys, with the exact publisher', () => {
        const props = loadSchema().definitions.WindowsAzureSigningConfiguration.properties;
        const wf = readFileSync(WORKFLOW, 'utf8');
        const keys = [...wf.matchAll(/--config\.win\.azureSignOptions\.(\w+)=/g)].map((m) => m[1]);
        expect(keys.sort()).toEqual(['certificateProfileName', 'codeSigningAccountName', 'endpoint', 'publisherName']);
        for (const k of keys) expect(props).toHaveProperty(k);
        // Must equal the certificate subject exactly, or the updater's signature check fails.
        expect(wf).toContain('--config.win.azureSignOptions.publisherName="Cipherline LLC"');
    });

    // ── Sign EVERY PE file we ship, not just *.exe (2026-10-12) ─────────────────────────────────────
    //
    // electron-builder 26 signs only `.exe` files unless `win.signExts` says otherwise
    // (WinPackager.shouldSignFile: with no signExts it returns `file.endsWith(".exe")`). The
    // 1.0.21-staging.157 installer, built with Azure signing ON, therefore shipped Cipherline.exe and
    // elevate.exe signed but audio_capture.node, ffmpeg.dll, libEGL.dll, libGLESv2.dll, vk_swiftshader.dll,
    // vulkan-1.dll and dxcompiler.dll UNSIGNED. Smart App Control / code integrity on Windows 11 blocks an
    // unsigned native module at load ("Part of this app has been blocked ... we can't confirm who published
    // audio_capture.node"), so screen-share audio capture failed for those users.
    //
    // There is NO `signDlls` option in electron-builder 26 (the unknown-properties test above would reject it);
    // the supported knob is `win.signExts`, a list of file-name suffixes. `.dll` + `.node` are added to the
    // built-in `.exe`. signApp() walks resources/app.asar.unpacked (where audio_capture.node lives) and every
    // top-level file of the app dir with this predicate, so no asarUnpack change is needed.
    //
    // `signExts` is INERT without signing credentials (the signtool manager returns false when there is no
    // CSC cert, and no azureSignOptions means the Azure manager is never chosen), so unlike azureSignOptions /
    // publisherName it is safe, and desirable, to keep in package.json: unsigned local/fork builds are
    // unchanged, and a CSC_LINK build signs the same files.
    describe('build.win.signExts signs native modules and DLLs', () => {
        // The shipped files named in the screenshot / the staging.157 inspection, as electron-builder
        // sees them (absolute paths under the unpacked app dir).
        const SHIPPED_UNSIGNED = [
            'C:\\b\\win-unpacked\\resources\\app.asar.unpacked\\build\\Release\\audio_capture.node',
            'C:\\b\\win-unpacked\\ffmpeg.dll',
            'C:\\b\\win-unpacked\\libEGL.dll',
            'C:\\b\\win-unpacked\\libGLESv2.dll',
            'C:\\b\\win-unpacked\\vk_swiftshader.dll',
            'C:\\b\\win-unpacked\\vulkan-1.dll',
            'C:\\b\\win-unpacked\\dxcompiler.dll',
        ];
        const ALREADY_SIGNED = [
            'C:\\b\\win-unpacked\\Cipherline.exe',
            'C:\\b\\win-unpacked\\resources\\elevate.exe',
        ];
        const NEVER_SIGNED = [
            'C:\\b\\win-unpacked\\resources\\app.asar',
            'C:\\b\\win-unpacked\\resources.pak',
            'C:\\b\\win-unpacked\\icudtl.dat',
            'C:\\b\\win-unpacked\\resources\\icon.png',
        ];

        /** The REAL electron-builder predicate, bound to a given win config. */
        function shouldSign(win: Record<string, unknown>, file: string): boolean {
            // Load through the package index: requiring out/winPackager directly trips a circular import.
            const { WinPackager } = require_('app-builder-lib');
            return WinPackager.prototype.shouldSignFile.call({ platformSpecificBuildOptions: win }, file);
        }

        it('declares .dll and .node in win.signExts', () => {
            const signExts = loadBuildConfig().win.signExts;
            expect(Array.isArray(signExts)).toBe(true);
            expect(signExts).toEqual(expect.arrayContaining(['.dll', '.node']));
        });

        it('does not use the non-existent signDlls option', () => {
            expect(loadBuildConfig().win.signDlls).toBeUndefined();
            expect(loadSchema().definitions.WindowsConfiguration.properties).not.toHaveProperty('signDlls');
            expect(loadSchema().definitions.WindowsConfiguration.properties).toHaveProperty('signExts');
        });

        it('makes the real electron-builder predicate sign every shipped native module and DLL', () => {
            const win = loadBuildConfig().win;
            for (const f of [...SHIPPED_UNSIGNED, ...ALREADY_SIGNED]) expect(shouldSign(win, f), f).toBe(true);
        });

        it('still signs nothing that is not a PE file', () => {
            const win = loadBuildConfig().win;
            for (const f of NEVER_SIGNED) expect(shouldSign(win, f), f).toBe(false);
        });

        it('NEGATIVE CONTROL: without signExts the same predicate leaves exactly the unsigned set unsigned', () => {
            // Reproduces the staging.157 defect: this is what the pre-fix config did.
            const before = { ...loadBuildConfig().win };
            delete before.signExts;
            for (const f of SHIPPED_UNSIGNED) expect(shouldSign(before, f), f).toBe(false);
            for (const f of ALREADY_SIGNED) expect(shouldSign(before, f), f).toBe(true);
        });

        it('adds no signing credentials to package.json: signExts is inert on unsigned builds', () => {
            const win = loadBuildConfig().win;
            expect(win.azureSignOptions).toBeUndefined();
            expect(win.signtoolOptions).toBeUndefined();
            expect(win.publisherName).toBeUndefined();
        });
    });

    it('build.win.signtoolOptions, if ever reintroduced, uses only real schema keys', () => {
        // Guards the round-1 failure mode independently of the round-2 one, so
        // adding the cert later cannot resurrect the invalid-key build break.
        const win = loadBuildConfig().win;
        if (!win.signtoolOptions) return; // nothing configured — nothing to validate
        expect(unknownKeys(loadSchema().definitions, win.signtoolOptions, 'WindowsSigntoolConfiguration')).toEqual([]);
    });
});
