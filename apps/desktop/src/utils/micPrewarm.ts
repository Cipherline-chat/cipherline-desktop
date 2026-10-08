/**
 * Open the microphone the moment a join is clicked, instead of after the room's
 * signalling connects.
 *
 * LiveKit only calls getUserMedia for the mic on SignalConnected — i.e. after
 * the join request, the key, and the signalling handshake. Opening an audio
 * device is one of the slower steps on Windows (WASAPI device start; longer
 * still for Bluetooth headsets), and Chromium reuses a device that is already
 * open in the same frame, so holding an identical capture open across the
 * join turns LiveKit's own getUserMedia into a cheap re-open.
 *
 * Bounded on purpose:
 *   - the stream is never attached, published, recorded or read — it only
 *     keeps the device warm; media still leaves this machine solely through
 *     the E2EE room, after the key is installed;
 *   - it is released as soon as the call's own mic publishes, when the join
 *     ends any other way (failure, Leave, listen-only token, muted join), and
 *     unconditionally after PREWARM_MAX_MS no matter what;
 *   - a muted or deafened join never opens it (Dashboard checks before calling).
 *
 * Same constraints as the call itself (MIC_CAPTURE_CONSTRAINTS + the resolved
 * device), so the warm device is the one the call will ask for.
 */
import { MIC_CAPTURE_CONSTRAINTS } from './audioInput';

/** Hard cap on how long a warm-up capture may stay open. */
export const PREWARM_MAX_MS = 12_000;

let stream: MediaStream | null = null;
let pending: Promise<void> | null = null;
let releaseRequested = false;
let capTimer: ReturnType<typeof setTimeout> | null = null;

function stopAll(s: MediaStream | null): void {
    s?.getTracks().forEach(t => { try { t.stop(); } catch { /* already stopped */ } });
}

export function prewarmMic(deviceId: string): void {
    if (stream || pending) return;
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) return;
    releaseRequested = false;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    pending = md.getUserMedia({ audio: { ...MIC_CAPTURE_CONSTRAINTS, deviceId } })
        .then(s => {
            if (releaseRequested) { stopAll(s); return; }
            stream = s;
            const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
            console.info(`[CallJoin] mic warm-up open ${Math.round(ms)}ms`);
            capTimer = setTimeout(releaseMicPrewarm, PREWARM_MAX_MS);
        })
        .catch(() => { /* permission/device errors surface on the call's own capture */ })
        .finally(() => { pending = null; });
}

/** Stop the warm-up capture (idempotent; safe whether or not one is open or in flight). */
export function releaseMicPrewarm(): void {
    releaseRequested = true;
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    stopAll(stream);
    stream = null;
}

/** Test seam. */
export function __micPrewarmStateForTests(): { open: boolean; pending: boolean } {
    return { open: !!stream, pending: !!pending };
}
