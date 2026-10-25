/**
 * How the CI smoke test learns that the packaged app painted.
 *
 * scripts/smoke-test.mjs used to drive the app with Playwright's Electron
 * driver. That driver attaches through `--inspect=0` AND
 * `--remote-debugging-port=0`, and the shipped binary now has both switched off
 * (the `EnableNodeCliInspectArguments` fuse, plus ./debug-switches.ts) — and
 * they must stay off in the very binary the smoke test runs, or the gate would
 * be testing a build nobody ships. So in smoke mode (decideSmokeTestMode:
 * `CIPHERLINE_SMOKE_TEST` + `--cipherline-smoke-test` + `--user-data-dir=`) the
 * app reports on itself instead: it watches its own windows and, once one of
 * them has real text in <body>, writes `smoke-report.json` (+ a screenshot)
 * into the throwaway profile directory. The harness launches the binary as a
 * plain child process and reads that file. No debugging channel is opened.
 *
 * Same verdict as before: the renderer must paint something, and ANY console
 * error (incl. uncaught exceptions and CSP violations, which Chromium logs as
 * console errors) fails the run.
 *
 * The decision core (createSmokeReporter) has no `electron` import so it is
 * unit-testable; installSmokeReporter is the thin Electron glue. This file
 * must stay inside electron/ and must not import from ../src (see the
 * rootDir note in tsconfig.electron.json).
 */

import * as nodeFs from 'fs';
import * as nodePath from 'path';
import type { App, WebContents } from 'electron';

export const SMOKE_REPORT_FILENAME = 'smoke-report.json';
export const SMOKE_SCREENSHOT_FILENAME = 'smoke-report.png';
/** Settle window after the first paint, so late async crashes still count (was 2 s in the Playwright harness). */
export const SMOKE_SETTLE_MS = 2000;
const POLL_MS = 250;
const MAX_ERRORS = 50;
const MAX_ERROR_CHARS = 2000;

export interface SmokeReport {
    ok: boolean;
    status: 'painted' | 'crashed' | 'load-failed';
    elapsedMs: number;
    consoleErrors: string[];
    /** Page the report is about (origin + path only is enough for CI; query/hash dropped). */
    url?: string;
    bodyChars?: number;
    detail?: string;
}

export interface SmokeReporter {
    consoleError(text: string): void;
    /** The app window has rendered `bodyChars` characters of text. Call once; reports after the verdict is final. */
    painted(url: string, bodyChars: number): void;
    crashed(detail: string): void;
    loadFailed(detail: string): void;
    readonly finished: boolean;
}

export function createSmokeReporter(deps: { write(json: string): void; now(): number }): SmokeReporter {
    const t0 = deps.now();
    const errors: string[] = [];
    let finished = false;
    const finish = (report: Omit<SmokeReport, 'elapsedMs' | 'consoleErrors'>) => {
        if (finished) return;
        finished = true;
        const full: SmokeReport = { ...report, elapsedMs: deps.now() - t0, consoleErrors: errors.slice() };
        deps.write(JSON.stringify(full));
    };
    return {
        consoleError(text) {
            if (errors.length < MAX_ERRORS) errors.push(String(text).slice(0, MAX_ERROR_CHARS));
        },
        painted(url, bodyChars) {
            finish({ ok: errors.length === 0, status: 'painted', url, bodyChars });
        },
        crashed(detail) { finish({ ok: false, status: 'crashed', detail }); },
        loadFailed(detail) { finish({ ok: false, status: 'load-failed', detail }); },
        get finished() { return finished; },
    };
}

/** Origin + path, no query/hash: a report is a CI log line, not a place for tokens in a URL. */
export function reportableUrl(url: string): string {
    try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return ''; }
}

/** Atomic write: the harness may poll the directory at any moment. */
function writeAtomic(file: string, data: string | Buffer): void {
    const tmp = `${file}.tmp`;
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    nodeFs.writeFileSync(tmp, data);
    nodeFs.renameSync(tmp, file);
}

/**
 * Smoke mode only (the caller checks IS_SMOKE_TEST). Registers before any
 * window exists, so boot-time console errors are seen.
 */
export function installSmokeReporter(app: App): void {
    const dir = app.getPath('userData');
    const reportPath = nodePath.join(dir, SMOKE_REPORT_FILENAME);
    const reporter = createSmokeReporter({
        write: (json) => { try { writeAtomic(reportPath, json); } catch (e) { console.error('[smoke-report] could not write report:', e); } },
        now: Date.now,
    });
    const watched = new WeakSet<WebContents>();
    let verdictStarted = false;

    app.on('web-contents-created', (_event, wc) => {
        if (wc.getType() !== 'window') return;
        // Electron >= 35 passes ONE details object; older builds passed (event, level, message, ...).
        wc.on('console-message', ((...args: unknown[]) => {
            const first = args[0] as { level?: unknown; message?: unknown } | undefined;
            if (first && typeof first === 'object' && 'level' in first) {
                if (first.level === 'error') reporter.consoleError(String(first.message ?? ''));
            } else if (args[1] === 3) {
                reporter.consoleError(String(args[2] ?? ''));
            }
        }) as never);
        wc.on('render-process-gone', (_e, details) => reporter.crashed(`renderer gone: ${details.reason}`));
        wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
            // -3 is ERR_ABORTED: a navigation superseded by another, not a failure.
            if (isMainFrame && code !== -3) reporter.loadFailed(`${desc} (${code}) ${reportableUrl(url)}`);
        });
        wc.on('did-finish-load', () => {
            if (watched.has(wc)) return;
            watched.add(wc);
            const timer = setInterval(() => {
                if (reporter.finished || wc.isDestroyed()) { clearInterval(timer); return; }
                const url = wc.getURL();
                if (!/^https?:/i.test(url)) return; // splash / overlay pages are file: or data:
                wc.executeJavaScript('document.body ? document.body.innerText.trim().length : 0', true)
                    .then(async (chars: unknown) => {
                        if (verdictStarted || reporter.finished || typeof chars !== 'number' || chars <= 0) return;
                        verdictStarted = true;
                        clearInterval(timer);
                        // Let post-mount async work that is going to crash do so, then judge.
                        await new Promise<void>(r => setTimeout(r, SMOKE_SETTLE_MS));
                        // Best-effort debugging aid; never part of the verdict.
                        try {
                            const img = await Promise.race([
                                wc.capturePage(),
                                new Promise<null>(r => setTimeout(() => r(null), 10_000)),
                            ]);
                            if (img && !img.isEmpty()) writeAtomic(nodePath.join(dir, SMOKE_SCREENSHOT_FILENAME), img.toPNG());
                        } catch { /* optional */ }
                        reporter.painted(reportableUrl(url), chars);
                    })
                    .catch(() => { /* page navigating / not ready: next tick */ });
            }, POLL_MS);
        });
    });
}
