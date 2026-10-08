/**
 * Wire format between the main process and the out-of-process screen-share
 * source lister (./sources-helper.ts). Why that process exists: see
 * pickerEnumeration in ./capture-flags.ts.
 *
 * Transport: a local socket the PARENT listens on (a Windows named pipe /
 * a unix socket in a private temp dir), handed to the child through the
 * environment together with a random 256-bit token. Not stdio: an Electron
 * main process on Windows is a GUI-subsystem program, and its standard
 * streams are not something to bet the share picker on. The child's first
 * line must carry the token; the parent accepts exactly one connection and
 * stops listening as soon as it is authenticated.
 *
 * Messages are single-line JSON. Every message from the child is validated
 * here before main uses it — the child is our own code, but its output is
 * still a process boundary and the parent never trusts it blindly.
 *
 * Deliberately free of any `electron` import (unit tested in
 * sources-helper-protocol.test.ts).
 */
import { timingSafeEqual } from 'crypto';
import type { DesktopSourceType } from './desktop-sources';

/** argv marker that makes ./entry.ts run the helper instead of the app. */
export const SOURCES_HELPER_FLAG = '--cipherline-desktop-sources-helper';
/** Environment: the socket address and the token (never on the command line). */
export const SOURCES_HELPER_ENV_ADDRESS = 'CIPHERLINE_SOURCES_HELPER_ADDRESS';
export const SOURCES_HELPER_ENV_TOKEN = 'CIPHERLINE_SOURCES_HELPER_TOKEN';
/** Where the helper keeps Chromium's profile (a private temp dir, removed after). */
export const SOURCES_HELPER_ENV_DATA_DIR = 'CIPHERLINE_SOURCES_HELPER_DATA_DIR';

/** One line can carry dozens of 320x200 JPEG previews; bound it anyway. */
export const SOURCES_HELPER_MAX_LINE_CHARS = 48 * 1024 * 1024;
export const MAX_SOURCES = 512;
export const MAX_NAME_CHARS = 4096;
export const MAX_THUMBNAIL_CHARS = 2 * 1024 * 1024;
export const MAX_THUMBNAIL_EDGE = 4096;

export function isSourcesHelperArgv(argv: readonly string[]): boolean {
    return argv.includes(SOURCES_HELPER_FLAG);
}

/** A desktop source as main uses it, whichever process listed it. */
export interface ListedSource {
    /** Chromium DesktopMediaID string, `screen:<gdiIndex>:0` / `window:<hwnd>:0`. */
    id: string;
    name: string;
    /** electron.screen display id; '' when the lister could not tell. */
    display_id: string;
    /** '' when thumbnails were not requested. */
    thumbnailDataUrl: string;
}

export interface HelperRequest {
    id: number;
    types: DesktopSourceType[];
    thumbnailSize: { width: number; height: number };
}

export type HelperMessage =
    | { kind: 'hello'; token: string; pid: number; disabledFeatures: string }
    | { kind: 'result'; id: number; ok: true; sources: ListedSource[]; ms: number; dropped: number }
    | { kind: 'result'; id: number; ok: false; error: string };

export const encodeLine = (v: unknown): string => JSON.stringify(v) + '\n';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isReqId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isEdge = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_THUMBNAIL_EDGE;

// DesktopMediaID::ToString for screens and windows: `<type>:<id>:<window_id>`.
const SOURCE_ID_RE = /^(screen|window):-?\d{1,20}:-?\d{1,20}$/;
const DISPLAY_ID_RE = /^-?\d{0,20}$/;
const THUMB_RE = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]*={0,2}$/;

/** Child side: a request from the parent. Anything malformed is null (ignored). */
export function parseHelperRequest(line: string): HelperRequest | null {
    let v: unknown;
    try { v = JSON.parse(line); } catch { return null; }
    if (!isObj(v) || !isReqId(v.id) || !Array.isArray(v.types) || !isObj(v.thumbnailSize)) return null;
    if (v.types.length === 0 || v.types.length > 2) return null;
    const types: DesktopSourceType[] = [];
    for (const t of v.types) {
        if (t !== 'screen' && t !== 'window') return null;
        if (!types.includes(t)) types.push(t);
    }
    const { width, height } = v.thumbnailSize;
    if (!isEdge(width) || !isEdge(height)) return null;
    return { id: v.id, types, thumbnailSize: { width, height } };
}

/**
 * One source from the child. A malformed ENTRY is dropped (null) rather than
 * failing the whole list; nothing is coerced — a bad id/name/preview is not
 * repaired, it is refused.
 */
export function parseListedSource(v: unknown): ListedSource | null {
    if (!isObj(v)) return null;
    const { id, name, display_id, thumbnailDataUrl } = v;
    if (typeof id !== 'string' || !SOURCE_ID_RE.test(id)) return null;
    if (typeof name !== 'string' || name.length > MAX_NAME_CHARS) return null;
    if (typeof display_id !== 'string' || !DISPLAY_ID_RE.test(display_id)) return null;
    if (typeof thumbnailDataUrl !== 'string' || thumbnailDataUrl.length > MAX_THUMBNAIL_CHARS) return null;
    if (thumbnailDataUrl !== '' && !THUMB_RE.test(thumbnailDataUrl)) return null;
    return { id, name, display_id, thumbnailDataUrl };
}

/** Parent side: a message from the child, or null when it is not one. */
export function parseHelperMessage(line: string): HelperMessage | null {
    let v: unknown;
    try { v = JSON.parse(line); } catch { return null; }
    if (!isObj(v)) return null;
    if (v.kind === 'hello') {
        if (typeof v.token !== 'string' || v.token.length > 256) return null;
        if (typeof v.pid !== 'number' || !Number.isSafeInteger(v.pid)) return null;
        const disabledFeatures = typeof v.disabledFeatures === 'string' ? v.disabledFeatures.slice(0, 512) : '';
        return { kind: 'hello', token: v.token, pid: v.pid, disabledFeatures };
    }
    if (v.kind === 'result' && isReqId(v.id)) {
        if (v.ok === false) {
            return { kind: 'result', id: v.id, ok: false, error: typeof v.error === 'string' ? v.error.slice(0, 500) : 'unknown error' };
        }
        if (v.ok !== true || !Array.isArray(v.sources) || v.sources.length > MAX_SOURCES) return null;
        const sources: ListedSource[] = [];
        let dropped = 0;
        for (const s of v.sources) {
            const parsed = parseListedSource(s);
            if (parsed) sources.push(parsed); else dropped++;
        }
        const ms = typeof v.ms === 'number' && Number.isFinite(v.ms) && v.ms >= 0 ? v.ms : 0;
        return { kind: 'result', id: v.id, ok: true, sources, ms, dropped };
    }
    return null;
}

/** Constant-time token check (both are hex strings we generated). */
export function tokenMatches(expected: string, got: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(got, 'utf8');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Newline framing over a byte stream. Calls `onLine` per complete line;
 * calls `onOverflow` (once) and stops when a line exceeds `maxChars` — the
 * caller then drops the connection rather than buffer without bound.
 */
export function createLineSplitter(
    onLine: (line: string) => void,
    onOverflow: () => void,
    maxChars = SOURCES_HELPER_MAX_LINE_CHARS,
): (chunk: string) => void {
    let buf = '';
    let dead = false;
    return (chunk: string) => {
        if (dead) return;
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.length > maxChars) { dead = true; buf = ''; onOverflow(); return; }
            if (line.trim()) onLine(line);
        }
        if (buf.length > maxChars) { dead = true; buf = ''; onOverflow(); }
    };
}
