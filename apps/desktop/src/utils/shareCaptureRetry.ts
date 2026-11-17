/**
 * Re-acquiring a screen / window capture right after the same source was
 * released can fail transiently: the OS capturer (WGC for a window, DXGI for a
 * display) has not let go yet and getDisplayMedia rejects with NotReadableError
 * (or AbortError). A quality change on a hardware encoder is a FRESH publish
 * (shareLiveRetune.resolutionChangeNeedsFresh) - the live share is torn down
 * first, so that one transient failure used to END the share
 * (staging.229, "Screenshare ended when trying to change quality": share_start
 * why=NotReadableError kept=false; picking the same window again ten seconds
 * later worked). Retry a few times, with backoff, before giving up.
 *
 * NotAllowedError (the user said no) and NotFoundError (the source is gone) are
 * NOT transient and are never retried.
 */
export const CAPTURE_RETRY_DELAYS_MS: readonly number[] = [400, 1_200];

export function isTransientCaptureError(err: unknown): boolean {
    const name = (err as { name?: unknown } | null)?.name;
    return name === 'NotReadableError' || name === 'AbortError';
}

export async function retryTransientCapture<T>(
    attempt: (n: number) => Promise<T>,
    opts: {
        delaysMs?: readonly number[];
        sleep?: (ms: number) => Promise<void>;
        /** Called before each retry (n = 1 for the first retry), with the error that caused it. */
        onRetry?: (n: number, err: unknown) => void;
    } = {},
): Promise<T> {
    const delays = opts.delaysMs ?? CAPTURE_RETRY_DELAYS_MS;
    const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    for (let n = 0; ; n++) {
        try {
            return await attempt(n);
        } catch (err) {
            if (n >= delays.length || !isTransientCaptureError(err)) throw err;
            opts.onRetry?.(n + 1, err);
            await sleep(delays[n]);
        }
    }
}
