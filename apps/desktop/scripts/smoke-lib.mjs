// Pure helpers for scripts/smoke-test.mjs (kept apart so the logic is unit
// testable: src/utils/electronHardening.test.ts imports this file).
//
// 1. Electron fuses — read the fuse wire out of the PACKAGED binary and compare
//    it with package.json `build.electronFuses`, the single source of truth that
//    electron-builder flips at pack time. A build whose fuses were not applied
//    (config key renamed, a future electron-builder change, a hand-rolled
//    afterPack that skips them) fails the gate instead of shipping.
// 2. macOS — the ScreenCaptureKit addon must carry the app's Team ID. The
//    entitlements no longer include disable-library-validation, so an addon
//    signed by anyone else would fail to dlopen and mac screen-share audio
//    would silently vanish.
//
// No dependencies: runs on the bare CI runners (Node 20+).

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The marker @electron/fuses (and Electron) put in front of the fuse wire. */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';

/**
 * Fuse wire V1 order. Index i of the wire is FUSE_V1_ORDER[i]; the names are
 * electron-builder's `electronFuses` option names (== @electron/fuses'
 * FuseV1Options, camel-cased). Keep in step with @electron/fuses.
 */
export const FUSE_V1_ORDER = [
    'runAsNode',
    'enableCookieEncryption',
    'enableNodeOptionsEnvironmentVariable',
    'enableNodeCliInspectArguments',
    'enableEmbeddedAsarIntegrityValidation',
    'onlyLoadAppFromAsar',
    'loadBrowserProcessSpecificV8Snapshot',
    'grantFileProtocolExtraPrivileges',
];

const STATE_DISABLED = 0x30; // '0'
const STATE_ENABLED = 0x31; // '1'
const STATE_REMOVED = 0x72; // 'r'

/**
 * Parse every fuse wire in a binary (a universal macOS binary carries two).
 * @param {Buffer} buf
 * @returns {Array<{ version: number, states: number[] }>}
 */
export function parseFuseWires(buf) {
    const needle = Buffer.from(FUSE_SENTINEL, 'latin1');
    const wires = [];
    let from = 0;
    for (;;) {
        const at = buf.indexOf(needle, from);
        if (at === -1) break;
        const pos = at + needle.length;
        const version = buf[pos];
        const len = buf[pos + 1];
        // A random sentinel-looking string elsewhere would not be followed by a sane wire.
        if (version === 1 && len > 0 && len <= 64 && pos + 2 + len <= buf.length) {
            wires.push({ version, states: Array.from(buf.subarray(pos + 2, pos + 2 + len)) });
        }
        from = at + needle.length;
    }
    return wires;
}

/** `/x/Cipherline.app/Contents/MacOS/Cipherline` -> `/x/Cipherline.app`; null for non-.app paths. */
export function macAppRoot(executablePath) {
    const m = /^(.*?\.app)(?=[\\/]|$)/.exec(executablePath);
    return m ? m[1] : null;
}

/**
 * Where the fuse wire lives: the Electron binary itself on Windows/Linux, the
 * framework binary inside the .app on macOS (same rule as @electron/fuses).
 * @param {string} executablePath the packaged app's main executable
 */
export function fuseFilePath(executablePath) {
    const appRoot = macAppRoot(executablePath);
    if (!appRoot) return executablePath;
    return resolve(appRoot, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
}

/**
 * Compare wires with the config. Returns human-readable problems (empty = OK).
 * Only fuses the config names are checked; an unlisted fuse is "do not care",
 * but the test in electronHardening.test.ts pins that all eight are listed.
 * @param {Array<{ version: number, states: number[] }>} wires
 * @param {Record<string, unknown>} config build.electronFuses
 */
export function checkFuses(wires, config) {
    const problems = [];
    if (wires.length === 0) return ['no Electron fuse wire found in the binary'];
    for (const [w, wire] of wires.entries()) {
        const tag = wires.length > 1 ? ` (wire ${w + 1}/${wires.length})` : '';
        FUSE_V1_ORDER.forEach((name, i) => {
            const want = config[name];
            if (typeof want !== 'boolean') return;
            const have = wire.states[i];
            if (have === undefined) { problems.push(`${name}: fuse missing from the ${wire.states.length}-entry wire${tag}`); return; }
            if (have === STATE_REMOVED) { problems.push(`${name}: fuse is marked removed in this Electron, cannot be ${want}${tag}`); return; }
            const wantByte = want ? STATE_ENABLED : STATE_DISABLED;
            if (have !== wantByte) problems.push(`${name}: expected ${want}, binary has ${have === STATE_ENABLED ? 'true' : have === STATE_DISABLED ? 'false' : `0x${have.toString(16)}`}${tag}`);
        });
    }
    return problems;
}

/** Read the packaged binary's fuses and check them. Returns { problems, table }. */
export function verifyFusesOnDisk(executablePath, config) {
    const file = fuseFilePath(executablePath);
    const wires = parseFuseWires(readFileSync(file));
    const table = wires.length
        ? FUSE_V1_ORDER.map((name, i) => `${name}=${wires[0].states[i] === STATE_ENABLED ? 'on' : wires[0].states[i] === STATE_DISABLED ? 'off' : wires[0].states[i] === STATE_REMOVED ? 'removed' : '?'}`).join(' ')
        : '(none)';
    return { problems: checkFuses(wires, config), table };
}

/** `codesign -dv --verbose=2` writes `TeamIdentifier=ABCDE12345` (or `not set`) to stderr. */
export function parseTeamIdentifier(codesignOutput) {
    const m = /^TeamIdentifier=(.+)$/m.exec(String(codesignOutput));
    if (!m) return null;
    const v = m[1].trim();
    return v === 'not set' ? null : v;
}

/** The unpacked addon, relative to the .app root. */
export const MAC_ADDON_REL = join('Contents', 'Resources', 'app.asar.unpacked', 'build', 'Release', 'audio_capture.node');

/**
 * macOS only. `run(cmd, args)` -> { status, output } (output = stdout+stderr).
 * Returns { skipped: string } when there is nothing to enforce, else { problems }.
 */
export function checkMacAddonSignature(executablePath, run, exists = existsSync) {
    const appRoot = macAppRoot(executablePath);
    if (!appRoot) return { skipped: 'not a macOS .app' };
    const addon = join(appRoot, MAC_ADDON_REL);
    if (!exists(addon)) return { skipped: 'no audio_capture.node in this build (addon is optional)' };
    const app = run('codesign', ['-dv', '--verbose=2', appRoot]);
    const appTeam = parseTeamIdentifier(app.output);
    if (!appTeam) return { skipped: 'app is not Developer-ID signed (no TeamIdentifier), nothing to compare' };
    const problems = [];
    const verify = run('codesign', ['--verify', '--strict', addon]);
    if (verify.status !== 0) problems.push(`audio_capture.node fails codesign --verify --strict: ${String(verify.output).trim().slice(0, 300)}`);
    const addonTeam = parseTeamIdentifier(run('codesign', ['-dv', '--verbose=2', addon]).output);
    if (addonTeam !== appTeam) problems.push(`audio_capture.node TeamIdentifier is ${addonTeam ?? 'not set'}, the app's is ${appTeam}: with library validation on, macOS will refuse to load the addon`);
    return { problems, appTeam };
}
