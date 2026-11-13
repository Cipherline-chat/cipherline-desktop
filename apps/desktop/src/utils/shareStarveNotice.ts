/**
 * Tell the sharer, in plain words, that Windows has stopped handing Cipherline new pictures of the
 * screen being shared, and what viewers see meanwhile (owner reports 566966f4, 4667c6fa: viewers
 * saw a frozen share for up to a minute and the sharer was told nothing, because the starvation
 * card only spoke when a program COVERED the screen and obs64 under QUNS_BUSY did not).
 *
 * Said only when a fullscreen-class program is in front: a still desktop gives the capturer
 * nothing new either, and telling someone looking at a static page that "capture is starved" would
 * be a false alarm. No program names (the card is local, but the log is not, and nothing here needs
 * them).
 */
import type { ForegroundDiag } from './foregroundInfo';
import { isForegroundUnavailable } from './foregroundInfo';

/** Windows notification states that mean "something is using the display fullscreen-style". */
const FULLSCREEN_STATES = new Set(['QUNS_BUSY', 'QUNS_RUNNING_D3D_FULL_SCREEN', 'QUNS_PRESENTATION_MODE']);

/**
 * A program other than Cipherline holds the display in a way that can bypass the compositor
 * (fullscreen / presentation / covering its monitor). Windows only; unknown answers are "no".
 */
export function fullscreenClassInFront(fg: ForegroundDiag | null): boolean {
    if (!fg || isForegroundUnavailable(fg) || fg.isCipherline) return false;
    return FULLSCREEN_STATES.has(fg.state) || fg.covers;
}

/** The notice for a starved capture, or null when it is not provably that (still screen, unknown, not Windows). */
export function starveNotice(fg: ForegroundDiag | null, keptAlive: boolean): string | null {
    if (!fullscreenClassInFront(fg)) return null;
    const meanwhile = keptAlive
        ? 'Cipherline keeps the stream running with your last picture until Windows starts sending again.'
        : 'Viewers keep seeing your last picture until it does.';
    return `A full-screen program is in front and Windows has stopped giving Cipherline new pictures of your screen. ${meanwhile} Sharing that program’s window instead of the whole screen can avoid this.`;
}
