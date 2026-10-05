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
        //  4. electron/main.ts's `autoUpdater.on('error')` correctly degrades to
        //     the `manual` phase, and the user gets a browser download link
        //     instead of an auto-install. Which is exactly what was reported.
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

    it('build.win.signtoolOptions, if ever reintroduced, uses only real schema keys', () => {
        // Guards the round-1 failure mode independently of the round-2 one, so
        // adding the cert later cannot resurrect the invalid-key build break.
        const win = loadBuildConfig().win;
        if (!win.signtoolOptions) return; // nothing configured — nothing to validate
        expect(unknownKeys(loadSchema().definitions, win.signtoolOptions, 'WindowsSigntoolConfiguration')).toEqual([]);
    });
});
