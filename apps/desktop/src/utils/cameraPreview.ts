/**
 * Settings → Voice & Video camera preview: which camera to open, and what to do
 * when it is not there.
 *
 * The preview used to open with `video: { deviceId: <stored string> }`. A bare
 * string is an `ideal` constraint, which Chromium treats as advisory: it is
 * weighed against the preview's own `ideal` width/height and the OS ordering,
 * so picking a second camera kept showing the first. (The mic test had the same
 * bug and was fixed the same way — see micDeviceConstraint in audioInput.ts.)
 * A call never had it: LiveKit wraps a string deviceId in `{ exact }` itself.
 *
 * The rules, all pure so they can be tested without a DOM (vitest runs in a
 * node environment here):
 *   • a concrete pick is requested with `{ exact }` — the only form Chromium
 *     honours;
 *   • "follow the system default" ('' / 'default' / nothing stored) is NO
 *     deviceId at all — `{ exact: 'default' }` is unsatisfiable where Chromium
 *     exposes no 'default' video row;
 *   • a pick that is gone (unplugged, re-enumerated) makes the exact request
 *     fail with OverconstrainedError / NotFoundError; the preview then opens
 *     the default camera and says so, instead of an error screen. The stored
 *     pick is left alone, so replugging the camera brings it back.
 */
import { DEFAULT_CAMERA_ID } from './cameraInput';

/** Preview capture size (an `ideal`: a camera that cannot do it still opens). */
const PREVIEW_SIZE = { width: { ideal: 1280 }, height: { ideal: 720 } } as const;

/** Does this stored value name one particular camera (as opposed to "the default")? */
export function isConcreteCameraPick(stored: string | null | undefined): stored is string {
    return !!stored && stored !== DEFAULT_CAMERA_ID;
}

/** The `video` constraint for the preview. `pick` null = the system default camera. */
export function cameraPreviewConstraints(pick: string | null): MediaTrackConstraints {
    return isConcreteCameraPick(pick)
        ? { deviceId: { exact: pick }, ...PREVIEW_SIZE }
        : { ...PREVIEW_SIZE };
}

/** The errors getUserMedia throws when the requested device cannot be used because it is not there. */
export function isCameraGoneError(e: unknown): boolean {
    const name = (e as { name?: unknown } | null)?.name;
    return name === 'OverconstrainedError' || name === 'NotFoundError';
}

/** A line for the preview's error state. Never echoes the raw error (it can carry a device label). */
export function describeCameraPreviewError(e: unknown): string {
    switch ((e as { name?: unknown } | null)?.name) {
        case 'NotFoundError':
        case 'OverconstrainedError': return 'No camera found';
        case 'NotAllowedError':
        case 'SecurityError': return 'Camera access denied';
        case 'NotReadableError':
        case 'AbortError': return 'Camera is busy — close any other app using it';
        default: return 'Camera unavailable';
    }
}

export interface OpenedCameraPreview {
    stream: MediaStream;
    /** The camera that was asked for but is not available, so the default opened instead; else null. */
    fellBackFrom: string | null;
}

/**
 * Open the preview stream for the stored pick. A missing pick falls back to the
 * system default camera once; any other failure (permission, camera busy, no
 * camera at all) is thrown for describeCameraPreviewError.
 */
export async function openCameraPreview(
    stored: string | null | undefined,
    getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>,
): Promise<OpenedCameraPreview> {
    if (!isConcreteCameraPick(stored)) {
        return { stream: await getUserMedia({ video: cameraPreviewConstraints(null) }), fellBackFrom: null };
    }
    try {
        return { stream: await getUserMedia({ video: cameraPreviewConstraints(stored) }), fellBackFrom: null };
    } catch (e) {
        if (!isCameraGoneError(e)) throw e;
        return { stream: await getUserMedia({ video: cameraPreviewConstraints(null) }), fellBackFrom: stored };
    }
}

/**
 * After a `devicechange`: should the running preview be reopened?
 *   • its camera is no longer in the list (unplugged) or its track ended;
 *   • or it is showing the fallback and the pick is back (replugged).
 * `openedId` is the camera the live track reports (getSettings().deviceId).
 */
export function shouldReopenPreview(args: {
    stored: string | null | undefined;
    openedId: string | null;
    trackLive: boolean;
    fellBack: boolean;
    available: readonly Pick<MediaDeviceInfo, 'deviceId'>[];
}): boolean {
    const { stored, openedId, trackLive, fellBack, available } = args;
    // Placeholder list (no permission yet): ids are blank, nothing can be concluded from it.
    if (!available.some(d => d.deviceId !== '')) return !trackLive;
    if (!trackLive) return true;
    if (openedId && !available.some(d => d.deviceId === openedId)) return true;
    if (fellBack && isConcreteCameraPick(stored) && available.some(d => d.deviceId === stored)) return true;
    return false;
}
