// Smoke test for the packaged Electron build.
//
// Runs in CI after electron-builder produces an unpacked binary. First checks
// that the Electron fuses in the packaged binary are the ones package.json
// asks for (and, on macOS, that the native addon carries the app's Team ID).
// Then launches the binary as a plain child process in smoke mode, waits for
// the app to report that its first window painted (electron/smoke-report.ts
// writes smoke-report.json into the throwaway profile), asserts the renderer
// rendered SOMETHING with no console errors (vs. a white-screen-of-death from
// an unhandled exception in the bundle), keeps the screenshot the app took,
// and exits.
//
// Why not Playwright's _electron API any more: it attaches through --inspect
// and --remote-debugging-port, which the shipped binary has switched off (the
// EnableNodeCliInspectArguments fuse + electron/debug-switches.ts). The gate
// must run the binary that ships, so the app reports on itself instead and no
// debugger is attached.
//
// What this catches that typecheck doesn't:
//   * Worker / WASM import paths that resolve in dev but not in the asar.
//   * Native addon `__dirname` resolution bugs (asar.unpacked path mismatches).
//   * CSP violations from inline scripts injected by libs.
//   * Auto-updater / secureStore init crashes during boot.
//   * Anything that throws during the React mount before the first paint.
//   * Fuses that were configured but not actually applied to the binary.
//
// What it doesn't catch: feature regressions, network-dependent flows
// (auth, calls, attachments). Those are out of scope — this is a "did
// the app even start" gate.
//
// Exit codes:
//   0  — fuses as configured, app launched, renderer painted within timeout.
//   1  — anything else (fuse mismatch, timeout, crash, console errors, no window).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdtempSync, rmSync, readFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, tmpdir } from 'node:os';
import { verifyFusesOnDisk, checkMacAddonSignature } from './smoke-lib.mjs';

// A packaged build honours CIPHERLINE_SMOKE_TEST only together with this
// argument AND a --user-data-dir switch (electron/smoke-mode.ts), so an
// inherited environment variable cannot put a real install into smoke mode.
// Keep in sync with SMOKE_TEST_ARG there.
const SMOKE_TEST_ARG = '--cipherline-smoke-test';

// Keep in sync with SMOKE_REPORT_FILENAME / SMOKE_SCREENSHOT_FILENAME in
// electron/smoke-report.ts.
const REPORT_FILE = 'smoke-report.json';
const SCREENSHOT_FILE = 'smoke-report.png';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Known Electron helper binaries that are NOT the app entry point.
const ELECTRON_HELPERS = new Set([
    'chrome-sandbox', 'crashpad_handler', 'chrome_crashpad_handler',
    'chrome_child', 'nacl_helper', 'nacl_helper_bootstrap',
]);

// Resolve the path to the unpacked Cipherline binary that electron-builder
// produced. Each platform puts it somewhere different; we try the known
// locations and fail loudly if none exist.
function findAppBinaryIn(dir) {
    if (!existsSync(dir)) return null;
    // Log all files in the dir to help diagnose name mismatches.
    let files;
    try { files = readdirSync(dir); } catch { return null; }
    console.log(`[smoke] ${dir.split('/').pop()}/ contents: ${files.join(', ')}`);
    for (const f of files.sort()) {
        if (ELECTRON_HELPERS.has(f)) continue;
        if (f.endsWith('.so') || f.endsWith('.so.1') || f.includes('.so.')) continue;
        const fp = join(dir, f);
        try {
            const st = statSync(fp);
            if (st.isFile() && (st.mode & 0o111)) return fp;
        } catch { /* skip */ }
    }
    return null;
}

function resolveBinary() {
    const pl = platform();
    const release = join(root, 'release');

    // Log release dir contents for every Linux run so binary name is always visible.
    if (pl === 'linux' && existsSync(release)) {
        console.log(`[smoke] release/ contents: ${readdirSync(release).join(', ')}`);
    }

    const candidates = {
        win32: [join(release, 'win-unpacked', 'Cipherline.exe')],
        darwin: [
            join(release, 'mac-arm64', 'Cipherline.app', 'Contents', 'MacOS', 'Cipherline'),
            join(release, 'mac', 'Cipherline.app', 'Contents', 'MacOS', 'Cipherline'),
        ],
        linux: [
            // electron-builder uses package.json `name` as the Linux executable
            // name when no `executableName` is set — this package is "desktop".
            join(release, 'linux-unpacked', 'desktop'),
            join(release, 'linux-x64-unpacked', 'desktop'),
            // Keep productName-derived fallbacks in case executableName is added later.
            join(release, 'linux-unpacked', 'cipherline'),
            join(release, 'linux-x64-unpacked', 'cipherline'),
            join(release, 'linux-unpacked', 'Cipherline'),
        ],
    };

    // Dynamic fallback for Linux: scan unpacked dirs for the app binary,
    // skipping known Electron helpers and shared libraries.
    if (pl === 'linux') {
        for (const dir of ['linux-unpacked', 'linux-x64-unpacked']) {
            const found = findAppBinaryIn(join(release, dir));
            if (found) candidates.linux.push(found);
        }
    }

    const paths = candidates[pl] ?? [];
    for (const p of paths) {
        if (existsSync(p)) return p;
    }

    console.error(`[smoke] No unpacked binary found for platform ${pl}. Tried:`);
    for (const p of paths) console.error(`  - ${p}`);
    process.exit(1);
}

const TIMEOUT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(child) {
    if (!child || child.exitCode !== null || child.pid === undefined) return;
    try {
        if (platform() === 'win32') {
            // Electron's helpers are children of the main process; /T takes them too.
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            child.kill('SIGKILL');
        }
    } catch { /* already gone */ }
}

(async () => {
    const executablePath = resolveBinary();
    console.log(`[smoke] Launching: ${executablePath}`);

    // ── 1. The fuses in the binary we are about to run are the configured ones.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const fuseConfig = pkg.build?.electronFuses;
    if (!fuseConfig || typeof fuseConfig !== 'object') {
        console.error("[smoke] package.json build.electronFuses is missing - the build would ship with Electron's default (open) fuses");
        process.exit(1);
    }
    try {
        const { problems, table } = verifyFusesOnDisk(executablePath, fuseConfig);
        console.log(`[smoke] Electron fuses in the packaged binary: ${table}`);
        if (problems.length > 0) {
            console.error('[smoke] Electron fuses do not match package.json build.electronFuses:');
            for (const p of problems) console.error(`  - ${p}`);
            process.exit(1);
        }
    } catch (err) {
        console.error('[smoke] Could not read the Electron fuses:', err?.message ?? err);
        process.exit(1);
    }

    // ── 2. macOS: the native addon is signed by the same team as the app.
    if (platform() === 'darwin') {
        const run = (cmd, args) => {
            const r = spawnSync(cmd, args, { encoding: 'utf8' });
            return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
        };
        const res = checkMacAddonSignature(executablePath, run);
        if (res.skipped) {
            console.log(`[smoke] macOS addon signature check skipped: ${res.skipped}`);
        } else if (res.problems.length > 0) {
            console.error('[smoke] macOS native addon signature problems:');
            for (const p of res.problems) console.error(`  - ${p}`);
            process.exit(1);
        } else {
            console.log(`[smoke] macOS addon is signed by the app's team (${res.appTeam})`);
        }
    }

    // ── 3. Launch in smoke mode and wait for the app's own report.
    const t0 = Date.now();
    let ownedProfileDir = null;
    // Optional throwaway profile (set by the self-hosted macOS CI job so the smoke run never
    // touches a real installed profile on a persistent machine). Unset = unchanged behaviour.
    // Without one (the Linux job), use a private temp profile: smoke mode
    // needs a --user-data-dir anyway, and this keeps the run off any real
    // profile on the runner.
    let smokeUserDataDir = process.env.SMOKE_USER_DATA_DIR;
    if (!smokeUserDataDir) {
        smokeUserDataDir = mkdtempSync(join(tmpdir(), 'cl-smoke-'));
        ownedProfileDir = smokeUserDataDir;
    }
    const reportPath = join(smokeUserDataDir, REPORT_FILE);
    const shotPath = join(smokeUserDataDir, SCREENSHOT_FILE);
    for (const f of [reportPath, shotPath]) { try { unlinkSync(f); } catch { /* none */ } }

    const launch = {
        args: [SMOKE_TEST_ARG, `--user-data-dir=${smokeUserDataDir}`],
        // CIPHERLINE_SMOKE_TEST selects smoke mode together with the argument above
        // (electron/smoke-mode.ts): updater, keystore persistence and the staging lock are off.
        env: { ...process.env, CIPHERLINE_SMOKE_TEST: '1' },
    };
    // Linux CI runs the unpacked tree, whose chrome-sandbox helper is not set-uid
    // root; Playwright's Electron driver used to add this for every launch.
    if (platform() === 'linux') launch.args.push('--no-sandbox');

    let child;
    let output = '';
    try {
        child = spawn(executablePath, launch.args, { env: launch.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        console.error('[smoke] Failed to launch:', err?.message ?? err);
        process.exit(1);
    }
    const keep = (chunk) => { output = (output + chunk.toString()).slice(-16_000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    child.on('error', (e) => { exited = { code: null, signal: null, error: e }; });

    let exitCode = 1;
    try {
        let report = null;
        const readReport = () => {
            if (!existsSync(reportPath)) return null;
            try { return JSON.parse(readFileSync(reportPath, 'utf8')); } catch { return null; /* partial write: retry */ }
        };
        while (Date.now() - t0 < TIMEOUT_MS && !report) {
            report = readReport();
            if (!report && exited) { report = readReport(); break; }
            if (!report) await sleep(200);
        }

        // Best-effort debugging aid; never part of the verdict.
        if (existsSync(shotPath)) {
            try {
                const out = join(root, 'release', `smoke-${platform()}.png`);
                copyFileSync(shotPath, out);
                console.log(`[smoke] Screenshot saved: ${out}`);
            } catch (e) {
                console.warn('[smoke] Screenshot copy failed (non-fatal):', e?.message ?? e);
            }
        }

        if (!report) {
            const why = exited
                ? `the app exited before reporting (${exited.error ? exited.error.message : `code ${exited.code}, signal ${exited.signal}`})`
                : `no first-paint report within ${TIMEOUT_MS} ms`;
            console.error(`[smoke] Failed: ${why}`);
            if (output.trim()) console.error(`[smoke] app output (tail):\n${output.trim().split('\n').slice(-40).join('\n')}`);
        } else if (report.status !== 'painted') {
            console.error(`[smoke] Failed: ${report.status}${report.detail ? ` - ${report.detail}` : ''}`);
            for (const e of report.consoleErrors ?? []) console.error(`  - ${e}`);
        } else {
            console.log('[smoke] First window painted');
            if (!report.ok || (report.consoleErrors ?? []).length > 0) {
                console.error(`[smoke] ${(report.consoleErrors ?? []).length} console error(s):`);
                for (const e of report.consoleErrors ?? []) console.error(`  - ${e}`);
                exitCode = 1; // console errors = broken state we must not ship
            } else {
                console.log(`[smoke] OK in ${Date.now() - t0}ms`);
                exitCode = 0;
            }
        }
    } finally {
        killTree(child);
        if (ownedProfileDir) {
            // Give the OS a moment to release the profile's files after the kill.
            await sleep(500);
            try { rmSync(ownedProfileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
    process.exit(exitCode);
})();
