/**
 * Script attribution for the freeze log — WHICH of our functions blocked the
 * renderer, from Chromium's Long Animation Frames API (LoAF,
 * `PerformanceObserver` type 'long-animation-frame').
 *
 * The long-task observer freezeLog.ts used before this only said THAT the
 * thread was blocked for N ms; the activity labels said what phase of the app
 * overlapped it. A LoAF entry also lists the scripts that ran in the frame,
 * each with its source file, function name, character offset, what invoked it
 * (an event listener, a timer, a promise continuation, React's MessagePort
 * scheduler) and how long it ran. That is what turns "a 1.4 s freeze while
 * typing in view:server" into "ChatPane.tsx:handleChange, 1.3 s".
 *
 * PRIVACY — everything here is reduced to code identifiers before it leaves
 * this module, and is re-validated downstream (main's LABEL_RE, the report
 * scrubber, the API re-scrub):
 *   - file: the BASENAME of a script served from our own origin only
 *     (`index-B4xYz12a.js`, `Dashboard.tsx`). No directory (a packaged build's
 *     path names the Windows account), no query, no host. Anything else —
 *     another origin, a blob:, an extension, no URL at all — is a fixed word
 *     ('ext' / 'none'), never the URL.
 *   - fn: the function NAME as written in our code (minified in a packaged
 *     build — `char` then locates it in that build's bundle). Characters
 *     outside [A-Za-z0-9_] are replaced.
 *   - invoker: reduced to `<Interface>.<member>` (`DIV.onkeydown`,
 *     `Window.requestAnimationFrame`, `MessagePort.onmessage`). Chromium's
 *     raw invoker can carry an element id or a `[src=…]` attribute (an avatar
 *     or attachment URL); both are dropped, and a script-load invoker (whose
 *     invoker IS a URL) becomes the fixed word 'script'.
 * No arguments, no DOM text, no data of any kind.
 */

/** One `scripts[]` entry of a LoAF entry (the fields we read). */
export interface LoafScriptLike {
    invoker?: string;
    invokerType?: string;
    sourceURL?: string;
    sourceFunctionName?: string;
    sourceCharPosition?: number;
    duration?: number;
    forcedStyleAndLayoutDuration?: number;
}

/** A 'long-animation-frame' PerformanceEntry (the fields we read). */
export interface LoafEntryLike {
    startTime: number;
    duration: number;
    blockingDuration?: number;
    renderStart?: number;
    styleAndLayoutStart?: number;
    scripts?: readonly LoafScriptLike[];
}

export interface ScriptAttribution {
    file: string;
    fn: string;
    /** Character offset of the function in `file` (-1 if unknown). */
    char: number;
    invoker: string;
    invokerType: string;
    ms: number;
    layoutMs: number;
}

export interface FrameAttribution {
    ms: number;
    blockingMs: number;
    /** Rendering (rAF callbacks, style, layout, paint) at the end of the frame. */
    renderMs: number;
    /** Forced (synchronous) style + layout inside scripts, summed. */
    layoutMs: number;
    scriptMs: number;
    /** Scripts in the frame, longest first, at most MAX_SCRIPTS. */
    scripts: ScriptAttribution[];
    scriptCount: number;
}

export const MAX_SCRIPTS = 3;
const FILE_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const INVOKER_TYPES = new Set(['user-callback', 'event-listener', 'resolve-promise', 'reject-promise', 'classic-script', 'module-script']);

/** Basename of a script on OUR origin, or a fixed word. Never a URL. */
export function scriptFile(sourceURL: string | undefined, ownOrigin: string | null): string {
    if (!sourceURL) return 'none';
    let u: URL;
    try { u = new URL(sourceURL); } catch { return 'ext'; }
    if (!ownOrigin || u.origin !== ownOrigin || (u.protocol !== 'http:' && u.protocol !== 'https:')) return 'ext';
    const base = u.pathname.split('/').pop() ?? '';
    let decoded = base;
    try { decoded = decodeURIComponent(base); } catch { /* keep raw */ }
    return FILE_RE.test(decoded) ? decoded : 'unknown';
}

/** A function name as a plain identifier (≤ 32 chars), or 'anon'. */
export function scriptFn(name: string | undefined): string {
    const s = (name ?? '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
    return s || 'anon';
}

/** `<Interface>.<member>` from Chromium's invoker string; never an id, attribute or URL. */
export function scriptInvoker(invoker: string | undefined, invokerType: string | undefined): string {
    if (invokerType === 'classic-script' || invokerType === 'module-script') return 'script';
    const raw = (invoker ?? '').trim();
    // Drop attribute selectors (`IMG[src=https://…]`) before anything else.
    // Chromium names the document target `#document` (`#document.onvisibilitychange`).
    const noAttrs = raw.replace(/\[[^\]]*\]/g, '').replace(/^#document\b/, 'document');
    const head = /^([A-Za-z][A-Za-z0-9]{0,30})/.exec(noAttrs)?.[1];
    const tail = /[.:]([A-Za-z][A-Za-z0-9]{0,40})$/.exec(noAttrs)?.[1];
    if (head && tail && head !== tail) return `${head}.${tail}`.slice(0, 48);
    if (head) return head;
    return INVOKER_TYPES.has(invokerType ?? '') ? invokerType! : 'unknown';
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Reduce a LoAF entry to code identifiers and durations. */
export function attributeFrame(entry: LoafEntryLike, ownOrigin: string | null): FrameAttribution {
    const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
    const all: ScriptAttribution[] = scripts.map(s => ({
        file: scriptFile(s.sourceURL, ownOrigin),
        fn: scriptFn(s.sourceFunctionName),
        char: typeof s.sourceCharPosition === 'number' && Number.isInteger(s.sourceCharPosition) && s.sourceCharPosition >= 0 ? s.sourceCharPosition : -1,
        invoker: scriptInvoker(s.invoker, s.invokerType),
        invokerType: INVOKER_TYPES.has(s.invokerType ?? '') ? s.invokerType! : 'unknown',
        ms: Math.round(num(s.duration)),
        layoutMs: Math.round(num(s.forcedStyleAndLayoutDuration)),
    }));
    const duration = num(entry.duration);
    const renderStart = num(entry.renderStart);
    const renderMs = renderStart > 0 ? Math.max(0, entry.startTime + duration - renderStart) : 0;
    return {
        ms: Math.round(duration),
        blockingMs: Math.round(num(entry.blockingDuration)),
        renderMs: Math.round(renderMs),
        layoutMs: all.reduce((a, s) => a + s.layoutMs, 0),
        scriptMs: all.reduce((a, s) => a + s.ms, 0),
        scripts: [...all].sort((a, b) => b.ms - a.ms).slice(0, MAX_SCRIPTS),
        scriptCount: all.length,
    };
}

const LABEL_RE = /^[a-z][a-z0-9_.:-]{0,63}$/i;

/**
 * Freeze-log labels for a frame: one `js:<file>:<fn>:c<char>:<ms>ms` per top
 * script (≤ 2), the top script's invoker as `via:<invoker>`, and the
 * rendering share when it is large. Every label satisfies LABEL_RE (main
 * re-checks it); a label that would not is shortened or dropped.
 */
export function frameLabels(a: FrameAttribution): string[] {
    const out: string[] = [];
    for (const s of a.scripts.slice(0, 2)) {
        if (s.ms < 1) continue;
        const tail = `${s.char >= 0 ? `:c${s.char}` : ''}:${s.ms}ms`;
        const file = s.file.slice(0, 28);
        let label = `js:${file}:${s.fn}${tail}`;
        if (label.length > 64) label = `js:${file}:${s.fn.slice(0, Math.max(1, 64 - (`js:${file}:`.length + tail.length)))}${tail}`;
        if (LABEL_RE.test(label)) out.push(label);
    }
    const top = a.scripts[0];
    if (top) {
        const via = `via:${top.invoker}`;
        if (LABEL_RE.test(via)) out.push(via);
    }
    if (a.renderMs >= 50) out.push(`render:${a.renderMs}ms`);
    if (a.layoutMs >= 50) out.push(`forced-layout:${a.layoutMs}ms`);
    return out;
}
