/**
 * A call must not end because a microphone (or camera) could not be opened.
 *
 * LiveKitRoom publishes the mic right after the signal connection when it is
 * mounted with `audio`, and reports a failure through the same `onError` as a
 * failed connection. CallPane used to treat every `onError` as "couldn't
 * connect" and leave, so on a computer with no microphone (a desktop without a
 * headset, a VM, a disabled or busy device) every call ended at 0:00 with
 * "Call connection failed: Requested device not found" — while the room itself
 * had connected fine (Linux VM matrix 2026-11-09: Fedora 44 and Ubuntu 24.04
 * with no capture device, staging.213). The fix: those errors mean "join with
 * that device off", like a member whose token has no mic grant.
 *
 * Only DEVICE errors qualify. `NotAllowedError` (permission refused) keeps its
 * existing meaning and reporting; a connection / signalling / E2EE error is not
 * a DOMException with these names.
 */

/** getUserMedia / LiveKit createLocalTracks failures that mean "this device can't be opened right now". */
const DEVICE_ERROR_NAMES = new Set(['NotFoundError', 'NotReadableError', 'OverconstrainedError', 'DevicesNotFoundError', 'TrackStartError']);

export function isMediaDeviceUnavailableError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const name = (err as { name?: unknown }).name;
    return typeof name === 'string' && DEVICE_ERROR_NAMES.has(name);
}

/** What the person is told. `videoRequested`: the room was also asked to start the camera, so it may be either. */
export function describeMediaDeviceUnavailable(err: unknown, videoRequested: boolean): { title: string; message: string } {
    const name = (err as { name?: unknown } | null)?.name;
    const busy = name === 'NotReadableError' || name === 'TrackStartError';
    if (videoRequested) {
        return {
            title: busy ? 'Microphone or camera is busy' : 'No microphone or camera found',
            message: 'You joined the call with it off. Check the device in Settings → Voice & Video, then turn it on from the call controls.',
        };
    }
    return {
        title: busy ? 'Your microphone is busy' : 'No microphone found',
        message: 'You joined the call muted, so you can still listen. Plug one in or pick another in Settings → Voice & Video, then unmute.',
    };
}
