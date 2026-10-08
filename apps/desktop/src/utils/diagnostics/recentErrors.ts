/**
 * The last DIAGNOSTIC_LIMITS.maxRecentErrors renderer errors — uncaught
 * `error` events and `unhandledrejection`s — for crash / performance reports.
 *
 * Scrubbed AT CAPTURE: what sits in memory is already the scrubbed text, so a
 * report built later cannot accidentally see the raw message. The capture
 * scrubber is whatever the reporter last installed with setCaptureScrubber()
 * (it carries the signed-in user's names); before that, a term-less scrubber,
 * which still removes paths, URLs, emails, tokens and ids. The report builder
 * scrubs everything once more with the full term list.
 *
 * Cheap by construction: a bounded ring, identical consecutive errors within
 * DEDUPE_MS are counted once, and known-benign browser noise is ignored.
 */
import { createScrubber, type Scrubber } from './scrub';
import { DIAGNOSTIC_LIMITS } from './reportTypes';

export interface CapturedError {
    at: number;
    kind: 'error' | 'unhandledrejection';
    name?: string;
    message: string;
    stack?: string;
}

const DEDUPE_MS = 2_000;
/** Browser noise that is not an app error. */
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i];

let scrubber: Scrubber = createScrubber();
let ring: CapturedError[] = [];

export function setCaptureScrubber(s: Scrubber): void {
    scrubber = s;
}

function describe(value: unknown): { name?: string; message: string; stack?: string } {
    if (value && typeof value === 'object' && 'message' in (value as object)) {
        const e = value as { name?: unknown; message?: unknown; stack?: unknown };
        return {
            name: typeof e.name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(e.name) ? e.name : undefined,
            message: typeof e.message === 'string' ? e.message : String(e.message ?? ''),
            stack: typeof e.stack === 'string' ? e.stack : undefined,
        };
    }
    if (typeof value === 'string') return { message: value };
    try { return { message: JSON.stringify(value) ?? String(value) }; } catch { return { message: '[unserializable]' }; }
}

/** Record one error (exported for tests and for explicit reporting). */
export function captureError(kind: CapturedError['kind'], value: unknown, at: number = Date.now()): void {
    const d = describe(value);
    if (IGNORED.some(re => re.test(d.message))) return;
    const message = scrubber.text(d.message, 1000) || '(no message)';
    const stack = d.stack ? scrubber.stack(d.stack, 25) : undefined;
    const last = ring[ring.length - 1];
    if (last && last.kind === kind && last.message === message && at - last.at < DEDUPE_MS) return;
    ring.push({ at, kind, ...(d.name ? { name: d.name } : {}), message, ...(stack ? { stack } : {}) });
    if (ring.length > DIAGNOSTIC_LIMITS.maxRecentErrors) ring = ring.slice(-DIAGNOSTIC_LIMITS.maxRecentErrors);
}

/** Oldest first. */
export function getRecentErrors(): CapturedError[] {
    return ring.map(e => ({ ...e }));
}

let installed = false;
/** Listen for renderer errors. Idempotent; call once, early (main.tsx). */
export function installRecentErrorCapture(target: Pick<Window, 'addEventListener'> | undefined = typeof window !== 'undefined' ? window : undefined): void {
    if (installed || !target) return;
    installed = true;
    try {
        target.addEventListener('error', (ev: Event) => {
            const e = ev as ErrorEvent;
            captureError('error', e.error ?? e.message);
        });
        target.addEventListener('unhandledrejection', (ev: Event) => {
            captureError('unhandledrejection', (ev as PromiseRejectionEvent).reason);
        });
    } catch { /* no DOM */ }
}

/** Test hook. */
export function __resetRecentErrorsForTests(): void {
    ring = [];
    scrubber = createScrubber();
    installed = false;
}
