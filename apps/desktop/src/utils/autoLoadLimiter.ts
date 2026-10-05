/**
 * Bounds how many AUTO-triggered image fetches run at once.
 *
 * A busy channel can render dozens of `ImageLinkEmbed`s at once (channel
 * switch, scrollback load). If every one of them auto-loads (see
 * usePrivacySettings' `imageAutoLoad`), that's dozens of simultaneous
 * `net:fetch-binary` IPC round-trips into the Electron main process at
 * once. This is a plain FIFO semaphore, applied ONLY to auto-triggered
 * loads — a load the user explicitly clicked always runs immediately,
 * uncontended, because they're waiting on it right now.
 *
 * Deliberately not viewport-based (IntersectionObserver): ChatPane's
 * message list isn't virtualized in a way this module can assume, and a
 * concurrency cap is simpler, needs no DOM wiring, and bounds the same
 * worst case (every image in a long channel history) regardless.
 */

const MAX_CONCURRENT_AUTO_LOADS = 4;

let active = 0;
const queue: Array<() => void> = [];

/** Resolves once a slot is free, with a release function to call when the
 *  caller's fetch (success OR failure) is done. Always release exactly
 *  once — a leaked slot permanently shrinks the effective limit. */
export function acquireAutoLoadSlot(): Promise<() => void> {
    return new Promise(resolve => {
        const grant = () => {
            active++;
            let released = false;
            resolve(() => {
                if (released) return;
                released = true;
                active--;
                const next = queue.shift();
                if (next) next();
            });
        };
        if (active < MAX_CONCURRENT_AUTO_LOADS) grant();
        else queue.push(grant);
    });
}

/** Test-only: drain any pending state between test cases. */
export function _resetAutoLoadLimiterForTests(): void {
    active = 0;
    queue.length = 0;
}
