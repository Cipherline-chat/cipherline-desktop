// Smoke test for the packaged Electron build.
//
// Runs in CI after electron-builder produces an unpacked binary. Launches
// the binary via Playwright's _electron API, waits for the first window to
// finish loading, asserts the renderer rendered SOMETHING (vs. a white-
// screen-of-death from an unhandled exception in the bundle), captures a
// screenshot, and exits.
//
// What this catches that typecheck doesn't:
//   * Worker / WASM import paths that resolve in dev but not in the asar.
//   * Native addon `__dirname` resolution bugs (asar.unpacked path mismatches).
//   * CSP violations from inline scripts injected by libs.
//   * Auto-updater / secureStore init crashes during boot.
//   * Anything that throws during the React mount before the first paint.
//
// What it doesn't catch: feature regressions, network-dependent flows
// (auth, calls, attachments). Those are out of scope — this is a "did
// the app even start" gate.
//
// Exit codes:
//   0  — app launched, renderer painted within timeout.
//   1  — anything else (timeout, crash, unexpected URL, no window).

import { _electron as electron } from 'playwright-core';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

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

(async () => {
    const executablePath = resolveBinary();
    console.log(`[smoke] Launching: ${executablePath}`);

    const t0 = Date.now();
    let app;
    try {
        app = await electron.launch({
            executablePath,
            // Block any auto-updater check from racing the smoke test —
            // we don't want a network failure during the update probe to
            // shake the test. Empty string opts the renderer back to dev
            // origin handling, which it isn't really, but the env var is
            // only checked for "is set" semantics in main.ts.
            env: {
                ...process.env,
                CIPHERLINE_SMOKE_TEST: '1',
            },
            timeout: TIMEOUT_MS,
        });
    } catch (err) {
        console.error('[smoke] Failed to launch:', err?.message ?? err);
        process.exit(1);
    }

    let exitCode = 1;
    let window;
    const consoleErrors = [];
    try {
        // First window — the main BrowserWindow created by main.ts.
        window = await app.firstWindow({ timeout: TIMEOUT_MS });
        console.log('[smoke] First window opened');

        // P2-ELEC-13: Register console error listener immediately — before any
        // waitFor* calls — so boot-time renderer errors are captured, not just
        // post-paint errors.
        window.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        window.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err?.message ?? err}`));

        // Wait for the renderer to do something measurable. We don't
        // assume a specific element exists (the auth flow has multiple
        // entry screens, gating on AuthContext state) — we just wait for
        // the document body to have any non-empty visible content.
        await window.waitForLoadState('domcontentloaded', { timeout: TIMEOUT_MS });
        await window.waitForFunction(
            () => document.body && document.body.innerText.trim().length > 0,
            { timeout: TIMEOUT_MS },
        );
        console.log('[smoke] Renderer painted');

        // Brief settle window so any post-mount async work that's going
        // to crash has a chance to do so before we declare success.
        await window.waitForTimeout(2000);

        // Best-effort — this has been observed to hang/timeout on the CI
        // runner even after a confirmed-good paint (screenshot capture is
        // unrelated to "did the app boot", just a debugging aid), so it
        // must never fail a smoke test that already passed its real checks.
        try {
            const screenshotPath = join(root, 'release', `smoke-${platform()}.png`);
            await window.screenshot({ path: screenshotPath, timeout: 10_000 });
            console.log(`[smoke] Screenshot saved: ${screenshotPath}`);
        } catch (e) {
            console.warn('[smoke] Screenshot capture failed/timed out (non-fatal):', e?.message ?? e);
        }

        const elapsed = Date.now() - t0;
        if (consoleErrors.length > 0) {
            console.error(`[smoke] ${consoleErrors.length} console error(s):`);
            for (const e of consoleErrors) console.error(`  - ${e}`);
            exitCode = 1; // console errors = broken state we must not ship
        } else {
            console.log(`[smoke] OK in ${elapsed}ms`);
            exitCode = 0;
        }
    } catch (err) {
        console.error('[smoke] Failed:', err?.message ?? err);
        // Best-effort diagnostics — a timeout/crash here is exactly when we
        // most need to see what was on screen and what the console said,
        // but the failure path previously exited blind (no screenshot, no
        // console dump), making every prior CI failure a black box.
        if (consoleErrors.length > 0) {
            console.error(`[smoke] ${consoleErrors.length} console error(s) before failure:`);
            for (const e of consoleErrors) console.error(`  - ${e}`);
        }
        if (window) {
            try {
                const bodyText = await window.evaluate(() => document.body?.innerText ?? '');
                console.error(`[smoke] body innerText at failure (${bodyText.length} chars): ${JSON.stringify(bodyText.slice(0, 500))}`);
            } catch (e2) {
                console.error('[smoke] could not read body innerText:', e2?.message ?? e2);
            }
            try {
                const screenshotPath = join(root, 'release', `smoke-failure-${platform()}.png`);
                await window.screenshot({ path: screenshotPath, timeout: 10_000 });
                console.error(`[smoke] Failure screenshot saved: ${screenshotPath}`);
            } catch (e2) {
                console.error('[smoke] could not capture failure screenshot:', e2?.message ?? e2);
            }
        }
    } finally {
        try { await app.close(); } catch { /* ignore */ }
    }
    process.exit(exitCode);
})();
