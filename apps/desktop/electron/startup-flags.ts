/**
 * Startup flags — the few user settings the main process has to know BEFORE
 * `app.ready`, because they become Chromium command-line switches and
 * Chromium reads those only once, at startup.
 *
 * Today that is the two screen-capture test switches (see ./capture-flags.ts):
 *   - `screenCapturer`: which Windows screen capturer Chromium uses
 *     (auto / DXGI Desktop Duplication / Windows.Graphics.Capture).
 *   - `captureLog`:     Chromium's per-frame capture-timing log, read back by
 *     the stream-stats overlay's `grab` row.
 * Both are set from Settings → Advanced and take effect on the next launch.
 *
 * And one user-facing setting whose launch-time half lives here:
 *   - `gamingVideo`:    Settings → Voice & Video → "Prioritize call video
 *     while gaming" (./gaming-video-mode.ts). Its Chromium switches apply on
 *     the next launch; its runtime half (process priority during a call, the
 *     camera's degradation preference) follows the SAVED value immediately.
 *
 * ── Why a plain JSON file and not SecureStore / secureLocalStore ─────────
 * They are read at the top of main.ts, before `app.ready`. SecureStore needs
 * `safeStorage`, which is not usable before ready, and secureLocalStore lives
 * in the renderer. So they live in `<userData>/startup-flags.json`: NOT
 * secret (two enum/boolean values, nothing about the user or their content),
 * machine-specific (hence also not in backups — nothing in the renderer
 * persists them, so backupRegistry.ts has no key to classify), and the SINGLE
 * source of truth: the renderer reads and writes it only through main
 * (`app:get-startup-flags` / `app:set-startup-flags`), so the Settings UI and
 * the switches main applied can never disagree about what is saved.
 *
 * ── Precedence ───────────────────────────────────────────────────────────
 *   environment variable  >  startup-flags.json  >  default
 * `CIPHERLINE_SCREEN_CAPTURER` is honoured in every build (it was before this
 * file existed). `CIPHERLINE_CAPTURE_LOG` is honoured only in an UNPACKAGED
 * build, as before — a packaged build turns the log on from Settings only.
 *
 * Deliberately free of any `electron` import so it is unit testable
 * (startup-flags.test.ts); main.ts supplies the paths and the environment.
 * Nothing in here throws on bad input from disk: a startup-time settings file
 * that could crash the app before a window exists would be unrecoverable for
 * a user who cannot delete files in %APPDATA%.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseScreenCapturerPref, type ScreenCapturerPref } from './capture-flags';

export const STARTUP_FLAGS_FILENAME = 'startup-flags.json';
/** Anything bigger than this is not a file we wrote — ignore it unread. */
export const STARTUP_FLAGS_MAX_BYTES = 4 * 1024;

/** The capture-timing log, and the previous launch's copy (one generation). */
export const CAPTURE_LOG_FILENAME = 'capture-debug.log';
export const CAPTURE_LOG_PREV_FILENAME = 'capture-debug.prev.log';
/** Cap per file. Enforced at startup (rotation) and while running (see
 *  enforceCaptureLogCap). At a 60 fps share Chromium writes ~30 KB/s of
 *  timing lines, so this is a few minutes of history — far more than the
 *  overlay's 512 KB read window needs. */
export const CAPTURE_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface StartupFlags {
    screenCapturer: ScreenCapturerPref;
    captureLog: boolean;
    /** "Prioritize call video while gaming" — see ./gaming-video-mode.ts. */
    gamingVideo: boolean;
}

export const DEFAULT_STARTUP_FLAGS: Readonly<StartupFlags> = Object.freeze({
    screenCapturer: 'auto',
    captureLog: false,
    gamingVideo: false,
});

const CAPTURERS: ReadonlySet<string> = new Set<ScreenCapturerPref>(['auto', 'dxgi', 'wgc']);
const KNOWN_KEYS: ReadonlySet<string> = new Set<keyof StartupFlags>(['screenCapturer', 'captureLog', 'gamingVideo']);

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `startup-flags.json` text → flags. Strict per field: only the exact values
 * this app writes are accepted, and any field that is missing, of the wrong
 * type, or an unknown value falls back to ITS default (so one bad field does
 * not reset the other). Unknown keys are ignored. Malformed JSON, a non-object,
 * or oversized text → all defaults. Never throws.
 */
export function parseStartupFlags(text: string | null | undefined): StartupFlags {
    const out: StartupFlags = { ...DEFAULT_STARTUP_FLAGS };
    if (typeof text !== 'string' || text.length === 0 || text.length > STARTUP_FLAGS_MAX_BYTES) return out;
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return out; }
    if (!isPlainObject(raw)) return out;
    if (own(raw, 'screenCapturer') && typeof raw.screenCapturer === 'string' && CAPTURERS.has(raw.screenCapturer)) {
        out.screenCapturer = raw.screenCapturer as ScreenCapturerPref;
    }
    if (own(raw, 'captureLog') && raw.captureLog === true) out.captureLog = true;
    if (own(raw, 'gamingVideo') && raw.gamingVideo === true) out.gamingVideo = true;
    return out;
}

/**
 * A renderer-supplied change (`app:set-startup-flags`). This one THROWS on
 * anything but a plain object holding only known keys with exactly-typed
 * values: it is a trust boundary, and a malformed request is rejected rather
 * than coerced (CLAUDE.md — "Reject malformed input; never silently coerce").
 */
export function validateStartupFlagsPatch(input: unknown): Partial<StartupFlags> {
    if (!isPlainObject(input)) throw new Error('startup flags: expected an object');
    const out: Partial<StartupFlags> = {};
    for (const k of Object.keys(input)) {
        if (!KNOWN_KEYS.has(k)) throw new Error(`startup flags: unknown key ${JSON.stringify(k).slice(0, 40)}`);
    }
    if (own(input, 'screenCapturer')) {
        const v = input.screenCapturer;
        if (typeof v !== 'string' || !CAPTURERS.has(v)) throw new Error('startup flags: bad screenCapturer');
        out.screenCapturer = v as ScreenCapturerPref;
    }
    if (own(input, 'captureLog')) {
        if (typeof input.captureLog !== 'boolean') throw new Error('startup flags: bad captureLog');
        out.captureLog = input.captureLog;
    }
    if (own(input, 'gamingVideo')) {
        if (typeof input.gamingVideo !== 'boolean') throw new Error('startup flags: bad gamingVideo');
        out.gamingVideo = input.gamingVideo;
    }
    return out;
}

/** Only the known fields, in a fixed order — never echoes anything else to disk. */
export function serializeStartupFlags(f: StartupFlags): string {
    return JSON.stringify({
        screenCapturer: f.screenCapturer,
        captureLog: f.captureLog === true,
        gamingVideo: f.gamingVideo === true,
    }, null, 2) + '\n';
}

/** Synchronous read for the top of main.ts. Missing / unreadable / not a
 *  regular file / oversized → defaults. Never throws. */
export function readStartupFlagsFile(filePath: string): StartupFlags {
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile() || st.size > STARTUP_FLAGS_MAX_BYTES) return { ...DEFAULT_STARTUP_FLAGS };
        return parseStartupFlags(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return { ...DEFAULT_STARTUP_FLAGS };
    }
}

/** Write via temp file + rename, so a crash mid-write leaves the old file
 *  (or none) rather than a truncated one. Throws on I/O failure — the caller
 *  is an IPC handler, and the Settings UI should see the error. */
export function writeStartupFlagsFile(filePath: string, flags: StartupFlags): void {
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, serializeStartupFlags(flags), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
}

export type StartupFlagSource = 'env' | 'file' | 'default';

export interface ResolvedStartupFlags extends StartupFlags {
    /** Where each value came from — the Settings UI says so when an env var
     *  is overriding the saved choice. */
    source: { screenCapturer: StartupFlagSource; captureLog: StartupFlagSource; gamingVideo: StartupFlagSource };
}

/** env > file > default. See the header for which env vars count when. */
export function resolveStartupFlags(opts: {
    file: StartupFlags;
    env: { CIPHERLINE_SCREEN_CAPTURER?: string; CIPHERLINE_CAPTURE_LOG?: string };
    packaged: boolean;
}): ResolvedStartupFlags {
    const { file, env, packaged } = opts;

    let screenCapturer: ScreenCapturerPref;
    let capSrc: StartupFlagSource;
    if ((env.CIPHERLINE_SCREEN_CAPTURER ?? '').trim() !== '') {
        screenCapturer = parseScreenCapturerPref(env.CIPHERLINE_SCREEN_CAPTURER);
        capSrc = 'env';
    } else if (file.screenCapturer !== DEFAULT_STARTUP_FLAGS.screenCapturer) {
        screenCapturer = file.screenCapturer;
        capSrc = 'file';
    } else {
        screenCapturer = DEFAULT_STARTUP_FLAGS.screenCapturer;
        capSrc = 'default';
    }

    let captureLog: boolean;
    let logSrc: StartupFlagSource;
    if (!packaged && (env.CIPHERLINE_CAPTURE_LOG ?? '').trim() !== '') {
        captureLog = env.CIPHERLINE_CAPTURE_LOG!.trim() === '1';
        logSrc = 'env';
    } else if (file.captureLog !== DEFAULT_STARTUP_FLAGS.captureLog) {
        captureLog = file.captureLog;
        logSrc = 'file';
    } else {
        captureLog = DEFAULT_STARTUP_FLAGS.captureLog;
        logSrc = 'default';
    }

    // No environment override: a user setting, not a test knob.
    const gamingVideo = file.gamingVideo === true;
    const gvSrc: StartupFlagSource = gamingVideo !== DEFAULT_STARTUP_FLAGS.gamingVideo ? 'file' : 'default';

    return {
        screenCapturer, captureLog, gamingVideo,
        source: { screenCapturer: capSrc, captureLog: logSrc, gamingVideo: gvSrc },
    };
}

const unlinkQuiet = (p: string): void => { try { fs.unlinkSync(p); } catch { /* absent */ } };

/**
 * Startup housekeeping for the capture log in `dir`. Never throws.
 *   - Off: delete the log and its previous generation — nothing stale is left
 *     lying around once the user turns troubleshooting off.
 *   - On:  keep the last launch's log as `capture-debug.prev.log` (only if it
 *     is within the cap — an oversized one is dropped), then start this
 *     launch's log empty so the overlay only ever parses this run.
 */
export function prepareCaptureLogFiles(dir: string, enabled: boolean, maxBytes = CAPTURE_LOG_MAX_BYTES): void {
    const cur = path.join(dir, CAPTURE_LOG_FILENAME);
    const prev = path.join(dir, CAPTURE_LOG_PREV_FILENAME);
    if (!enabled) {
        unlinkQuiet(cur);
        unlinkQuiet(prev);
        return;
    }
    unlinkQuiet(prev);
    try {
        const st = fs.statSync(cur);
        if (st.isFile() && st.size > 0 && st.size <= maxBytes) fs.renameSync(cur, prev);
    } catch { /* no previous log */ }
    try { fs.writeFileSync(cur, ''); } catch { /* Chromium creates it */ }
}

/**
 * Running-time cap: Chromium appends to the log for as long as a share runs
 * and has no size limit of its own, so main calls this on a timer. Past the
 * cap the file is truncated to zero (Chromium opens it for APPEND — O_APPEND
 * on POSIX, FILE_APPEND_DATA with write-sharing on Windows — so its next line
 * simply lands at the new end). The overlay then needs ~10 fresh frames
 * before it shows numbers again, a sub-second gap. Resolves true if it
 * truncated. Never rejects.
 */
export async function enforceCaptureLogCap(filePath: string, maxBytes = CAPTURE_LOG_MAX_BYTES): Promise<boolean> {
    try {
        const st = await fs.promises.stat(filePath);
        if (st.size <= maxBytes) return false;
        await fs.promises.truncate(filePath, 0);
        return true;
    } catch {
        return false;
    }
}
