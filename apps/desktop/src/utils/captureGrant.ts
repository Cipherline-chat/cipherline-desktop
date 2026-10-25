/**
 * Renderer side of the screen-capture consent grant (electron/capture-consent.ts).
 *
 * When the user chooses a source in OUR picker (or any in-app control that
 * re-shares: change source, quality, audio toggle, the quick-share keybind),
 * the share start asks the main process to mint a one-time grant for exactly
 * that source. The capture that follows - the getDisplayMedia answer
 * (`resolveDesktopSource`) and the native per-app audio start
 * (`startWindowAudioCapture`) - presents the token. Main decides, from real
 * user input it observed itself, whether the grant is spent silently or must be
 * confirmed in a native dialog; none of that is visible here, and a failure to
 * mint is NOT an error: the capture just carries no token and main asks the
 * user itself.
 *
 * Nothing in this file is a security check. The renderer has no load-bearing
 * checks by design; main enforces everything.
 */
import type { ScreenShareOptions } from '../components/ScreenSharePickerModal';

export interface CaptureGrant {
    token: string;
    /** The source the grant was minted for; only the capture of that source may present it. */
    sourceId: string;
}

/** Share options as parked for the getDisplayMedia handshake, plus the grant to present. */
export type PendingShare = ScreenShareOptions & { grantToken?: string | null };

/** Ask main for a grant for this pick. null when unavailable (older main, non-desktop, IPC error). */
export async function mintCaptureGrant(sourceId: string, audio: boolean): Promise<CaptureGrant | null> {
    const api = window.electronAPI;
    if (!api?.captureMintGrant) return null;
    try {
        const res = await api.captureMintGrant(sourceId, audio);
        return res && typeof res.token === 'string' && res.token ? { token: res.token, sourceId } : null;
    } catch (err) {
        console.warn('[ScreenShare] capture grant unavailable; main will ask for confirmation:', err);
        return null;
    }
}

/** The token to present for a capture of `sourceId`: only the grant minted for that very source. */
export function grantTokenFor(grant: CaptureGrant | null, sourceId: string): string | undefined {
    return grant && grant.sourceId === sourceId ? grant.token : undefined;
}
