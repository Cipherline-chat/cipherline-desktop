/**
 * Does the source a live share is switching to actually open?
 *
 * A fresh republish takes the running share down before it acquires the new capture,
 * so a source that refuses (a window that closed, or one the OS will not capture) used
 * to end the share outright: viewers were thrown out and the streamer had nothing on
 * air, over a pick that changed nothing. Opening the new source once first means a bad
 * pick costs a notice and nothing else.
 *
 * Only for a change of SOURCE. The same source is already proven by the share running
 * from it, and a resolution change should not pay for a second capture.
 */

/** Needs main's cooperation, so it must not be able to hang a live share. */
export const SHARE_PROBE_TIMEOUT_MS = 10_000;

export type ShareProbeResult = { ok: true } | { ok: false; error: unknown };

const stop = (stream: MediaStream | undefined) => {
    for (const t of stream?.getTracks() ?? []) {
        try { t.stop(); } catch { /* already stopped */ }
    }
};

/** Opens the capture and closes it again. Never throws; nothing is left running either way. */
export async function probeShareSource(
    open: () => Promise<MediaStream>,
    timeoutMs = SHARE_PROBE_TIMEOUT_MS,
): Promise<ShareProbeResult> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const opening = open();
    try {
        const stream = await Promise.race([
            opening,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    reject(new Error('getDisplayMedia handshake timed out'));
                }, timeoutMs);
            }),
        ]);
        const hasVideo = stream.getVideoTracks().length > 0;
        stop(stream);
        return hasVideo ? { ok: true } : { ok: false, error: new Error('getDisplayMedia returned no video track') };
    } catch (error) {
        // Losing the race does not cancel the request: stop whatever it eventually yields.
        if (timedOut) void opening.then(stop, () => { /* it failed after all */ });
        return { ok: false, error };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
