/**
 * Test helper (excluded from the electron build by tsconfig.electron.json's
 * `electron/test-*.ts`): observe the process's REAL `unhandledRejection`
 * events for the duration of `fn`.
 *
 * vitest installs its own `unhandledRejection` listener and fails the run on
 * one, so the existing listeners are set aside while a capture is open and put
 * back afterwards. That lets a test prove — with a genuinely rejected promise,
 * not a mock — that code does or does not leak one.
 */
// Real timers, captured at import: a test may have fake timers installed by the
// time it calls in, and the settle wait must not depend on them.
const realSetTimeout = globalThis.setTimeout;
const realSetImmediate = globalThis.setImmediate;

/** Poll (real timers) until `pred()` holds; for events that arrive after real I/O, whose timing varies with machine load. */
export async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
        if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
        await new Promise<void>((r) => realSetTimeout(r, 5));
    }
}

export async function captureUnhandledRejections(fn: () => Promise<void>, settleMs = 40): Promise<unknown[]> {
    const saved = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    const seen: unknown[] = [];
    const listener = (reason: unknown) => { seen.push(reason); };
    process.on('unhandledRejection', listener);
    try {
        await fn();
        // Node reports unhandled rejections after the microtask queue drains;
        // give it (and any late timers) a few turns.
        await new Promise<void>((r) => realSetTimeout(r, settleMs));
        await new Promise<void>((r) => realSetImmediate(r));
    } finally {
        process.removeListener('unhandledRejection', listener);
        for (const l of saved) process.on('unhandledRejection', l as (...a: unknown[]) => void);
    }
    return seen;
}
