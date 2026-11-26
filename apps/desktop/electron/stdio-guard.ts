/**
 * Pipe-error guards for the main process.
 *
 * A write to a pipe whose reader has gone away fails with EPIPE, but it fails
 * ASYNCHRONOUSLY: `write()` returns, and the error is emitted later as an
 * 'error' event on the stream. A stream 'error' with no listener is thrown as
 * an uncaughtException and kills the main process (0.1.0 crash reports, kind
 * `main_exception`, message `write EPIPE`):
 *   - Linux: `console.error` -> process.stderr after the terminal / launcher
 *     that started the app closed its end of the pipe;
 *   - Windows: `MediaSessionReader.readWindows` -> the win-helper.exe media child's
 *     stdin after the helper exited.
 * A try/catch around `write()` cannot catch either. The fix is a standing
 * 'error' listener on the stream.
 */

interface ErrorEmitter { on(event: 'error', cb: (e: Error) => void): unknown }
interface Consolish { log: (...a: unknown[]) => void; info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; debug: (...a: unknown[]) => void }

/**
 * A listener that swallows the stream's errors. Used for the stdin / stdout /
 * stderr of a spawned helper: a broken pipe there means "the helper is gone",
 * which its 'exit' / 'error' handlers already deal with.
 */
export function swallowStreamErrors(stream: ErrorEmitter | null | undefined, onError?: (e: Error) => void): void {
    if (!stream || typeof stream.on !== 'function') return;
    stream.on('error', (e) => { try { onError?.(e); } catch { /* never throw from an error listener */ } });
}

/**
 * Make this process's own stdout / stderr unable to crash it. Console output
 * is diagnostics only. Once either stream reports a failure (EPIPE, EIO, ...)
 * the console methods become no-ops so nothing keeps writing into a dead pipe.
 * Returns a restore function (for tests).
 */
export function installStdioGuard(
    streams: ErrorEmitter[] = [process.stdout, process.stderr],
    target: Consolish = console as unknown as Consolish,
): () => void {
    const original = { ...target };
    let broken = false;
    const silence = () => {
        if (broken) return;
        broken = true;
        const noop = () => { /* output pipe is gone */ };
        target.log = noop; target.info = noop; target.warn = noop; target.error = noop; target.debug = noop;
    };
    for (const s of streams) swallowStreamErrors(s, silence);
    return () => { broken = false; Object.assign(target, original); };
}
